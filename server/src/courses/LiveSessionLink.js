// classroom-app/server/src/courses/LiveSessionLink.js
/**
 * Live lesson → classroom room  (F1, F3)  [NEW]
 *
 * The seam between the curriculum and the SFU. A live lesson is a row in a
 * course; a room is a mediasoup router on a node. This file is what turns one
 * into the other, and it is the only place that knows both exist.
 *
 * Three rules shape it:
 *
 *   A room is created on first entry, not on schedule. Provisioning a router at
 *   09:00 for a lesson nobody attends wastes a node slot; creating it when the
 *   first person knocks costs about a millisecond.
 *
 *   The room id is derived from the lesson id, not random. Two people opening
 *   the lesson at the same moment must land in the same room, and a derived id
 *   makes that true without a lock. `RoomRegistry` then pins that id to one
 *   node — see the SET NX in resolveNode.
 *
 *   A join window, not a hard start. People arrive early and lessons overrun,
 *   so the door opens before the scheduled time and stays open after it.
 */

import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';
import * as Lessons from './models/Lesson.js';
import * as Enrollments from './models/Enrollment.js';
import * as Courses from './models/Course.js';
import { canOpenLesson } from './PrerequisiteResolver.js';

const log = logger.child({ component: 'live-session' });

/** Early arrivals, and overrun. Both generous on purpose. */
const OPEN_BEFORE_MIN = 15;
const CLOSE_AFTER_MIN = 60;

/** Stable and derived, so concurrent joins agree without coordinating. */
export const roomIdForLesson = (lessonId) => `lesson-${lessonId}`;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * @returns {{ open: boolean, state: 'early'|'open'|'ended'|'always', opensAt: string|null, closesAt: string|null }}
 */
export const joinWindow = (lesson, now = new Date()) => {
  // A recurring room — office hours, a study room — has no schedule at all.
  if (lesson.recurring || !lesson.scheduledStart) {
    return { open: true, state: 'always', opensAt: null, closesAt: null };
  }

  const start = new Date(lesson.scheduledStart);
  const end = lesson.scheduledEnd ? new Date(lesson.scheduledEnd) : new Date(start.getTime() + 3_600_000);

  const opensAt = new Date(start.getTime() - OPEN_BEFORE_MIN * 60_000);
  const closesAt = new Date(end.getTime() + CLOSE_AFTER_MIN * 60_000);

  if (now < opensAt) {
    return { open: false, state: 'early', opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString() };
  }
  if (now > closesAt) {
    return { open: false, state: 'ended', opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString() };
  }
  return { open: true, state: 'open', opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString() };
};

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Everything that has to be true before someone joins a live lesson, answered
 * in one call: enrolment, prerequisites, the join window and the host check.
 *
 * The route then resolves a node and hands the client a room id. This function
 * deliberately does not create the room — that happens on the SFU node, which
 * is the only process that can.
 *
 * @returns {{ allowed: boolean, roomId?: string, role?: string, code?: string, reason?: string }}
 */
export const authoriseJoin = async ({ lessonId, userId, now = new Date() }) => {
  const lesson = await Lessons.findById(lessonId);
  if (!lesson || lesson.type !== 'live') {
    return { allowed: false, code: 'not_found', reason: 'This is not a live lesson.' };
  }

  const { rows } = await (await import('../db/pool.js')).pool.query(
    `SELECT m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = $1`,
    [lessonId],
  );
  const courseId = rows[0]?.course_id;
  const course = courseId ? await Courses.findById(courseId) : null;
  if (!course) return { allowed: false, code: 'not_found' };

  const isInstructor =
    course.owner.userId === userId ||
    course.instructors.some((instructor) => instructor.userId === userId);

  // A teacher opening their own lesson bypasses enrolment and prerequisites —
  // they are not a learner on their own course.
  if (!isInstructor) {
    if (!(await Enrollments.isEnrolled({ courseId, userId }))) {
      return { allowed: false, code: 'forbidden', reason: 'You are not enrolled in this course.' };
    }

    const { getCourseProgress } = await import('./ProgressService.js');
    const [progress, { getCourseDetail }] = await Promise.all([
      getCourseProgress({ userId, courseId }),
      import('./CourseService.js'),
    ]);
    const detail = await getCourseDetail({ courseId, userId });

    const gate = canOpenLesson({
      lessonId,
      modules: detail.modules,
      edges: detail.path?.edges ?? [],
      progress: progress.lessons,
    });

    if (!gate.allowed) {
      return { allowed: false, code: gate.code, reason: gate.reason };
    }
  }

  const window = joinWindow(lesson, now);

  // The host may open the room before the window: somebody has to be able to
  // set up before people arrive.
  if (!window.open && !isInstructor) {
    return {
      allowed: false,
      code: window.state === 'early' ? 'room_closed' : 'room_closed',
      reason:
        window.state === 'early'
          ? `This lesson opens at ${new Date(window.opensAt).toLocaleTimeString()}.`
          : 'This lesson has ended.',
      window,
    };
  }

  return {
    allowed: true,
    roomId: roomIdForLesson(lessonId),
    lessonId,
    courseId,
    // The course owner hosts; a listed instructor cohosts; everyone else learns.
    role: course.owner.userId === userId ? 'host' : isInstructor ? 'cohost' : 'learner',
    mode: lesson.recurring ? 'office-hours' : 'lecture',
    window,
  };
};

