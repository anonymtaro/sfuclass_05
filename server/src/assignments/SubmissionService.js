// classroom-app/server/src/assignments/SubmissionService.js
/**
 * Submissions  (F4)  [NEW]
 *
 * Draft, submit, resubmit, lock.
 *
 * The distinction that matters is between saving and handing in. A draft is
 * autosaved and freely editable; submitting locks it. Without that split,
 * either autosave counts as submission — and a half-typed answer gets graded —
 * or there is no autosave and people lose work.
 *
 * A resubmission is a new attempt, never an edit of the graded one. Feedback
 * must keep referring to the thing that was read: editing a submission after it
 * has been marked makes the grade unexplainable, and it is the obvious way to
 * cheat an appeal.
 *
 * Files never pass through here. A submission references assets that are
 * already `ready` in media/, which is also why a virus-scanned file is the only
 * kind that can be handed in.
 */

import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';
import * as Assignments from './AssignmentService.js';

const log = logger.child({ component: 'submissions' });

// ---------------------------------------------------------------------------
// Lateness  (pure)
// ---------------------------------------------------------------------------

/**
 * Is this late, and what does the policy say about it?
 *
 * A minute of grace absorbs clock skew between a learner's device and the
 * server. Failing someone's assignment because their laptop was thirty seconds
 * fast is not a rule anybody would write down on purpose.
 *
 * @returns {{ late: boolean, blocked: boolean, penaltyPercent: number, lateBySec: number }}
 */
export const assessLateness = ({ dueAt, submittedAt = new Date(), latePolicy = 'accepted', latePenaltyPercent = 0 }) => {
  if (!dueAt) return { late: false, blocked: false, penaltyPercent: 0, lateBySec: 0 };

  const GRACE_SEC = 60;
  const lateBySec = Math.floor((new Date(submittedAt) - new Date(dueAt)) / 1000);

  if (lateBySec <= GRACE_SEC) {
    return { late: false, blocked: false, penaltyPercent: 0, lateBySec: 0 };
  }

  return {
    late: true,
    blocked: latePolicy === 'blocked',
    penaltyPercent: latePolicy === 'penalised' ? latePenaltyPercent : 0,
    lateBySec,
  };
};

/**
 * Whether this person can hand something in right now, and why not if they
 * cannot. Pure, so the button state and the server check cannot disagree.
 */
