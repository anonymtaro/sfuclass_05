// classroom-app/server/src/media/models/Submission.js
/**
 * Submission files  (F4)  [NEW]
 *
 * The link between an assignment submission and the assets attached to it.
 *
 * A note on the overlap, because there are now two files called Submission.
 * `assignments/SubmissionService.js` owns the submission itself — attempts,
 * lateness, locking, grading. This file owns nothing about that. It exists
 * because the media domain has to answer questions the assignments domain
 * cannot:
 *
 *   which assets belong to a submission, for retention and deletion
 *   whether an asset may be read by a particular person, for DownloadService
 *   how much of a tenant's quota is submitted coursework
 *
 * The alternative — having media/ import the assignments domain to answer them
 * — would make the dependency circular, since assignments already imports
 * media for uploads.
 *
 * If you would rather not have two files with this name, the honest merge is to
 * fold these four functions into UploadService and delete this file. I have
 * kept it because the tree asks for it.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'submission_files';

export const rowToFile = (row) => ({
  submissionId: row.submission_id,
  assetId: row.asset_id,
  attempt: row.attempt,
  fileName: row.file_name,
  contentType: row.content_type,
  sizeBytes: Number(row.size_bytes ?? 0),
  status: row.status,
  attachedAt: row.attached_at.toISOString(),
});

/**
 * Records the assets that make up one attempt. Replaces the set rather than
 * adding to it: a resave of a draft is the whole list, not a delta.
 */
export const attach = async ({ submissionId, attempt, assetIds }, client = pool) => {
  const owned = client === pool;
  const connection = owned ? await pool.connect() : client;

  try {
    if (owned) await connection.query('BEGIN');

    await connection.query(
      `DELETE FROM submission_files WHERE submission_id = $1 AND attempt = $2`,
      [submissionId, attempt],
    );

    if (assetIds.length > 0) {
      await connection.query(
        `INSERT INTO submission_files (submission_id, attempt, asset_id)
         SELECT $1, $2, unnest($3::uuid[])
         ON CONFLICT DO NOTHING`,
        [submissionId, attempt, assetIds],
      );
    }

    if (owned) await connection.query('COMMIT');
    return assetIds.length;
  } catch (cause) {
    if (owned) await connection.query('ROLLBACK');
    throw cause;
  } finally {
    if (owned) connection.release();
  }
};

export const listFor = async ({ submissionId, attempt = null }, client = pool) => {
  const { rows } = await client.query(
    `SELECT sf.submission_id, sf.attempt, sf.attached_at,
            a.id AS asset_id, a.file_name, a.content_type, a.size_bytes, a.status
       FROM submission_files sf
       JOIN assets a ON a.id = sf.asset_id
      WHERE sf.submission_id = $1 AND ($2::int IS NULL OR sf.attempt = $2)
        AND a.deleted_at IS NULL
      ORDER BY sf.attached_at ASC`,
    [submissionId, attempt],
  );
  return rows.map(rowToFile);
};

/**
 * Who may read a submitted file.
 *
 * Three answers, and the third is the one worth noting: a peer may read it only
 * when the assignment enables peer review *and* the reader has submitted their
 * own work. Otherwise "peer review" is a way to copy somebody else's answer.
 */
export const readersOf = async (assetId, client = pool) => {
  const { rows } = await client.query(
    `SELECT s.user_id      AS learner_id,
            c.owner_id     AS teacher_id,
            a.peer_visible AS peer_visible,
            a.id           AS assignment_id
       FROM submission_files sf
       JOIN submissions s  ON s.id = sf.submission_id
       JOIN assignments a  ON a.id = s.assignment_id
       JOIN courses c      ON c.id = a.course_id
      WHERE sf.asset_id = $1
      LIMIT 1`,
    [assetId],
  );

  if (!rows[0]) return null;

  return {
    learnerId: rows[0].learner_id,
    teacherId: rows[0].teacher_id,
    peerVisible: rows[0].peer_visible,
    assignmentId: rows[0].assignment_id,
  };
};

/** Coursework that belongs to a course, for bulk retention when it is deleted. */
export const assetsForCourse = async (courseId, client = pool) => {
  const { rows } = await client.query(
    `SELECT sf.asset_id
       FROM submission_files sf
       JOIN submissions s ON s.id = sf.submission_id
       JOIN assignments a ON a.id = s.assignment_id
      WHERE a.course_id = $1`,
    [courseId],
  );
  return rows.map((row) => row.asset_id);
};

/**
 * How much of an owner's quota is submitted coursework. Split out because
 * submissions outlive a course — a grade appeal can arrive months later — and
 * are therefore the one category that cannot be pruned on a schedule.
 */
export const quotaUsage = async (ownerId, client = pool) => {
  const { rows } = await client.query(
    `SELECT coalesce(sum(a.size_bytes), 0)::bigint AS used, count(*)::int AS files
       FROM submission_files sf
       JOIN assets a ON a.id = sf.asset_id
      WHERE a.owner_id = $1 AND a.deleted_at IS NULL`,
    [ownerId],
  );
  return { usedBytes: Number(rows[0].used), files: rows[0].files };
};

export default { attach, listFor, readersOf, assetsForCourse, quotaUsage };