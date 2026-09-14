// classroom-app/server/src/assignments/GradingService.js
/**
 * Grading  (F4)  [NEW]
 *
 * Scoring, feedback, release and the gradebook.
 *
 * Release is separate from grading on purpose. A teacher marking thirty
 * submissions over three evenings does not want the first learner comparing
 * their grade with the twenty-ninth before the rest exist — so with
 * `releaseGradesManually` the marks sit unreleased until they are published in
 * one go. Without it they release as they are written, which is right for a
 * weekly exercise.
 *
 * The late penalty is applied here, not at submission. Both numbers are kept:
 * `rawPoints` is what the work earned and `points` is what it is worth after
 * the deduction. A learner appealing a penalty needs to see both, and a teacher
 * reversing one should not have to re-mark anything.
 */

import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';
import * as Assignments from './AssignmentService.js';
import * as Submissions from './SubmissionService.js';

const log = logger.child({ component: 'grading' });

// ---------------------------------------------------------------------------
// Scoring  (pure)
// ---------------------------------------------------------------------------

/**
 * Turns a mark into the numbers that get stored.
 *
 * Rounding is to two decimals on the points and whole numbers on the
 * percentage — a mark of 66.6667% displayed three different ways in three
 * different screens is a support ticket.
 *
 * @returns {{ rawPoints: number, points: number, percent: number, passed: boolean, penaltyApplied: number }}
 */
export const computeScore = ({
  rubric = null,
  criteria = [],
  points,
  maxPoints,
  passPercent = 50,
  late = false,
  latePenaltyPercent = 0,
}) => {
  let rawPoints;

  if (rubric) {
    const byId = new Map(rubric.criteria.map((criterion) => [criterion.criterionId, criterion]));

    rawPoints = criteria.reduce((total, score) => {
      const criterion = byId.get(score.criterionId);
      if (!criterion) return total;
      // A score above the criterion's maximum is clamped rather than rejected:
      // a slip of the keyboard should not lose the whole mark.
      return total + Math.min(Math.max(score.points, 0), criterion.maxPoints);
    }, 0);
  } else {
    rawPoints = Math.min(Math.max(points ?? 0, 0), maxPoints);
  }

  const penalty = late ? latePenaltyPercent : 0;
  const afterPenalty = rawPoints * (1 - penalty / 100);

  const round = (value) => Math.round(value * 100) / 100;
  const percent = maxPoints === 0 ? 0 : Math.round((afterPenalty / maxPoints) * 100);

  return {
    rawPoints: round(rawPoints),
    points: round(afterPenalty),
    percent,
    passed: percent >= passPercent,
    penaltyApplied: penalty,
  };
};

/**
 * Every criterion has to be scored before a rubric grade can be saved. A
 * partially filled rubric produces a mark that looks complete and is not.
 */
