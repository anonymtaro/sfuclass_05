// classroom-app/server/src/messaging/models/Channel.js
/**
 * Channel  (F6)
 *
 * The public side of messaging. Three scopes, one table:
 *
 *   public   the tenant-wide lobby. Exactly one per tenant, created on setup.
 *   space    bound to a community space, auto-provisioned with it
 *   course   bound to a course, auto-provisioned on publish
 *
 * The difference from a Conversation is who can read it. A conversation has a
 * participant set; a channel has a scope, and everyone inside that scope can
 * read it — including history from before they joined. That last part is the
 * point of a channel: a learner who enrols in week six can read weeks one to
 * five.
 *
 * Membership rows exist, but they carry preferences (mute, last read), not
 * permission. Deleting one does not remove access.
 */

import { pool } from '../../db/pool.js';

const SELECT = `
  ch.channel_id, ch.scope, ch.scope_ref_id, ch.name, ch.topic,
  ch.read_only, ch.slow_mode_sec, ch.created_at, ch.updated_at, ch.archived_at
`;

export const toChannel = (row, { unreadCount = 0, muted = false, memberCount = 0 }) => ({
  channelId: row.channel_id,
  scope: row.scope,
  scopeRefId: row.scope_ref_id,
  name: row.name,
  topic: row.topic,
  readOnly: row.read_only,
  slowModeSec: row.slow_mode_sec,
  memberCount,
  unreadCount,
  lastMessageAt: row.last_message_at ?? null,
  muted,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const findById = async (channelId) => {
  const { rows } = await pool.query(`SELECT ${SELECT} FROM channels ch WHERE ch.channel_id = $1`, [
    channelId,
  ]);
  return rows[0] ?? null;
};

/** The tenant lobby. Every member can post here; it is the default channel. */
export const findPublicLobby = async (tenantId) => {
  const { rows } = await pool.query(
    `SELECT ${SELECT} FROM channels ch WHERE ch.tenant_id = $1 AND ch.scope = 'public' LIMIT 1`,
    [tenantId],
  );
  return rows[0] ?? null;
};

export const findByScope = async ({ scope, scopeRefId }) => {
  const { rows } = await pool.query(
    `SELECT ${SELECT} FROM channels ch WHERE ch.scope = $1 AND ch.scope_ref_id = $2 LIMIT 1`,
    [scope, scopeRefId],
  );
  return rows[0] ?? null;
};

/**
 * Idempotent by design: SpaceService and CourseService both call this on
 * publish, and a republish must not create a second channel.
 */
export const ensureForScope = async ({ channelId, tenantId, scope, scopeRefId, name }) => {
  const { rows } = await pool.query(
    `INSERT INTO channels (channel_id, tenant_id, scope, scope_ref_id, name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (scope, scope_ref_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING channel_id`,
    [channelId, tenantId, scope, scopeRefId, name],
  );
  return findById(rows[0].channel_id);
};

/**
 * Channels a person can see: the lobby, plus one per space and course they
 * belong to. Permission comes from those memberships, not from this table.
 */
export const listForUser = async ({ userId, tenantId, scope = null, limit = 50 }) => {
  const params = [userId, tenantId, limit];
  const scopeFilter = scope ? 'AND ch.scope = $4' : '';
  if (scope) params.push(scope);

  const { rows } = await pool.query(
    `SELECT ${SELECT}, cm.muted, cm.last_read_at,
            (SELECT max(m.created_at) FROM messages m WHERE m.channel_id = ch.channel_id) AS last_message_at,
            (SELECT count(*)::int FROM messages m
              WHERE m.channel_id = ch.channel_id
                AND m.deleted_at IS NULL
                AND m.author_id <> $1
                AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
            ) AS unread_count
       FROM channels ch
       LEFT JOIN channel_members cm ON cm.channel_id = ch.channel_id AND cm.user_id = $1
      WHERE ch.tenant_id = $2
        AND ch.archived_at IS NULL
        AND (
          ch.scope = 'public'
          OR (ch.scope = 'space'  AND ch.scope_ref_id IN (SELECT space_id  FROM space_memberships WHERE user_id = $1))
          OR (ch.scope = 'course' AND ch.scope_ref_id IN (SELECT course_id FROM enrollments       WHERE user_id = $1 AND status = 'active'))
        )
        ${scopeFilter}
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT $3`,
    params,
  );

  return rows;
};

/**
 * Whether this person may read the channel. Asked on every history fetch and
 * every socket subscribe, so it is one query and no joins beyond the scope.
 */
export const canRead = async ({ channelId, userId }) => {
  const { rows } = await pool.query(
    `SELECT 1 FROM channels ch
      WHERE ch.channel_id = $1
        AND ch.archived_at IS NULL
        AND (
          ch.scope = 'public'
          OR (ch.scope = 'space'  AND ch.scope_ref_id IN (SELECT space_id  FROM space_memberships WHERE user_id = $2))
          OR (ch.scope = 'course' AND ch.scope_ref_id IN (SELECT course_id FROM enrollments       WHERE user_id = $2 AND status = 'active'))
        )
      LIMIT 1`,
    [channelId, userId],
  );
  return rows.length > 0;
};

export const setSlowMode = async (channelId, seconds) => {
  await pool.query(
    `UPDATE channels SET slow_mode_sec = $2, updated_at = now() WHERE channel_id = $1`,
    [channelId, seconds],
  );
  return findById(channelId);
};

export const memberCount = async (channelId) => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM channel_members WHERE channel_id = $1`,
    [channelId],
  );
  return rows[0]?.count ?? 0;
};

export default { findById, findPublicLobby, ensureForScope, listForUser, canRead, toChannel };