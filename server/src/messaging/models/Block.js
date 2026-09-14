// classroom-app/server/src/messaging/models/Block.js
/**
 * Block list  (F6)
 *
 * Blocking is enforced on the server, on send, in both directions — the blocked
 * person cannot message the blocker, and the blocker receives nothing new from
 * them. A client-side filter would be trivially defeated and would still
 * deliver the message to the device.
 *
 * What blocking is not: deletion. Existing history stays. Removing someone
 * else's words from a conversation they were part of is moderation, and it goes
 * through ChatModerationService with an audit record.
 *
 * `areBlocked` is called on every direct send and every DM open, so it is one
 * indexed lookup checking both directions at once.
 */

import { pool } from '../../db/pool.js';

/** True when either has blocked the other. Direction rarely matters; both do. */
export const areBlocked = async (userA, userB) => {
  const { rows } = await pool.query(
    `SELECT blocker_id FROM user_blocks
      WHERE (blocker_id = $1 AND blocked_id = $2)
         OR (blocker_id = $2 AND blocked_id = $1)
      LIMIT 1`,
    [userA, userB],
  );
  if (rows.length === 0) return { blocked: false, by: null };
  return { blocked: true, by: rows[0].blocker_id };
};

export const hasBlocked = async ({ blockerId, blockedId }) => {
  const { rows } = await pool.query(
    `SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2 LIMIT 1`,
    [blockerId, blockedId],
  );
  return rows.length > 0;
};

export const create = async ({ blockerId, blockedId, reason = null }) => {
  if (blockerId === blockedId) {
    throw Object.assign(new Error('you cannot block yourself'), { code: 'validation_failed' });
  }

  const { rows } = await pool.query(
    `INSERT INTO user_blocks (blocker_id, blocked_id, reason, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET reason = EXCLUDED.reason
     RETURNING blocker_id, blocked_id, reason, created_at`,
    [blockerId, blockedId, reason],
  );
  return rows[0];
};

export const remove = async ({ blockerId, blockedId }) => {
  const { rowCount } = await pool.query(
    `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
    [blockerId, blockedId],
  );
  return rowCount > 0;
};

export const listFor = async ({ blockerId, cursor, limit = 25 }) => {
  const params = [blockerId, limit + 1];
  let where = 'ub.blocker_id = $1';

  if (cursor) {
    params.push(cursor);
    where += ` AND ub.created_at < $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT ub.blocked_id, ub.reason, ub.created_at,
            p.display_name, p.avatar_url
       FROM user_blocks ub
       LEFT JOIN profiles p ON p.user_id = ub.blocked_id
      WHERE ${where}
      ORDER BY ub.created_at DESC
      LIMIT $2`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: page.map((row) => ({
      blockedUserId: row.blocked_id,
      blockedAt: row.created_at,
      reason: row.reason,
      profile: {
        userId: row.blocked_id,
        displayName: row.display_name ?? 'Unknown',
        avatarUrl: row.avatar_url ?? null,
      },
    })),
    hasMore,
    nextCursor: hasMore ? page.at(-1)?.created_at ?? null : null,
  };
};

/**
 * Everyone this person has blocked or been blocked by. Loaded once per socket
 * connection and cached there, so a busy channel does not query per message.
 */
export const allRelatedIds = async (userId) => {
  const { rows } = await pool.query(
    `SELECT blocked_id AS other FROM user_blocks WHERE blocker_id = $1
     UNION
     SELECT blocker_id AS other FROM user_blocks WHERE blocked_id = $1`,
    [userId],
  );
  return new Set(rows.map((row) => row.other));
};

export default { areBlocked, hasBlocked, create, remove, listFor, allRelatedIds };