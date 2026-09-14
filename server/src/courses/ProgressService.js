// classroom-app/server/src/courses/ProgressService.js
/**
 * Progress  (F3)  [NEW]
 *
 * Completion, resume position, quiz scoring and the attendance register.
 *
 * The highest-frequency write in the whole platform is here: a video lesson
 * reports its position every few seconds, per learner. That shapes two
 * decisions:
 *
 *   The position write is a single upsert with no read first, and it does not
 *   touch the enrolment or recompute course progress. Anything more would be a
 *   transaction every five seconds per viewer.
 *
 *   Completion is computed, not stored, except for the boolean. Course percent
 *   is derived on read from the lesson rows, so a lesson added to a published
 *   course does not leave every learner's stored percentage silently wrong.
 */

import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';
import * as Lessons from './models/Lesson.js';
import * as Modules from './models/Module.js';
import * as Enrollments from './models/Enrollment.js';
import * as Paths from './models/LearningPath.js';
import { resolve as resolveLocks } from './PrerequisiteResolver.js';

const log = logger.child({ component: 'progress' });

/** Default: a video counts as watched at 95%. */
const DEFAULT_COMPLETION_RATIO = 0.95;

// ---------------------------------------------------------------------------
// Lesson progress
// ---------------------------------------------------------------------------

const rowToProgress = (row) => ({
  lessonId: row.lesson_id,
  status: row.status,
  positionSec: row.position_sec ?? 0,
  scorePercent: row.score_percent,
  attempts: row.attempts ?? 0,
  completedAt: row.completed_at?.toISOString() ?? null,
  updatedAt: row.updated_at.toISOString(),
});

export const getLessonProgress = async ({ userId, lessonId }) => {
  const { rows } = await pool.query(
    `SELECT * FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2`,
    [userId, lessonId],
  );
  return rows[0] ? rowToProgress(rows[0]) : {
    lessonId, status: 'not-started', positionSec: 0, scorePercent: null, attempts: 0,
    completedAt: null, updatedAt: new Date().toISOString(),
  };
};

/**
 * The hot path. One statement, no transaction, no cascade.
 *
 * `GREATEST` on the position means an out-of-order report — which happens on a
 * flaky connection when two heartbeats arrive swapped — cannot rewind somebody
 * to an earlier point in the video.
 */
export const reportPosition = async ({ userId, lessonId, positionSec }) => {
  await pool.query(
    `INSERT INTO lesson_progress (user_id, lesson_id, status, position_sec)
     VALUES ($1, $2, 'in-progress', $3)
     ON CONFLICT (user_id, lesson_id) DO UPDATE
       SET position_sec = GREATEST(lesson_progress.position_sec, EXCLUDED.position_sec),
           status = CASE WHEN lesson_progress.status = 'completed'
                         THEN 'completed' ELSE 'in-progress' END,
           updated_at = now()`,
    [userId, lessonId, Math.max(0, Math.floor(positionSec))],
  );
};

