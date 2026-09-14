// classroom-app/server/src/assignments/AssignmentService.js
/**
 * Assignments  (F4)  [NEW]
 *
 * Create, edit, publish. The rubric lives here; submissions and grading are
 * separate files because they have different readers — a learner never touches
 * this one, and a teacher building an assignment never touches the other two.
 *
 * Two rules worth stating up front, because both are enforced here and assumed
 * everywhere else:
 *
 *   A rubric's criteria must sum to its total. A rubric that does not add up
 *   produces grades that cannot be compared, and the error surfaces weeks later
 *   as "why is this out of 47".
 *
 *   An assignment with submissions cannot have its marking scheme changed.
 *   Re-weighting a rubric after ten people have been graded silently changes
 *   their marks, and nobody is told. Adding a criterion is blocked; fixing a
 *   typo in a description is not.
 */

import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'assignments' });

// ---------------------------------------------------------------------------
// Rubric rules  (pure)
// ---------------------------------------------------------------------------

/**
 * @returns {{ valid: boolean, errors: {path: string, message: string}[], totalPoints: number }}
 */
export const validateRubric = (rubric) => {
  const errors = [];

  if (!rubric) return { valid: true, errors, totalPoints: 0 };

  if (!Array.isArray(rubric.criteria) || rubric.criteria.length === 0) {
    errors.push({ path: 'rubric.criteria', message: 'A rubric needs at least one criterion.' });
    return { valid: false, errors, totalPoints: 0 };
  }

  const sum = rubric.criteria.reduce((total, criterion) => total + (criterion.maxPoints ?? 0), 0);

  for (const [index, criterion] of rubric.criteria.entries()) {
    if (!criterion.title?.trim()) {
      errors.push({ path: `rubric.criteria.${index}.title`, message: 'Every criterion needs a name.' });
    }
    if (!(criterion.maxPoints > 0)) {
      errors.push({
        path: `rubric.criteria.${index}.maxPoints`,
        message: 'A criterion worth nothing cannot be scored.',
      });
    }

    // Bands are optional, but a band worth more than the criterion is a typo
    // that produces impossible scores.
    for (const [bandIndex, level] of (criterion.levels ?? []).entries()) {
      if (level.points > criterion.maxPoints) {
        errors.push({
          path: `rubric.criteria.${index}.levels.${bandIndex}`,
          message: `“${level.label}” is worth more than the criterion it belongs to.`,
        });
      }
    }
  }

  if (rubric.totalPoints !== undefined && Math.abs(sum - rubric.totalPoints) > 0.001) {
    errors.push({
      path: 'rubric.totalPoints',
      message: `The criteria add up to ${sum}, not ${rubric.totalPoints}.`,
    });
  }

  return { valid: errors.length === 0, errors, totalPoints: sum };
};

/** Criteria are given ids on the way in, so a grade can reference one stably. */
const normaliseRubric = (rubric) => {
  if (!rubric) return null;
  const criteria = rubric.criteria.map((criterion) => ({
    criterionId: criterion.criterionId ?? randomUUID(),
    title: criterion.title,
    description: criterion.description ?? null,
    maxPoints: criterion.maxPoints,
    levels: criterion.levels ?? [],
  }));
  return { criteria, totalPoints: criteria.reduce((total, c) => total + c.maxPoints, 0) };
};

/**
 * Which edits are safe once work has been submitted. Anything affecting how a
 * mark is produced is frozen; everything cosmetic stays open.
 */
const SCHEME_FIELDS = ['rubric', 'maxPoints', 'passPercent', 'latePolicy', 'latePenaltyPercent'];

