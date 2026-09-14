// classroom-app/server/src/courses/models/Enrollment.js
/**
 * Enrolment row access  (F3)  [NEW]
 *
 * An enrolment pins the learner to a course *version*. That is the field worth
 * understanding: republishing a course does not move anyone. Someone halfway
 * through version 3 stays on version 3 until they finish or are explicitly
 * migrated, because restructuring modules under a learner mid-course is how
 * progress records end up pointing at lessons that no longer exist.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'enrollments';

export const rowToEnrollment = (row) => ({
  enrollmentId: row.id,
  courseId: row.course_id,
  userId: row.user_id,
  status: row.status,
  courseVersion: row.course_version,
  source: row.source,
  startedAt: row.started_at?.toISOString() ?? null,
  completedAt: row.completed_at?.toISOString() ?? null,
  expiresAt: row.expires_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export const find = async ({ courseId, userId }, client = pool) => {
  const { rows } = await client.query(
    `SELECT * FROM enrollments WHERE course_id = $1 AND user_id = $2`,
    [courseId, userId],
  );
  return rows[0] ? rowToEnrollment(rows[0]) : null;
};

/**
 * Idempotent. Two clicks on Enrol must not produce two rows, and re-enrolling
 * after cancelling should reactivate rather than duplicate.
 */
export const enroll = async ({ courseId, userId, courseVersion, source = 'self', expiresAt = null }, client = pool) => {
  const { rows } = await client.query(
    `INSERT INTO enrollments (course_id, user_id, course_version, source, status, expires_at)
     VALUES ($1,$2,$3,$4,'active',$5)
     ON CONFLICT (course_id, user_id)
     DO UPDATE SET status = 'active',
                   -- a returning learner picks up the current version
                   course_version = EXCLUDED.course_version,
                   expires_at = EXCLUDED.expires_at,
                   updated_at = now()
     RETURNING *`,
    [courseId, userId, courseVersion, source, expiresAt],
  );
  return rowToEnrollment(rows[0]);
};

export const listByCourse = async ({ courseId, cursor, limit = 25 }, client = pool) => {
  const params = [courseId];
  let where = 'e.course_id = $1';

  if (cursor) {
    const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    params.push(at, id);
    where += ` AND (e.created_at, e.id) < ($2::timestamptz, $3::uuid)`;
  }
  params.push(limit + 1);

  const { rows } = await client.query(
    `SELECT e.* FROM enrollments e WHERE ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    items: page.map(rowToEnrollment),
    hasMore,
    nextCursor: hasMore && page.at(-1)
      ? Buffer.from(`${page.at(-1).created_at.toISOString()}|${page.at(-1).id}`).toString('base64url')
      : null,
  };
};

export const listByUser = async (userId, client = pool) => {
  const { rows } = await client.query(
    `SELECT * FROM enrollments WHERE user_id = $1 AND status <> 'cancelled' ORDER BY updated_at DESC`,
    [userId],
  );
  return rows.map(rowToEnrollment);
};

/** Set on the first lesson opened, not on enrolling. */
export const markStarted = async ({ courseId, userId }, client = pool) => {
  await client.query(
    `UPDATE enrollments SET started_at = coalesce(started_at, now()), updated_at = now()
      WHERE course_id = $1 AND user_id = $2`,
    [courseId, userId],
  );
};

export const markCompleted = async ({ courseId, userId }, client = pool) => {
  const { rows } = await client.query(
    `UPDATE enrollments
        SET status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now()
      WHERE course_id = $1 AND user_id = $2 AND status = 'active'
      RETURNING *`,
    [courseId, userId],
  );
  return rows[0] ? rowToEnrollment(rows[0]) : null;
};

export const cancel = async ({ courseId, userId }, client = pool) => {
  const { rowCount } = await client.query(
    `UPDATE enrollments SET status = 'cancelled', updated_at = now()
      WHERE course_id = $1 AND user_id = $2 AND status = 'active'`,
    [courseId, userId],
  );
  return rowCount > 0;
};

/** Swept by a scheduled job; an expired enrolment loses access, not history. */
export const expireOverdue = async (client = pool) => {
  const { rowCount } = await client.query(
    `UPDATE enrollments SET status = 'expired', updated_at = now()
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < now()`,
  );
  return rowCount;
};

export const isEnrolled = async ({ courseId, userId }, client = pool) => {
  const { rows } = await client.query(
    `SELECT 1 FROM enrollments WHERE course_id = $1 AND user_id = $2 AND status IN ('active','completed') LIMIT 1`,
    [courseId, userId],
  );
  return rows.length > 0;
};

export default { find, enroll, listByCourse, listByUser, markStarted, markCompleted, cancel, isEnrolled };