export const canSubmit = ({ assignment, submission, dueAt, now = new Date() }) => {
  if (!assignment.published) {
    return { allowed: false, code: 'not_found', reason: 'This assignment is not open yet.' };
  }

  const attempt = submission?.attempt ?? 0;
  if (attempt >= assignment.maxAttempts && submission?.status !== 'resubmit') {
    return {
      allowed: false,
      code: 'conflict',
      reason:
        assignment.maxAttempts === 1
          ? 'You have already submitted this assignment.'
          : `You have used all ${assignment.maxAttempts} attempts.`,
    };
  }

  // 'returned' means graded and released. Only the teacher asking for another
  // attempt reopens it.
  if (submission?.status === 'returned') {
    return { allowed: false, code: 'conflict', reason: 'This has already been graded.' };
  }

  const lateness = assessLateness({
    dueAt,
    submittedAt: now,
    latePolicy: assignment.latePolicy,
    latePenaltyPercent: assignment.latePenaltyPercent,
  });

  if (lateness.blocked) {
    return { allowed: false, code: 'conflict', reason: 'The deadline has passed.', lateness };
  }

  return { allowed: true, lateness };
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const rowToSubmission = (row) => ({
  submissionId: row.id,
  assignmentId: row.assignment_id,
  learner: {
    userId: row.user_id,
    displayName: row.display_name ?? '',
    avatarUrl: row.avatar_url ?? null,
  },
  attempt: row.attempt,
  status: row.status,
  text: row.text,
  links: row.links ?? [],
  files: row.files ?? [],
  submittedAt: row.submitted_at?.toISOString() ?? null,
  late: row.late,
  lockedAt: row.locked_at?.toISOString() ?? null,
  grade: null, // attached by GradingService when it is released
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const SELECT = `
  SELECT s.*, u.display_name, u.avatar_url
    FROM submissions s JOIN users u ON u.id = s.user_id
`;

export const findCurrent = async ({ assignmentId, userId }, client = pool) => {
  const { rows } = await client.query(
    `${SELECT} WHERE s.assignment_id = $1 AND s.user_id = $2
      ORDER BY s.attempt DESC LIMIT 1`,
    [assignmentId, userId],
  );
  return rows[0] ? rowToSubmission(rows[0]) : null;
};

export const findById = async (submissionId, client = pool) => {
  const { rows } = await client.query(`${SELECT} WHERE s.id = $1`, [submissionId]);
  return rows[0] ? rowToSubmission(rows[0]) : null;
};

export const listAttempts = async ({ assignmentId, userId }) => {
  const { rows } = await pool.query(
    `${SELECT} WHERE s.assignment_id = $1 AND s.user_id = $2 ORDER BY s.attempt ASC`,
    [assignmentId, userId],
  );
  return rows.map(rowToSubmission);
};

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

/**
 * Autosave. Overwrites the open draft; never creates a second one and never
 * touches a submitted attempt.
 */
export const saveDraft = async ({ assignmentId, userId, text, links, assetIds }) => {
  const assignment = await Assignments.findById(assignmentId);
  if (!assignment) throw Object.assign(new Error('assignment not found'), { code: 'not_found' });

  const current = await findCurrent({ assignmentId, userId });

  if (current && current.status !== 'draft' && current.status !== 'resubmit') {
    throw Object.assign(new Error('this attempt has already been submitted'), { code: 'conflict' });
  }

  const files = assetIds === undefined ? undefined : await resolveFiles({ assetIds, userId, assignment });

  const { rows } = await pool.query(
    `INSERT INTO submissions (assignment_id, user_id, attempt, status, text, links, files)
     VALUES ($1,$2,$3,'draft',$4,$5,$6::jsonb)
     ON CONFLICT (assignment_id, user_id, attempt) DO UPDATE
       SET text  = coalesce($4, submissions.text),
           links = coalesce($5, submissions.links),
           files = coalesce($6::jsonb, submissions.files),
           updated_at = now()
     RETURNING id`,
    [
      assignmentId, userId, current?.attempt ?? 1,
      text ?? null, links ?? null, files ? JSON.stringify(files) : null,
    ],
  );

  return findById(rows[0].id);
};

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

export const submit = async ({ assignmentId, userId, acknowledgeLate = false }) => {
  const assignment = await Assignments.findById(assignmentId);
  if (!assignment) throw Object.assign(new Error('assignment not found'), { code: 'not_found' });

  const dueAt = await Assignments.effectiveDueAt({ assignmentId, userId });
  const current = await findCurrent({ assignmentId, userId });

  const verdict = canSubmit({ assignment, submission: current, dueAt });
  if (!verdict.allowed) {
    throw Object.assign(new Error(verdict.reason), { code: verdict.code });
  }

  if (!current) {
    throw Object.assign(new Error('there is nothing to submit'), { code: 'validation_failed' });
  }

  const hasContent =
    (current.text?.trim().length ?? 0) > 0 || current.files.length > 0 || current.links.length > 0;

  if (!hasContent) {
    throw Object.assign(new Error('there is nothing to submit'), { code: 'validation_failed' });
  }

  // A late submission needs an explicit acknowledgement, so nobody discovers
  // the penalty from their grade.
  if (verdict.lateness.late && verdict.lateness.penaltyPercent > 0 && !acknowledgeLate) {
    throw Object.assign(
      new Error(`This is late and will lose ${verdict.lateness.penaltyPercent}%.`),
      { code: 'conflict', requiresAcknowledgement: true, lateness: verdict.lateness },
    );
  }

  const { rows } = await pool.query(
    `UPDATE submissions
        SET status = 'submitted', submitted_at = now(), locked_at = now(),
            late = $3, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status IN ('draft','resubmit')
      RETURNING id`,
    [current.submissionId, userId, verdict.lateness.late],
  );

  if (!rows[0]) {
    // Lost a race with another tab; theirs landed first and is just as valid.
    return findCurrent({ assignmentId, userId });
  }

  log.info(
    { assignmentId, userId, attempt: current.attempt, late: verdict.lateness.late },
    'assignment submitted',
  );

  // Handing work in completes the task lesson. Grading does not change that:
  // the learner did what was asked.
  if (assignment.lessonId) {
    const { updateLessonProgress } = await import('../courses/ProgressService.js');
    await updateLessonProgress({
      userId,
      lessonId: assignment.lessonId,
      status: 'completed',
    }).catch(() => undefined);
  }

  await notifyTeachers({ assignment, userId }).catch(() => undefined);

  return findById(rows[0].id);
};

/**
 * Opens a fresh attempt. Called by GradingService when a teacher asks for
 * more work, or by the learner if the assignment allows several attempts.
 */
export const openNextAttempt = async ({ assignmentId, userId, copyPrevious = true }) => {
  const assignment = await Assignments.findById(assignmentId);
  const current = await findCurrent({ assignmentId, userId });

  if (!current) throw Object.assign(new Error('nothing to resubmit'), { code: 'not_found' });
  if (current.attempt >= assignment.maxAttempts && current.status !== 'resubmit') {
    throw Object.assign(new Error('no attempts left'), { code: 'conflict' });
  }

  const { rows } = await pool.query(
    `INSERT INTO submissions (assignment_id, user_id, attempt, status, text, links, files)
     VALUES ($1,$2,$3,'draft',$4,$5,$6::jsonb)
     ON CONFLICT (assignment_id, user_id, attempt) DO NOTHING
     RETURNING id`,
    [
      assignmentId, userId, current.attempt + 1,
      // Starting from the previous attempt is almost always what someone
      // wants when they have been asked to revise.
      copyPrevious ? current.text : null,
      copyPrevious ? current.links : [],
      JSON.stringify(copyPrevious ? current.files : []),
    ],
  );

  return rows[0] ? findById(rows[0].id) : findCurrent({ assignmentId, userId });
};

/** Withdraw before it has been graded. After grading, it stands. */
export const unsubmit = async ({ assignmentId, userId }) => {
  const current = await findCurrent({ assignmentId, userId });
  if (!current) return null;

  if (current.status === 'returned') {
    throw Object.assign(new Error('this has already been graded'), { code: 'conflict' });
  }

  const { rowCount } = await pool.query(
    `UPDATE submissions SET status = 'draft', submitted_at = NULL, locked_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'submitted'`,
    [current.submissionId],
  );

  return rowCount > 0 ? findById(current.submissionId) : current;
};

// ---------------------------------------------------------------------------
// Teacher views
// ---------------------------------------------------------------------------

export const listForAssignment = async ({ assignmentId, status, ungraded, late, cursor, limit = 25 }) => {
  const params = [assignmentId];
  const conditions = ['s.assignment_id = $1'];

  // Only the latest attempt per learner: a teacher marking twenty people
  // should see twenty rows, not forty-three.
  conditions.push(`s.attempt = (SELECT max(attempt) FROM submissions x
                                 WHERE x.assignment_id = s.assignment_id AND x.user_id = s.user_id)`);

  if (status) { params.push(status); conditions.push(`s.status = $${params.length}`); }
  if (ungraded) conditions.push(`s.status = 'submitted'`);
  if (late) conditions.push('s.late = true');

  if (cursor) {
    const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    params.push(at, id);
    conditions.push(`(s.submitted_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);

  const { rows } = await pool.query(
    `${SELECT} WHERE ${conditions.join(' AND ')}
      ORDER BY s.submitted_at DESC NULLS LAST, s.id DESC LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    items: page.map(rowToSubmission),
    hasMore,
    nextCursor: hasMore && page.at(-1)?.submitted_at
      ? Buffer.from(`${page.at(-1).submitted_at.toISOString()}|${page.at(-1).id}`).toString('base64url')
      : null,
  };
};

/** Who has not handed in. The list a teacher actually chases. */
export const listMissing = async ({ assignmentId }) => {
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, u.display_name
       FROM assignments a
       JOIN enrollments e ON e.course_id = a.course_id AND e.status = 'active'
       JOIN users u ON u.id = e.user_id
      WHERE a.id = $1
        AND NOT EXISTS (
          SELECT 1 FROM submissions s
           WHERE s.assignment_id = a.id AND s.user_id = u.id AND s.status <> 'draft'
        )
      ORDER BY u.display_name`,
    [assignmentId],
  );
  return rows.map((row) => ({ userId: row.user_id, displayName: row.display_name }));
};

/** Peer view, when the assignment allows it and the viewer has submitted. */
export const listPeerVisible = async ({ assignmentId, viewerId }) => {
  const assignment = await Assignments.findById(assignmentId);
  if (!assignment?.peerVisible) {
    throw Object.assign(new Error('peer review is not enabled here'), { code: 'forbidden' });
  }

  const own = await findCurrent({ assignmentId, userId: viewerId });
  if (!own || own.status === 'draft') {
    throw Object.assign(new Error('submit your own work first'), { code: 'forbidden' });
  }

  const { rows } = await pool.query(
    `${SELECT} WHERE s.assignment_id = $1 AND s.user_id <> $2 AND s.status <> 'draft'
      ORDER BY s.submitted_at DESC LIMIT 50`,
    [assignmentId, viewerId],
  );
  return rows.map(rowToSubmission);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Files must be `ready` and must belong to the person submitting. Without the
 * ownership check a guessed asset id would let someone hand in a file they do
 * not own; without the readiness check they could submit something still in
 * quarantine.
 */
const resolveFiles = async ({ assetIds, userId, assignment }) => {
  if (assetIds.length === 0) return [];

  if (assetIds.length > assignment.maxFiles) {
    throw Object.assign(new Error(`At most ${assignment.maxFiles} files.`), {
      code: 'validation_failed',
    });
  }

  const { getAssetsForOwner } = await import('../media/UploadService.js');
  const assets = await getAssetsForOwner({ assetIds, userId });

  if (assets.length !== assetIds.length) {
    throw Object.assign(new Error('unknown attachment'), { code: 'not_found' });
  }

  const pending = assets.filter((asset) => asset.status !== 'ready');
  if (pending.length > 0) {
    throw Object.assign(new Error('one or more files are still being processed'), {
      code: 'asset_not_ready',
    });
  }

  if (assignment.allowedExtensions.length > 0) {
    const rejected = assets.filter((asset) => {
      const extension = asset.fileName.split('.').pop()?.toLowerCase();
      return !assignment.allowedExtensions.includes(extension);
    });
    if (rejected.length > 0) {
      throw Object.assign(
        new Error(`Only ${assignment.allowedExtensions.join(', ')} files are accepted.`),
        { code: 'unsupported_media_type' },
      );
    }
  }

  return assets.map((asset) => ({
    assetId: asset.assetId,
    kind: asset.kind,
    fileName: asset.fileName,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
    thumbnailUrl: asset.thumbnailUrl ?? null,
  }));
};

const notifyTeachers = async ({ assignment, userId }) => {
  const { rows } = await pool.query(
    `SELECT owner_id, slug FROM courses WHERE id = $1`,
    [assignment.courseId],
  );
  if (!rows[0]) return;

  const { notify } = await import('../community/NotificationService.js');
  await notify({
    userId: rows[0].owner_id,
    type: 'assignment.graded',
    title: `New submission for ${assignment.title}`,
    href: `/courses/${rows[0].slug}/assignments/${assignment.assignmentId}`,
    actorId: userId,
    data: { assignmentId: assignment.assignmentId },
  });
};

export default {
  saveDraft, submit, unsubmit, openNextAttempt, findCurrent, listAttempts,
  listForAssignment, listMissing, listPeerVisible, canSubmit, assessLateness,
};