export const updateLessonProgress = async ({ userId, lessonId, status, positionSec }) => {
  const lesson = await Lessons.findById(lessonId);
  if (!lesson) throw Object.assign(new Error('lesson not found'), { code: 'not_found' });

  // A client claiming "completed" on a video it has watched ten seconds of is
  // checked against the threshold rather than believed.
  let resolvedStatus = status;
  if (status === 'completed' && lesson.type === 'video') {
    const threshold =
      lesson.completionThresholdSec ??
      Math.floor((lesson.estimatedMinutes || 0) * 60 * DEFAULT_COMPLETION_RATIO);

    if (threshold > 0 && (positionSec ?? 0) < threshold) {
      resolvedStatus = 'in-progress';
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO lesson_progress (user_id, lesson_id, status, position_sec, completed_at)
     VALUES ($1,$2,$3,$4, CASE WHEN $3 = 'completed' THEN now() ELSE NULL END)
     ON CONFLICT (user_id, lesson_id) DO UPDATE
       SET status = EXCLUDED.status,
           position_sec = GREATEST(lesson_progress.position_sec, EXCLUDED.position_sec),
           completed_at = CASE WHEN EXCLUDED.status = 'completed'
                               THEN coalesce(lesson_progress.completed_at, now())
                               ELSE lesson_progress.completed_at END,
           updated_at = now()
     RETURNING *`,
    [userId, lessonId, resolvedStatus, Math.max(0, Math.floor(positionSec ?? 0))],
  );

  // Finishing a lesson can finish a course. Checked here rather than on read,
  // because a certificate has to be issued once, at a moment in time.
  if (resolvedStatus === 'completed') {
    await onLessonCompleted({ userId, lessonId }).catch((cause) =>
      log.error({ err: cause, userId, lessonId }, 'post-completion handling failed'),
    );
  }

  return rowToProgress(rows[0]);
};

// ---------------------------------------------------------------------------
// Course progress
// ---------------------------------------------------------------------------

export const getCourseProgress = async ({ userId, courseId, isInstructor = false }) => {
  const [modules, lessons, path, progressRows] = await Promise.all([
    Modules.listByCourse(courseId),
    Lessons.listByCourse(courseId),
    Paths.findByCourse(courseId),
    pool.query(
      `SELECT lp.* FROM lesson_progress lp
         JOIN lessons l ON l.id = lp.lesson_id
         JOIN modules m ON m.id = l.module_id
        WHERE lp.user_id = $1 AND m.course_id = $2`,
      [userId, courseId],
    ),
  ]);

  const progress = progressRows.rows.map(rowToProgress);
  const lessonsByModule = new Map();
  for (const lesson of lessons) {
    if (!lessonsByModule.has(lesson.moduleId)) lessonsByModule.set(lesson.moduleId, []);
    lessonsByModule.get(lesson.moduleId).push(lesson);
  }

  const withLessons = modules.map((module) => ({
    ...module,
    lessons: lessonsByModule.get(module.moduleId) ?? [],
  }));

  const resolved = resolveLocks({
    modules: withLessons,
    edges: path?.edges ?? [],
    progress,
    isInstructor,
  });

  // Draft lessons count for nobody: an author adding three drafts should not
  // drop every learner's percentage.
  const countable = lessons.filter((lesson) => !lesson.draft);
  const completed = progress.filter((entry) => entry.status === 'completed').length;

  return {
    courseId,
    userId,
    completedLessons: completed,
    totalLessons: countable.length,
    percent: countable.length === 0 ? 0 : Math.round((completed / countable.length) * 100),
    nextLessonId: resolved.nextLessonId,
    lastActivityAt: progress.reduce(
      (latest, entry) => (!latest || entry.updatedAt > latest ? entry.updatedAt : latest),
      null,
    ),
    lessons: progress,
    modules: resolved.modules,
  };
};

const onLessonCompleted = async ({ userId, lessonId }) => {
  const { rows } = await pool.query(
    `SELECT m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = $1`,
    [lessonId],
  );
  const courseId = rows[0]?.course_id;
  if (!courseId) return;

  await Enrollments.markStarted({ courseId, userId });

  const progress = await getCourseProgress({ userId, courseId });
  if (progress.percent < 100) return;

  const completion = await Enrollments.markCompleted({ courseId, userId });
  // markCompleted only returns a row on the transition, so a certificate is
  // issued exactly once however many times the last lesson is re-opened.
  if (!completion) return;

  log.info({ userId, courseId }, 'course completed');

  const { issueCertificate } = await import('./CertificateService.js');
  await issueCertificate({ userId, courseId }).catch((cause) =>
    log.error({ err: cause, userId, courseId }, 'certificate could not be issued'),
  );
};

// ---------------------------------------------------------------------------
// Quizzes
// ---------------------------------------------------------------------------

/**
 * Scored on the server, always. The correct answers never leave this process
 * for a learner-facing request — see Lesson.forLearner.
 */
export const submitQuiz = async ({ userId, lessonId, answers }) => {
  const lesson = await Lessons.findById(lessonId);
  if (!lesson || lesson.type !== 'quiz') {
    throw Object.assign(new Error('not a quiz'), { code: 'not_found' });
  }

  const existing = await getLessonProgress({ userId, lessonId });
  if (lesson.maxAttempts && existing.attempts >= lesson.maxAttempts) {
    throw Object.assign(new Error('no attempts left'), { code: 'conflict' });
  }

  const submitted = new Map(answers.map((answer) => [answer.questionId, answer.optionIds ?? []]));
  let earned = 0;
  let possible = 0;
  const feedback = [];

  for (const question of lesson.questions) {
    possible += question.points ?? 1;
    const chosen = new Set(submitted.get(question.questionId) ?? []);
    const correct = new Set(question.correctOptionIds ?? []);

    // Exact set match: partial credit on a multiple-select question rewards
    // ticking everything.
    const isCorrect =
      chosen.size === correct.size && [...correct].every((option) => chosen.has(option));

    if (isCorrect) earned += question.points ?? 1;
    feedback.push({ questionId: question.questionId, correct: isCorrect, explanation: question.explanation ?? null });
  }

  const scorePercent = possible === 0 ? 0 : Math.round((earned / possible) * 100);
  const passed = scorePercent >= (lesson.passPercent ?? 70);
  const attempt = existing.attempts + 1;

  await pool.query(
    `INSERT INTO lesson_progress (user_id, lesson_id, status, score_percent, attempts, completed_at)
     VALUES ($1,$2,$3,$4,1, CASE WHEN $5 THEN now() ELSE NULL END)
     ON CONFLICT (user_id, lesson_id) DO UPDATE
       SET attempts = lesson_progress.attempts + 1,
           -- the best attempt stands, not the most recent
           score_percent = GREATEST(coalesce(lesson_progress.score_percent, 0), EXCLUDED.score_percent),
           status = CASE WHEN $5 THEN 'completed' ELSE 'in-progress' END,
           completed_at = CASE WHEN $5 THEN coalesce(lesson_progress.completed_at, now())
                               ELSE lesson_progress.completed_at END,
           updated_at = now()`,
    [userId, lessonId, passed ? 'completed' : 'in-progress', scorePercent, passed],
  );

  if (passed) await onLessonCompleted({ userId, lessonId });

  const attemptsLeft = lesson.maxAttempts ? lesson.maxAttempts - attempt : null;

  return {
    scorePercent,
    passed,
    attempt,
    // Withheld while retries remain, or the second attempt is a copy of the
    // feedback from the first.
    feedback: passed || attemptsLeft === 0 ? feedback : [],
  };
};

// ---------------------------------------------------------------------------
// Attendance  (called by classroom/AttendanceService.js)
// ---------------------------------------------------------------------------

/**
 * Files the register for a live session. Attending is not the same as
 * completing: presence is recorded here, and the lesson is marked complete only
 * for people who were actually there for a meaningful part of it.
 */
export const saveAttendance = async ({ roomId, lessonId, endedAt, attendees }) => {
  if (!lessonId) {
    log.debug({ roomId }, 'attendance for a room with no lesson; not persisted');
    return { saved: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const attendee of attendees) {
      await client.query(
        `INSERT INTO lesson_attendance
           (lesson_id, room_id, user_id, duration_sec, reconnects, participated,
            first_joined_at, last_left_at, interactions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (lesson_id, user_id, room_id) DO UPDATE
           SET duration_sec = lesson_attendance.duration_sec + EXCLUDED.duration_sec,
               reconnects = EXCLUDED.reconnects,
               participated = lesson_attendance.participated OR EXCLUDED.participated,
               last_left_at = EXCLUDED.last_left_at,
               interactions = EXCLUDED.interactions`,
        [lessonId, roomId, attendee.userId, attendee.durationSec, attendee.reconnects,
         attendee.participated, attendee.firstJoinedAt, attendee.lastLeftAt,
         JSON.stringify(attendee.interactions)],
      );
    }

    await client.query('COMMIT');
  } catch (cause) {
    await client.query('ROLLBACK');
    throw cause;
  } finally {
    client.release();
  }

  // Half the scheduled length, or five minutes for an unscheduled session.
  const lesson = await Lessons.findById(lessonId);
  const required = lesson?.estimatedMinutes ? (lesson.estimatedMinutes * 60) / 2 : 300;

  for (const attendee of attendees) {
    if (attendee.durationSec < required) continue;
    await updateLessonProgress({
      userId: attendee.userId,
      lessonId,
      status: 'completed',
      positionSec: attendee.durationSec,
    }).catch(() => undefined);
  }

  log.info({ lessonId, roomId, attendees: attendees.length }, 'attendance saved');
  return { saved: attendees.length };
};

export const attendanceFor = async (lessonId) => {
  const { rows } = await pool.query(
    `SELECT a.*, u.display_name
       FROM lesson_attendance a JOIN users u ON u.id = a.user_id
      WHERE a.lesson_id = $1 ORDER BY a.duration_sec DESC`,
    [lessonId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    durationSec: row.duration_sec,
    reconnects: row.reconnects,
    participated: row.participated,
    interactions: row.interactions,
    firstJoinedAt: row.first_joined_at?.toISOString() ?? null,
    lastLeftAt: row.last_left_at?.toISOString() ?? null,
  }));
};

export default { getCourseProgress, updateLessonProgress, reportPosition, submitQuiz, saveAttendance };