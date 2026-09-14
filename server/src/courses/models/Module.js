// classroom-app/server/src/courses/models/Module.js
/**
 * Module row access  (F3)  [NEW]
 *
 * Ordering is sparse: positions go 100, 200, 300. A drag-and-drop between two
 * modules writes one row with the midpoint instead of renumbering everything
 * after it — which matters when an author reorders a forty-module course while
 * two hundred learners are reading it.
 *
 * A full reorder still rewrites every position, because after enough midpoint
 * insertions the gaps run out. That is one statement, not forty.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'modules';
export const POSITION_STEP = 100;

export const rowToModule = (row) => ({
  moduleId: row.id,
  courseId: row.course_id,
  title: row.title,
  summary: row.summary,
  position: row.position,
  lessons: [],
  locked: false, // filled in per learner by PrerequisiteResolver
  lockedReason: null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export const listByCourse = async (courseId, client = pool) => {
  const { rows } = await client.query(
    `SELECT * FROM modules WHERE course_id = $1 AND deleted_at IS NULL ORDER BY position ASC, created_at ASC`,
    [courseId],
  );
  return rows.map(rowToModule);
};

export const findById = async (moduleId, client = pool) => {
  const { rows } = await client.query(
    `SELECT * FROM modules WHERE id = $1 AND deleted_at IS NULL`,
    [moduleId],
  );
  return rows[0] ? rowToModule(rows[0]) : null;
};

/** Appends by default: last position plus a step. */
export const insert = async ({ courseId, title, summary = null, position }, client = pool) => {
  const resolved = position ?? (await nextPosition(courseId, client));
  const { rows } = await client.query(
    `INSERT INTO modules (course_id, title, summary, position) VALUES ($1,$2,$3,$4) RETURNING *`,
    [courseId, title, summary, resolved],
  );
  return rowToModule(rows[0]);
};

const nextPosition = async (courseId, client) => {
  const { rows } = await client.query(
    `SELECT coalesce(max(position), 0) + $2 AS next FROM modules WHERE course_id = $1 AND deleted_at IS NULL`,
    [courseId, POSITION_STEP],
  );
  return rows[0].next;
};

export const update = async (moduleId, patch, client = pool) => {
  const sets = [];
  const params = [];

  for (const [key, column] of Object.entries({ title: 'title', summary: 'summary', position: 'position' })) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return findById(moduleId, client);

  params.push(moduleId);
  const { rows } = await client.query(
    `UPDATE modules SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return rows[0] ? rowToModule(rows[0]) : null;
};

/**
 * Rewrites every position from an ordered id list, in one statement. The whole
 * order is sent rather than a diff: a diff needs conflict resolution nobody
 * wants to write for a drag-and-drop.
 */
export const reorder = async (courseId, orderedIds, client = pool) => {
  const positions = orderedIds.map((_id, index) => (index + 1) * POSITION_STEP);
  const { rowCount } = await client.query(
    `UPDATE modules AS m
        SET position = v.position, updated_at = now()
       FROM (SELECT unnest($2::uuid[]) AS id, unnest($3::int[]) AS position) AS v
      WHERE m.id = v.id AND m.course_id = $1`,
    [courseId, orderedIds, positions],
  );
  return rowCount;
};

export const softDelete = async (moduleId, client = pool) => {
  const { rowCount } = await client.query(
    `UPDATE modules SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [moduleId],
  );
  return rowCount > 0;
};

export default { listByCourse, findById, insert, update, reorder, softDelete, rowToModule };