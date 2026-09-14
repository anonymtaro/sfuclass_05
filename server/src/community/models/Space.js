// classroom-app/server/src/community/models/Space.js
/**
 * Space row access  (F2)  [NEW]
 *
 * A space is either bound to a course or standalone. The `course_id` column is
 * what makes the difference, and it is nullable rather than two tables because
 * every query that matters — list my spaces, show this feed, count members —
 * is identical for both kinds.
 *
 * Counts are computed in a lateral join rather than denormalised. A member
 * count that drifts after a bulk unenrolment is the kind of bug nobody notices
 * until a teacher asks why the number is wrong.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'spaces';

export const rowToSpace = (row) => ({
  spaceId: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  visibility: row.visibility,
  courseId: row.course_id,
  coverAssetId: row.cover_asset_id,
  coverUrl: null, // signed on read by AssetDelivery
  memberCount: Number(row.member_count ?? 0),
  threadCount: Number(row.thread_count ?? 0),
  onlineCount: 0, // filled in from Redis by PresenceService
  viewerRole: row.viewer_role ?? null,
  joined: Boolean(row.viewer_role),
  muted: row.viewer_muted ?? false,
  unreadCount: Number(row.unread_count ?? 0),
  postingRestricted: row.posting_restricted,
  archived: row.archived,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/**
 * `viewerId` is threaded through the query rather than fetched separately, so
 * a list of twenty spaces is one round trip instead of twenty-one.
 */
const SELECT = `
  SELECT s.*,
         m.role       AS viewer_role,
         m.muted      AS viewer_muted,
         counts.member_count,
         counts.thread_count,
         (SELECT count(*) FROM threads t
           WHERE t.space_id = s.id AND t.deleted_at IS NULL
             AND t.last_post_at > coalesce(m.last_read_at, to_timestamp(0))) AS unread_count
    FROM spaces s
    LEFT JOIN space_memberships m ON m.space_id = s.id AND m.user_id = $1
    LEFT JOIN LATERAL (
      SELECT (SELECT count(*) FROM space_memberships sm
               WHERE sm.space_id = s.id AND sm.suspended = false) AS member_count,
             (SELECT count(*) FROM threads t
               WHERE t.space_id = s.id AND t.deleted_at IS NULL)  AS thread_count
    ) counts ON true
`;

export const findById = async (spaceId, viewerId = null, client = pool) => {
  const { rows } = await client.query(`${SELECT} WHERE s.id = $2 AND s.deleted_at IS NULL`, [viewerId, spaceId]);
  return rows[0] ? rowToSpace(rows[0]) : null;
};

export const findBySlug = async (slug, viewerId = null, client = pool) => {
  const { rows } = await client.query(`${SELECT} WHERE s.slug = $2 AND s.deleted_at IS NULL`, [viewerId, slug]);
  return rows[0] ? rowToSpace(rows[0]) : null;
};

export const findByCourse = async (courseId, viewerId = null, client = pool) => {
  const { rows } = await client.query(`${SELECT} WHERE s.course_id = $2 AND s.deleted_at IS NULL`, [viewerId, courseId]);
  return rows[0] ? rowToSpace(rows[0]) : null;
};

export const list = async ({ viewerId, joined, cursor, limit = 25 }, client = pool) => {
  const params = [viewerId];
  const conditions = ['s.deleted_at IS NULL', 's.archived = false'];

  // A private space is invisible unless you are in it; a members-only space is
  // listed but not readable. Enforced here rather than in the service, so no
  // query path can forget it.
  conditions.push(`(s.visibility = 'public' OR m.user_id IS NOT NULL)`);

  if (joined) conditions.push('m.user_id IS NOT NULL');

  if (cursor) {
    const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    params.push(at, id);
    conditions.push(`(s.created_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  params.push(limit + 1);

  const { rows } = await client.query(
    `${SELECT} WHERE ${conditions.join(' AND ')} ORDER BY s.created_at DESC, s.id DESC LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    items: page.map(rowToSpace),
    hasMore,
    nextCursor: hasMore && page.at(-1)
      ? Buffer.from(`${page.at(-1).created_at.toISOString()}|${page.at(-1).id}`).toString('base64url')
      : null,
  };
};

export const insert = async ({ name, slug, description, visibility, courseId, ownerId }, client = pool) => {
  const { rows } = await client.query(
    `INSERT INTO spaces (name, slug, description, visibility, course_id, owner_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [name, slug, description ?? null, visibility ?? 'members', courseId ?? null, ownerId],
  );
  return findById(rows[0].id, ownerId, client);
};

export const update = async (spaceId, patch, viewerId = null, client = pool) => {
  const columns = {
    name: 'name', slug: 'slug', description: 'description', visibility: 'visibility',
    coverAssetId: 'cover_asset_id', postingRestricted: 'posting_restricted', archived: 'archived',
  };

  const sets = [];
  const params = [];

  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return findById(spaceId, viewerId, client);

  params.push(spaceId);
  await client.query(
    `UPDATE spaces SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
    params,
  );
  return findById(spaceId, viewerId, client);
};

export const slugExists = async (slug, client = pool) => {
  const { rows } = await client.query(`SELECT 1 FROM spaces WHERE slug = $1 LIMIT 1`, [slug]);
  return rows.length > 0;
};

export const softDelete = async (spaceId, client = pool) => {
  const { rowCount } = await client.query(
    `UPDATE spaces SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [spaceId],
  );
  return rowCount > 0;
};

export default { findById, findBySlug, findByCourse, list, insert, update, softDelete, rowToSpace };