export const assertEditable = (patch, submissionCount) => {
  if (submissionCount === 0) return;

  const frozen = SCHEME_FIELDS.filter((field) => patch[field] !== undefined);
  if (frozen.length > 0) {
    throw Object.assign(
      new Error(
        `${submissionCount} learners have already submitted; ${frozen.join(', ')} can no longer be changed.`,
      ),
      { code: 'conflict', fields: frozen },
    );
  }
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const rowToAssignment = (row) => ({
  assignmentId: row.id,
  courseId: row.course_id,
  lessonId: row.lesson_id,
  title: row.title,
  instructions: row.instructions ?? '',
  briefAssetIds: row.brief_asset_ids ?? [],
  submissionKind: row.submission_kind,
  maxAttempts: row.max_attempts,
  maxFiles: row.max_files,
  allowedExtensions: row.allowed_extensions ?? [],
  dueAt: row.due_at?.toISOString() ?? null,
  latePolicy: row.late_policy,
  latePenaltyPercent: Number(row.late_penalty_percent ?? 0),
  rubric: row.rubric,
  maxPoints: Number(row.max_points ?? 100),
  passPercent: Number(row.pass_percent ?? 50),
  peerVisible: row.peer_visible,
  releaseGradesManually: row.release_grades_manually,
  published: row.published,
  submissionCount: Number(row.submission_count ?? 0),
  gradedCount: Number(row.graded_count ?? 0),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const SELECT = `
  SELECT a.*,
         counts.submission_count,
         counts.graded_count
    FROM assignments a
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE s.status <> 'draft')                      AS submission_count,
             count(*) FILTER (WHERE s.status = 'returned')                     AS graded_count
        FROM submissions s WHERE s.assignment_id = a.id
    ) counts ON true
`;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const findById = async (assignmentId, client = pool) => {
  const { rows } = await client.query(`${SELECT} WHERE a.id = $1 AND a.deleted_at IS NULL`, [assignmentId]);
  return rows[0] ? rowToAssignment(rows[0]) : null;
};

export const findByLesson = async (lessonId, client = pool) => {
  const { rows } = await client.query(`${SELECT} WHERE a.lesson_id = $1 AND a.deleted_at IS NULL`, [lessonId]);
  return rows[0] ? rowToAssignment(rows[0]) : null;
};

export const listByCourse = async ({ courseId, publishedOnly = false }, client = pool) => {
  const { rows } = await client.query(
    `${SELECT} WHERE a.course_id = $1 AND a.deleted_at IS NULL
       ${publishedOnly ? 'AND a.published = true' : ''}
       ORDER BY a.due_at ASC NULLS LAST, a.created_at ASC`,
    [courseId],
  );
  return rows.map(rowToAssignment);
};

/**
 * The learner-facing view. The rubric is included — someone should know how
 * they are being marked before they do the work, not after — but nothing about
 * other people's submissions is.
 */
export const forLearner = (assignment, submission = null) => ({
  ...assignment,
  submissionCount: undefined,
  gradedCount: undefined,
  submission,
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export const create = async ({ courseId, lessonId = null, actorId, ...input }) => {
  const check = validateRubric(input.rubric);
  if (!check.valid) {
    throw Object.assign(new Error(check.errors[0].message), {
      code: 'validation_failed',
      errors: check.errors,
    });
  }

  const rubric = normaliseRubric(input.rubric);
  // With a rubric, its total *is* the mark. Two sources of truth for "out of
  // what" is how a gradebook ends up with two different percentages.
  const maxPoints = rubric ? rubric.totalPoints : (input.maxPoints ?? 100);

  const { rows } = await pool.query(
    `INSERT INTO assignments
       (course_id, lesson_id, title, instructions, brief_asset_ids, submission_kind,
        max_attempts, max_files, allowed_extensions, due_at, late_policy,
        late_penalty_percent, rubric, max_points, pass_percent, peer_visible,
        release_grades_manually, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18)
     RETURNING id`,
    [
      courseId, lessonId, input.title, input.instructions ?? '', input.briefAssetIds ?? [],
      input.submissionKind ?? 'any', input.maxAttempts ?? 1, input.maxFiles ?? 5,
      input.allowedExtensions ?? [], input.dueAt ?? null, input.latePolicy ?? 'accepted',
      input.latePenaltyPercent ?? 0, rubric ? JSON.stringify(rubric) : null,
      maxPoints, input.passPercent ?? 50, input.peerVisible ?? false,
      input.releaseGradesManually ?? false, actorId,
    ],
  );

  // A task lesson points at its assignment; without the link the lesson has
  // nothing to open.
  if (lessonId) {
    await pool.query(`UPDATE lessons SET assignment_id = $2, updated_at = now() WHERE id = $1`, [
      lessonId,
      rows[0].id,
    ]);
  }

  log.info({ assignmentId: rows[0].id, courseId, lessonId }, 'assignment created');
  return findById(rows[0].id);
};

export const update = async ({ assignmentId, patch }) => {
  const existing = await findById(assignmentId);
  if (!existing) throw Object.assign(new Error('assignment not found'), { code: 'not_found' });

  assertEditable(patch, existing.submissionCount);

  if (patch.rubric !== undefined) {
    const check = validateRubric(patch.rubric);
    if (!check.valid) {
      throw Object.assign(new Error(check.errors[0].message), {
        code: 'validation_failed',
        errors: check.errors,
      });
    }
  }

  const columns = {
    title: 'title', instructions: 'instructions', briefAssetIds: 'brief_asset_ids',
    submissionKind: 'submission_kind', maxAttempts: 'max_attempts', maxFiles: 'max_files',
    allowedExtensions: 'allowed_extensions', dueAt: 'due_at', latePolicy: 'late_policy',
    latePenaltyPercent: 'late_penalty_percent', passPercent: 'pass_percent',
    peerVisible: 'peer_visible', releaseGradesManually: 'release_grades_manually',
    published: 'published', maxPoints: 'max_points',
  };

  const sets = [];
  const params = [];

  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }

  if (patch.rubric !== undefined) {
    const rubric = normaliseRubric(patch.rubric);
    params.push(rubric ? JSON.stringify(rubric) : null);
    sets.push(`rubric = $${params.length}::jsonb`);
    if (rubric) {
      params.push(rubric.totalPoints);
      sets.push(`max_points = $${params.length}`);
    }
  }

  if (sets.length === 0) return existing;

  params.push(assignmentId);
  await pool.query(
    `UPDATE assignments SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
    params,
  );

  return findById(assignmentId);
};

/**
 * Publishing makes it visible and notifies the cohort. Separate from creation
 * so a teacher can draft an assignment in the open without twenty people
 * getting an alert for a half-written brief.
 */
export const publish = async ({ assignmentId, actorId }) => {
  const assignment = await findById(assignmentId);
  if (!assignment) throw Object.assign(new Error('assignment not found'), { code: 'not_found' });
  if (assignment.published) return assignment;

  if (!assignment.title?.trim() || !assignment.instructions?.trim()) {
    throw Object.assign(new Error('an assignment needs a title and instructions'), {
      code: 'validation_failed',
    });
  }

  await pool.query(`UPDATE assignments SET published = true, updated_at = now() WHERE id = $1`, [
    assignmentId,
  ]);

  const { rows } = await pool.query(
    `SELECT e.user_id, c.slug FROM enrollments e JOIN courses c ON c.id = e.course_id
      WHERE e.course_id = $1 AND e.status = 'active'`,
    [assignment.courseId],
  );

  if (rows.length > 0) {
    const { notifyMany } = await import('../community/NotificationService.js');
    await notifyMany({
      userIds: rows.map((row) => row.user_id),
      type: 'assignment.graded', // shared assignment channel; see the note below
      title: `New assignment: ${assignment.title}`,
      body: assignment.dueAt ? `Due ${new Date(assignment.dueAt).toLocaleDateString()}` : null,
      href: `/courses/${rows[0].slug}/assignments/${assignmentId}`,
      actorId,
      data: { assignmentId },
    }).catch(() => undefined);
  }

  log.info({ assignmentId, cohort: rows.length }, 'assignment published');
  return findById(assignmentId);
};

/** Only while nobody has submitted; after that it is archived, not deleted. */
export const remove = async ({ assignmentId }) => {
  const assignment = await findById(assignmentId);
  if (!assignment) return false;

  if (assignment.submissionCount > 0) {
    throw Object.assign(
      new Error('learners have submitted work; unpublish it instead of deleting it'),
      { code: 'conflict' },
    );
  }

  await pool.query(`UPDATE assignments SET deleted_at = now() WHERE id = $1`, [assignmentId]);
  await pool.query(`UPDATE lessons SET assignment_id = NULL WHERE assignment_id = $1`, [assignmentId]);
  return true;
};

/**
 * Extends the deadline for one learner. Common and currently invisible in most
 * platforms, which is why it is a first-class record rather than a teacher
 * editing the due date for everybody.
 */
export const grantExtension = async ({ assignmentId, userId, dueAt, actorId, reason = null }) => {
  await pool.query(
    `INSERT INTO assignment_extensions (assignment_id, user_id, due_at, granted_by, reason)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (assignment_id, user_id)
     DO UPDATE SET due_at = EXCLUDED.due_at, granted_by = EXCLUDED.granted_by,
                   reason = EXCLUDED.reason, updated_at = now()`,
    [assignmentId, userId, dueAt, actorId, reason],
  );

  log.info({ assignmentId, userId, dueAt }, 'extension granted');
  return { assignmentId, userId, dueAt };
};

/** The deadline that applies to one person: their extension, or the general one. */
export const effectiveDueAt = async ({ assignmentId, userId }) => {
  const { rows } = await pool.query(
    `SELECT coalesce(e.due_at, a.due_at) AS due_at
       FROM assignments a
       LEFT JOIN assignment_extensions e ON e.assignment_id = a.id AND e.user_id = $2
      WHERE a.id = $1`,
    [assignmentId, userId],
  );
  return rows[0]?.due_at?.toISOString() ?? null;
};

export default { findById, findByLesson, listByCourse, create, update, publish, remove, validateRubric, effectiveDueAt };