export const validateRubricScores = ({ rubric, criteria }) => {
  if (!rubric) return { valid: true, errors: [] };

  const errors = [];
  const scored = new Set(criteria.map((score) => score.criterionId));

  for (const criterion of rubric.criteria) {
    if (!scored.has(criterion.criterionId)) {
      errors.push({ path: criterion.criterionId, message: `“${criterion.title}” has not been scored.` });
    }
  }

  for (const score of criteria) {
    const criterion = rubric.criteria.find((entry) => entry.criterionId === score.criterionId);
    if (!criterion) {
      errors.push({ path: score.criterionId, message: 'This criterion is not part of the rubric.' });
    } else if (score.points > criterion.maxPoints) {
      errors.push({
        path: score.criterionId,
        message: `“${criterion.title}” is out of ${criterion.maxPoints}.`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
};

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

const rowToGrade = (row) => ({
  submissionId: row.submission_id,
  grader: { userId: row.grader_id, displayName: row.grader_name ?? '', avatarUrl: null },
  points: Number(row.points),
  rawPoints: Number(row.raw_points),
  maxPoints: Number(row.max_points),
  percent: Number(row.percent),
  passed: row.passed,
  criteria: row.criteria ?? [],
  feedback: row.feedback,
  feedbackAssetIds: row.feedback_asset_ids ?? [],
  releasedAt: row.released_at?.toISOString() ?? null,
  gradedAt: row.graded_at.toISOString(),
});

export const grade = async ({
  submissionId,
  graderId,
  points,
  criteria = [],
  feedback = null,
  feedbackAssetIds = [],
  requestResubmit = false,
  release = true,
}) => {
  const submission = await Submissions.findById(submissionId);
  if (!submission) throw Object.assign(new Error('submission not found'), { code: 'not_found' });

  if (submission.status === 'draft') {
    throw Object.assign(new Error('this has not been submitted yet'), { code: 'conflict' });
  }

  const assignment = await Assignments.findById(submission.assignmentId);

  const check = validateRubricScores({ rubric: assignment.rubric, criteria });
  if (!check.valid) {
    throw Object.assign(new Error(check.errors[0].message), {
      code: 'validation_failed',
      errors: check.errors,
    });
  }

  const score = computeScore({
    rubric: assignment.rubric,
    criteria,
    points,
    maxPoints: assignment.maxPoints,
    passPercent: assignment.passPercent,
    late: submission.late,
    latePenaltyPercent: assignment.latePenaltyPercent,
  });

  // The assignment's own setting wins over whatever the caller asked for:
  // a teacher who set up batch release should not be able to leak one grade
  // early by unticking a box.
  const shouldRelease = assignment.releaseGradesManually ? false : release;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO grades (submission_id, grader_id, points, raw_points, max_points, percent,
                           passed, criteria, feedback, feedback_asset_ids, released_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10, CASE WHEN $11 THEN now() ELSE NULL END)
       ON CONFLICT (submission_id) DO UPDATE
         SET grader_id = EXCLUDED.grader_id, points = EXCLUDED.points,
             raw_points = EXCLUDED.raw_points, percent = EXCLUDED.percent,
             passed = EXCLUDED.passed, criteria = EXCLUDED.criteria,
             feedback = EXCLUDED.feedback, feedback_asset_ids = EXCLUDED.feedback_asset_ids,
             released_at = CASE WHEN $11 THEN coalesce(grades.released_at, now())
                                ELSE grades.released_at END,
             graded_at = now()
       RETURNING *`,
      [
        submissionId, graderId, score.points, score.rawPoints, assignment.maxPoints,
        score.percent, score.passed, JSON.stringify(criteria), feedback,
        feedbackAssetIds, shouldRelease,
      ],
    );

    await client.query(
      `UPDATE submissions SET status = $2, updated_at = now() WHERE id = $1`,
      [submissionId, requestResubmit ? 'resubmit' : shouldRelease ? 'returned' : 'submitted'],
    );

    await client.query('COMMIT');

    log.info(
      { submissionId, graderId, percent: score.percent, released: shouldRelease },
      'submission graded',
    );

    if (requestResubmit) {
      await Submissions.openNextAttempt({
        assignmentId: submission.assignmentId,
        userId: submission.learner.userId,
      }).catch(() => undefined);
    }

    if (shouldRelease) {
      await notifyLearner({ assignment, submission, score, requestResubmit }).catch(() => undefined);
    }

    return rowToGrade(rows[0]);
  } catch (cause) {
    await client.query('ROLLBACK');
    throw cause;
  } finally {
    client.release();
  }
};

/**
 * Publishes held grades. Empty `submissionIds` means everything graded for the
 * assignment — which is how a teacher who has finished marking releases the
 * whole batch at once.
 */
export const release = async ({ assignmentId, submissionIds = [], actorId }) => {
  const { rows } = await pool.query(
    `UPDATE grades g
        SET released_at = now()
       FROM submissions s
      WHERE g.submission_id = s.id
        AND s.assignment_id = $1
        AND g.released_at IS NULL
        AND (cardinality($2::uuid[]) = 0 OR g.submission_id = ANY($2::uuid[]))
      RETURNING g.submission_id, s.user_id`,
    [assignmentId, submissionIds],
  );

  if (rows.length === 0) return { released: 0 };

  await pool.query(
    `UPDATE submissions SET status = 'returned', updated_at = now() WHERE id = ANY($1::uuid[])`,
    [rows.map((row) => row.submission_id)],
  );

  const assignment = await Assignments.findById(assignmentId);
  const { rows: course } = await pool.query(`SELECT slug FROM courses WHERE id = $1`, [assignment.courseId]);

  const { notifyMany } = await import('../community/NotificationService.js');
  await notifyMany({
    userIds: rows.map((row) => row.user_id),
    type: 'assignment.graded',
    title: `${assignment.title} has been marked`,
    href: `/courses/${course[0]?.slug}/assignments/${assignmentId}`,
    actorId,
    data: { assignmentId },
  }).catch(() => undefined);

  log.info({ assignmentId, released: rows.length, actorId }, 'grades released');
  return { released: rows.length };
};

/** Attaches a grade to a submission, but only once it has been released. */
export const gradeFor = async ({ submissionId, viewerIsTeacher = false }) => {
  const { rows } = await pool.query(
    `SELECT g.*, u.display_name AS grader_name
       FROM grades g JOIN users u ON u.id = g.grader_id
      WHERE g.submission_id = $1`,
    [submissionId],
  );

  if (!rows[0]) return null;
  // An unreleased grade exists but is nobody's business yet except the
  // teacher's.
  if (!rows[0].released_at && !viewerIsTeacher) return null;

  return rowToGrade(rows[0]);
};

// ---------------------------------------------------------------------------
// Gradebook
// ---------------------------------------------------------------------------

/**
 * Assembles the matrix from flat rows. Pure, so the shape can be tested without
 * a database and reused for a CSV export.
 */
export const buildGradebook = ({ courseId, assignments, learners, entries }) => {
  const byLearner = new Map(learners.map((learner) => [learner.userId, new Map()]));

  for (const entry of entries) {
    byLearner.get(entry.userId)?.set(entry.assignmentId, entry);
  }

  const rows = learners.map((learner) => {
    const own = byLearner.get(learner.userId) ?? new Map();

    const cells = assignments.map((assignment) => {
      const entry = own.get(assignment.assignmentId);
      return {
        learner,
        assignmentId: assignment.assignmentId,
        status: entry?.status ?? null,
        submissionId: entry?.submissionId ?? null,
        attempt: entry?.attempt ?? 0,
        percent: entry?.percent ?? null,
        late: entry?.late ?? false,
        submittedAt: entry?.submittedAt ?? null,
        gradedAt: entry?.gradedAt ?? null,
      };
    });

    // The average counts marked work only. Counting unmarked assignments as
    // zero would show every learner failing until the teacher catches up.
    const marked = cells.filter((cell) => cell.percent !== null);
    const averagePercent =
      marked.length === 0
        ? null
        : Math.round(marked.reduce((total, cell) => total + cell.percent, 0) / marked.length);

    return { learner, entries: cells, averagePercent };
  });

  return {
    courseId,
    assignments: assignments.map((assignment) => ({
      assignmentId: assignment.assignmentId,
      title: assignment.title,
      maxPoints: assignment.maxPoints,
      dueAt: assignment.dueAt,
    })),
    rows,
  };
};

export const getGradebook = async ({ courseId }) => {
  const [assignments, learners, entries] = await Promise.all([
    Assignments.listByCourse({ courseId, publishedOnly: true }),
    pool
      .query(
        `SELECT u.id AS user_id, u.display_name, u.avatar_url
           FROM enrollments e JOIN users u ON u.id = e.user_id
          WHERE e.course_id = $1 AND e.status IN ('active','completed')
          ORDER BY u.display_name`,
        [courseId],
      )
      .then(({ rows }) =>
        rows.map((row) => ({
          userId: row.user_id,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
        })),
      ),
    pool
      .query(
        `SELECT s.user_id, s.assignment_id, s.id AS submission_id, s.status, s.attempt,
                s.late, s.submitted_at, g.percent, g.graded_at, g.released_at
           FROM submissions s
           JOIN assignments a ON a.id = s.assignment_id
           LEFT JOIN grades g ON g.submission_id = s.id
          WHERE a.course_id = $1
            AND s.attempt = (SELECT max(attempt) FROM submissions x
                              WHERE x.assignment_id = s.assignment_id AND x.user_id = s.user_id)`,
        [courseId],
      )
      .then(({ rows }) =>
        rows.map((row) => ({
          userId: row.user_id,
          assignmentId: row.assignment_id,
          submissionId: row.submission_id,
          status: row.status,
          attempt: row.attempt,
          late: row.late,
          submittedAt: row.submitted_at?.toISOString() ?? null,
          // An unreleased mark is invisible in the gradebook too, so a teacher
          // sharing their screen cannot leak one by accident.
          percent: row.released_at ? Number(row.percent) : null,
          gradedAt: row.graded_at?.toISOString() ?? null,
        })),
      ),
  ]);

  return buildGradebook({ courseId, assignments, learners, entries });
};

/** CSV for the people who will do this in a spreadsheet regardless. */
export const exportGradebookCsv = async ({ courseId }) => {
  const book = await getGradebook({ courseId });

  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  const header = ['Learner', ...book.assignments.map((a) => a.title), 'Average'];
  const lines = [header.map(escape).join(',')];

  for (const row of book.rows) {
    lines.push(
      [
        row.learner.displayName,
        ...row.entries.map((cell) => (cell.percent === null ? '' : `${cell.percent}%`)),
        row.averagePercent === null ? '' : `${row.averagePercent}%`,
      ]
        .map(escape)
        .join(','),
    );
  }

  return lines.join('\n');
};

const notifyLearner = async ({ assignment, submission, score, requestResubmit }) => {
  const { rows } = await pool.query(`SELECT slug FROM courses WHERE id = $1`, [assignment.courseId]);
  const { notify } = await import('../community/NotificationService.js');

  await notify({
    userId: submission.learner.userId,
    type: 'assignment.graded',
    title: requestResubmit
      ? `${assignment.title} needs another look`
      : `${assignment.title} has been marked`,
    // The mark itself is deliberately not in the body: this arrives as a push
    // notification on a lock screen other people can read.
    body: null,
    href: `/courses/${rows[0]?.slug}/assignments/${assignment.assignmentId}`,
    data: { assignmentId: assignment.assignmentId, passed: score.passed },
  });
};

export default { grade, release, gradeFor, getGradebook, exportGradebookCsv, computeScore, buildGradebook };