// ---------------------------------------------------------------------------
// Room lifecycle callbacks
// ---------------------------------------------------------------------------

/**
 * The SFU created the room. Recorded against the lesson so the course page can
 * show "in progress" without asking every node.
 */
export const onRoomOpened = async ({ lessonId, roomId }) => {
  await Lessons.setRoom(lessonId, roomId);
  log.info({ lessonId, roomId }, 'live session opened');

  void import('../community/NotificationService.js')
    .then(({ notifyLessonStarted }) => notifyLessonStarted({ lessonId }))
    .catch(() => undefined);
};

/** The room ended. The link is cleared; attendance is filed separately. */
export const onRoomClosed = async ({ lessonId }) => {
  await Lessons.setRoom(lessonId, null);
  log.info({ lessonId }, 'live session closed');
};

/**
 * A recording finished processing. Attaching it to the lesson is what turns a
 * live session into something a learner who missed it can watch — which is the
 * whole point of recording it.
 */
export const attachRecording = async ({ lessonId, assetId }) => {
  await Lessons.setRecording(lessonId, assetId);
  log.info({ lessonId, assetId }, 'recording attached to lesson');

  void import('../community/NotificationService.js')
    .then(({ notifyRecordingReady }) => notifyRecordingReady({ lessonId, assetId }))
    .catch(() => undefined);
};

// ---------------------------------------------------------------------------
// Scheduling views
// ---------------------------------------------------------------------------

/** Upcoming live lessons for one learner, for the dashboard and reminders. */
export const upcomingForUser = async ({ userId, withinHours = 48 }) => {
  const { pool } = await import('../db/pool.js');
  const { rows } = await pool.query(
    `SELECT l.id, l.title, l.scheduled_start, l.scheduled_end, l.room_id,
            c.id AS course_id, c.title AS course_title, c.slug
       FROM lessons l
       JOIN modules m ON m.id = l.module_id
       JOIN courses c ON c.id = m.course_id
       JOIN enrollments e ON e.course_id = c.id AND e.user_id = $1 AND e.status = 'active'
      WHERE l.type = 'live'
        AND l.deleted_at IS NULL
        AND l.draft = false
        AND l.scheduled_start IS NOT NULL
        AND l.scheduled_start BETWEEN now() - interval '1 hour'
                                  AND now() + ($2 || ' hours')::interval
      ORDER BY l.scheduled_start ASC`,
    [userId, String(withinHours)],
  );

  return rows.map((row) => ({
    lessonId: row.id,
    title: row.title,
    courseId: row.course_id,
    courseTitle: row.course_title,
    courseSlug: row.slug,
    scheduledStart: row.scheduled_start.toISOString(),
    scheduledEnd: row.scheduled_end?.toISOString() ?? null,
    live: Boolean(row.room_id),
    roomId: row.room_id,
  }));
};

/** Everything starting inside the window; drives the reminder job. */
export const startingSoon = async ({ minutes = 10 }) => {
  const { pool } = await import('../db/pool.js');
  const { rows } = await pool.query(
    `SELECT l.id AS lesson_id, m.course_id
       FROM lessons l JOIN modules m ON m.id = l.module_id
      WHERE l.type = 'live' AND l.deleted_at IS NULL AND l.draft = false
        AND l.scheduled_start BETWEEN now() AND now() + ($1 || ' minutes')::interval`,
    [String(minutes)],
  );
  return rows.map((row) => ({ lessonId: row.lesson_id, courseId: row.course_id }));
};

export default { authoriseJoin, joinWindow, roomIdForLesson, onRoomOpened, onRoomClosed, attachRecording };