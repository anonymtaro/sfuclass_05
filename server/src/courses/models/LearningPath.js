// classroom-app/server/src/courses/models/LearningPath.js
/**
 * Learning path row access  (F3)  [NEW]
 *
 * The path is one row per course holding the whole edge list as JSONB, not a
 * row per edge.
 *
 * Two reasons. It is always read whole — knowing one prerequisite is never
 * useful without knowing the rest — and it is always written whole, because the
 * builder sends the complete graph after every change. A join table would add a
 * transaction and a delete-then-insert to every save and buy nothing.
 *
 * The graph is validated before it is stored; see CurriculumGraph.validate.
 * An invalid path never reaches this file.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'learning_paths';

export const rowToPath = (row) => ({
  pathId: row.id,
  courseId: row.course_id,
  edges: row.edges ?? [],
  entryModuleIds: row.entry_module_ids ?? [],
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export const findByCourse = async (courseId, client = pool) => {
  const { rows } = await client.query(`SELECT * FROM learning_paths WHERE course_id = $1`, [courseId]);
  return rows[0] ? rowToPath(rows[0]) : null;
};

/**
 * Upsert. A course without a path is a course where every module is open,
 * which is a perfectly normal thing to publish — so the row is created on the
 * first edge rather than alongside the course.
 */
export const save = async ({ courseId, edges, entryModuleIds }, client = pool) => {
  const { rows } = await client.query(
    `INSERT INTO learning_paths (course_id, edges, entry_module_ids)
     VALUES ($1, $2::jsonb, $3::uuid[])
     ON CONFLICT (course_id)
     DO UPDATE SET edges = $2::jsonb, entry_module_ids = $3::uuid[], updated_at = now()
     RETURNING *`,
    [courseId, JSON.stringify(edges), entryModuleIds],
  );
  return rowToPath(rows[0]);
};

/**
 * Removes every edge touching a module. Called when a module is deleted —
 * without it the path keeps a dangling prerequisite and the resolver locks a
 * module forever against something that no longer exists.
 */
export const removeModule = async (courseId, moduleId, client = pool) => {
  const path = await findByCourse(courseId, client);
  if (!path) return null;

  const edges = path.edges.filter((edge) => edge.from !== moduleId && edge.to !== moduleId);
  if (edges.length === path.edges.length) return path;

  return save(
    {
      courseId,
      edges,
      entryModuleIds: path.entryModuleIds.filter((id) => id !== moduleId),
    },
    client,
  );
};

export const clear = async (courseId, client = pool) => {
  await client.query(`DELETE FROM learning_paths WHERE course_id = $1`, [courseId]);
};

export default { findByCourse, save, removeModule, clear, rowToPath };