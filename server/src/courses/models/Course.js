// classroom-app/server/src/courses/models/Course.js
/**
 * Course row access  (F3)  [NEW]
 *
 * Data access only: SQL in, domain object out. No business rules — those are in
 * CourseService.js. Keeping the split means a query can be read without
 * understanding publishing, and publishing can be read without understanding
 * SQL.
 *
 * Rows are snake_case because Postgres is; the domain is camelCase because the
 * contracts are. The mapping happens here, once, rather than in every caller.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'courses';

export const rowToCourse = (row) => ({
  courseId: row.id,
  slug: row.slug,
  title: row.title,
  subtitle: row.subtitle,
  description: row.description ?? '',
  language: row.language,
  visibility: row.visibility,
  status: row.status,
  coverAssetId: row.cover_asset_id,
  coverUrl: null, // signed by AssetDelivery when the course is served
  owner: { userId: row.owner_id, displayName: row.owner_name ?? '', avatarUrl: row.owner_avatar ?? null },
  instructors: row.instructors ?? [],
  price: row.price_amount_minor === null
    ? null
    : { amountMinor: row.price_amount_minor, currency: row.price_currency },
  version: row.version,
  publishedAt: row.published_at?.toISOString() ?? null,
  publishedVersion: row.published_version,
  spaceId: row.space_id,
  moduleCount: Number(row.module_count ?? 0),
  lessonCount: Number(row.lesson_count ?? 0),
  estimatedMinutes: Number(row.estimated_minutes ?? 0),
  enrollmentCount: Number(row.enrollment_count ?? 0),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** Counts come from a lateral join rather than denormalised columns, so they
 *  cannot drift out of date after a module is deleted. */
const SELECT = `
  SELECT c.*,
         u.display_name AS owner_name,
         u.avatar_url   AS owner_avatar,
         counts.module_count,
         counts.lesson_count,
         counts.estimated_minutes,
         (SELECT count(*) FROM enrollments e WHERE e.course_id = c.id AND e.status = 'active')
           AS enrollment_count
    FROM courses c
    JOIN users u ON u.id = c.owner_id
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT m.id)                AS module_count,
             count(l.id)                          AS lesson_count,
             coalesce(sum(l.estimated_minutes),0) AS estimated_minutes
        FROM modules m
        LEFT JOIN lessons l ON l.module_id = m.id AND l.deleted_at IS NULL
       WHERE m.course_id = c.id AND m.deleted_at IS NULL
    ) counts ON true
`;

export const findById = async (courseId, client = pool) => {
  const { rows } = await client.query(`${SELECT} WHERE c.id = $1 AND c.deleted_at IS NULL`, [courseId]);
  return rows[0] ? rowToCourse(rows[0]) : null;
};

export const findBySlug = async (slug, client = pool) => {
  const { rows } = await client.query(`${SELECT} WHERE c.slug = $1 AND c.deleted_at IS NULL`, [slug]);
  return rows[0] ? rowToCourse(rows[0]) : null;
};

/**
 * Keyset pagination on (created_at, id). Offset would shift under the reader
 * whenever a course is published, which on a busy tenant is constantly.
 */
export const list = async ({ status, ownerId, enrolledUserId, q, cursor, limit = 25 }, client = pool) => {
  const conditions = ['c.deleted_at IS NULL'];
  const params = [];

  if (status) { params.push(status); conditions.push(`c.status = $${params.length}`); }
  if (ownerId) { params.push(ownerId); conditions.push(`c.owner_id = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(c.title ILIKE $${params.length} OR c.subtitle ILIKE $${params.length})`);
  }
  if (enrolledUserId) {
    params.push(enrolledUserId);
    conditions.push(
      `EXISTS (SELECT 1 FROM enrollments e WHERE e.course_id = c.id AND e.user_id = $${params.length} AND e.status = 'active')`,
    );
  }
  if (cursor) {
    const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    params.push(at, id);
    conditions.push(`(c.created_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  params.push(limit + 1); // one extra to detect another page

  const { rows } = await client.query(
    `${SELECT} WHERE ${conditions.join(' AND ')} ORDER BY c.created_at DESC, c.id DESC LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(rowToCourse);
  const last = rows[page.length - 1];

  return {
    items: page,
    hasMore,
    nextCursor: hasMore && last
      ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url')
      : null,
  };
};

export const insert = async (course, client = pool) => {
  const { rows } = await client.query(
    `INSERT INTO courses (slug, title, subtitle, description, language, visibility,
                          status, owner_id, version)
     VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,1)
     RETURNING id`,
    [course.slug, course.title, course.subtitle ?? null, course.description ?? '',
     course.language ?? 'en', course.visibility ?? 'members', course.ownerId],
  );
  return findById(rows[0].id, client);
};

/** Only the columns present in `patch` are written. */
export const update = async (courseId, patch, client = pool) => {
  const columns = {
    title: 'title', subtitle: 'subtitle', description: 'description',
    language: 'language', visibility: 'visibility', slug: 'slug',
    coverAssetId: 'cover_asset_id', status: 'status', spaceId: 'space_id',
  };

  const sets = [];
  const params = [];

  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }

  if (patch.price !== undefined) {
    params.push(patch.price?.amountMinor ?? null);
    sets.push(`price_amount_minor = $${params.length}`);
    params.push(patch.price?.currency ?? null);
    sets.push(`price_currency = $${params.length}`);
  }

  if (sets.length === 0) return findById(courseId, client);

  params.push(courseId);
  await client.query(
    `UPDATE courses SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
    params,
  );
  return findById(courseId, client);
};

/** Soft delete. An enrolled learner's history must survive the course. */
export const softDelete = async (courseId, client = pool) => {
  const { rowCount } = await client.query(
    `UPDATE courses SET deleted_at = now(), status = 'archived' WHERE id = $1 AND deleted_at IS NULL`,
    [courseId],
  );
  return rowCount > 0;
};

export const slugExists = async (slug, exceptCourseId = null, client = pool) => {
  const { rows } = await client.query(
    `SELECT 1 FROM courses WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2) LIMIT 1`,
    [slug, exceptCourseId],
  );
  return rows.length > 0;
};

export default { findById, findBySlug, list, insert, update, softDelete, rowToCourse };