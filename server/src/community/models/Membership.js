// classroom-app/server/src/community/models/Membership.js
/**
 * Membership row access  (F2)  [NEW]
 *
 * Who is in a space, in what role, and whether they are muted or suspended.
 *
 * `last_read_at` lives here rather than in a separate table because it is
 * written on every visit and read on every space list — the same row, the same
 * frequency. Splitting it would double the writes for no benefit.
 *
 * Suspension and muting are different things and both exist on purpose:
 * a muted member reads but cannot post; a suspended one keeps their history but
 * loses access entirely. Deleting a membership would take the history with it.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'space_memberships';
export const ROLES = ['owner', 'moderator', 'member'];

export const rowToMembership = (row) => ({
  spaceId: row.space_id,
  userId: row.user_id,
  profile: {
    userId: row.user_id,
    displayName: row.display_name ?? '',
    avatarUrl: row.avatar_url ?? null,
  },
  role: row.role,
  joinedAt: row.joined_at.toISOString(),
  mutedUntil: row.muted_until?.toISOString() ?? null,
  suspended: row.suspended,
});

export const find = async ({ spaceId, userId }, client = pool) => {
  const { rows } = await client.query(
    `SELECT m.*, u.display_name, u.avatar_url
       FROM space_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.space_id = $1 AND m.user_id = $2`,
    [spaceId, userId],
  );
  return rows[0] ? rowToMembership(rows[0]) : null;
};

/** Idempotent: joining twice is one membership, and rejoining un-suspends. */
export const join = async ({ spaceId, userId, role = 'member' }, client = pool) => {
  const { rows } = await client.query(
    `INSERT INTO space_memberships (space_id, user_id, role)
     VALUES ($1,$2,$3)
     ON CONFLICT (space_id, user_id) DO UPDATE
       SET suspended = false,
           -- an existing owner is not demoted by a plain re-join
           role = CASE WHEN space_memberships.role = 'owner'
                       THEN 'owner' ELSE EXCLUDED.role END
     RETURNING *`,
    [spaceId, userId, role],
  );
  return find({ spaceId, userId }, client).then((membership) => membership ?? rowToMembership(rows[0]));
};

/**
 * Bulk join, for provisioning a course space with its existing learners. One
 * statement rather than a loop: a course with eight hundred enrolments should
 * not be eight hundred round trips.
 */
export const joinMany = async ({ spaceId, userIds, role = 'member' }, client = pool) => {
  if (userIds.length === 0) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO space_memberships (space_id, user_id, role)
     SELECT $1, unnest($2::uuid[]), $3
     ON CONFLICT (space_id, user_id) DO NOTHING`,
    [spaceId, userIds, role],
  );
  return rowCount;
};

export const leave = async ({ spaceId, userId }, client = pool) => {
  // The last owner cannot leave, or the space becomes unmoderatable.
  const { rows } = await client.query(
    `SELECT role, (SELECT count(*) FROM space_memberships
                    WHERE space_id = $1 AND role = 'owner')::int AS owners
       FROM space_memberships WHERE space_id = $1 AND user_id = $2`,
    [spaceId, userId],
  );

  if (rows[0]?.role === 'owner' && rows[0].owners <= 1) {
    throw Object.assign(new Error('hand the space to someone else first'), { code: 'conflict' });
  }

  const { rowCount } = await client.query(
    `DELETE FROM space_memberships WHERE space_id = $1 AND user_id = $2`,
    [spaceId, userId],
  );
  return rowCount > 0;
};

export const update = async ({ spaceId, userId, patch }, client = pool) => {
  const columns = { role: 'role', mutedUntil: 'muted_until', suspended: 'suspended', muted: 'muted' };
  const sets = [];
  const params = [];

  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return find({ spaceId, userId }, client);

  params.push(spaceId, userId);
  await client.query(
    `UPDATE space_memberships SET ${sets.join(', ')}
      WHERE space_id = $${params.length - 1} AND user_id = $${params.length}`,
    params,
  );
  return find({ spaceId, userId }, client);
};

export const listMembers = async ({ spaceId, cursor, limit = 50 }, client = pool) => {
  const params = [spaceId];
  let where = 'm.space_id = $1';

  if (cursor) {
    const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    params.push(at, id);
    where += ` AND (m.joined_at, m.user_id) < ($2::timestamptz, $3::uuid)`;
  }
  params.push(limit + 1);

  const { rows } = await client.query(
    `SELECT m.*, u.display_name, u.avatar_url
       FROM space_memberships m JOIN users u ON u.id = m.user_id
      WHERE ${where}
      ORDER BY m.joined_at DESC, m.user_id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    items: page.map(rowToMembership),
    hasMore,
    nextCursor: hasMore && page.at(-1)
      ? Buffer.from(`${page.at(-1).joined_at.toISOString()}|${page.at(-1).user_id}`).toString('base64url')
      : null,
  };
};

/** Everyone who should be notified about a thread in this space. */
export const notifiableMembers = async ({ spaceId, excludeUserId }, client = pool) => {
  const { rows } = await client.query(
    `SELECT user_id FROM space_memberships
      WHERE space_id = $1 AND suspended = false AND muted = false AND user_id <> $2`,
    [spaceId, excludeUserId],
  );
  return rows.map((row) => row.user_id);
};

export const markRead = async ({ spaceId, userId }, client = pool) => {
  await client.query(
    `UPDATE space_memberships SET last_read_at = now() WHERE space_id = $1 AND user_id = $2`,
    [spaceId, userId],
  );
};

/** The permission check every write path calls. */
export const canPost = (membership, space) => {
  if (!membership || membership.suspended) return { allowed: false, code: 'forbidden' };
  if (membership.mutedUntil && new Date(membership.mutedUntil) > new Date()) {
    return { allowed: false, code: 'forbidden', reason: 'You are muted in this space.' };
  }
  if (space.postingRestricted && membership.role === 'member') {
    return { allowed: false, code: 'forbidden', reason: 'Only moderators can post here.' };
  }
  if (space.archived) return { allowed: false, code: 'conflict', reason: 'This space is archived.' };
  return { allowed: true };
};

export const isModerator = (membership) =>
  membership?.role === 'owner' || membership?.role === 'moderator';

export default { find, join, joinMany, leave, update, listMembers, canPost, isModerator, markRead };