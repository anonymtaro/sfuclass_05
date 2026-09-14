// classroom-app/server/src/messaging/models/Participant.js
/**
 * Participant  (F6)
 *
 * Membership of a conversation, and the per-person preferences that go with it:
 * muted, and where they have read up to.
 *
 * `last_read_at` is a timestamp rather than a message id, which is worth
 * defending: an id would be precise but breaks when that message is deleted,
 * and a timestamp answers the only question anyone asks — "how many arrived
 * after this" — with a range scan on the index that already exists.
 *
 * Leaving sets `left_at` rather than deleting the row. Otherwise a person's own
 * messages lose their membership context, and rejoining a group would show them
 * as having read everything they missed.
 */

import { pool } from '../../db/pool.js';

export const toParticipant = (row) => ({
  userId: row.user_id,
  profile: {
    userId: row.user_id,
    displayName: row.display_name ?? 'Unknown',
    avatarUrl: row.avatar_url ?? null,
  },
  role: row.role,
  joinedAt: row.joined_at,
  lastReadAt: row.last_read_at,
  muted: row.muted,
});

export const listForConversation = async (conversationId) => {
  const { rows } = await pool.query(
    `SELECT cp.user_id, cp.role, cp.joined_at, cp.last_read_at, cp.muted,
            p.display_name, p.avatar_url
       FROM conversation_participants cp
       LEFT JOIN profiles p ON p.user_id = cp.user_id
      WHERE cp.conversation_id = $1 AND cp.left_at IS NULL
      ORDER BY cp.joined_at ASC`,
    [conversationId],
  );
  return rows;
};

export const isParticipant = async ({ conversationId, userId }) => {
  const { rows } = await pool.query(
    `SELECT 1 FROM conversation_participants
      WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL LIMIT 1`,
    [conversationId, userId],
  );
  return rows.length > 0;
};

export const add = async ({ conversationId, userId, role = 'member' }) => {
  // Rejoining reuses the row and clears left_at, so the old read position and
  // mute preference survive.
  await pool.query(
    `INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (conversation_id, user_id)
     DO UPDATE SET left_at = NULL, role = EXCLUDED.role`,
    [conversationId, userId, role],
  );
};

export const remove = async ({ conversationId, userId }) => {
  await pool.query(
    `UPDATE conversation_participants SET left_at = now()
      WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [conversationId, userId],
  );
};

export const setMuted = async ({ conversationId, userId, muted }) => {
  await pool.query(
    `UPDATE conversation_participants SET muted = $3
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId, muted],
  );
};

/**
 * Moves the read marker forward, never back. `greatest` matters: two devices
 * reading the same thread out of order would otherwise make a thread unread
 * again on the device that was ahead.
 */
export const markRead = async ({ conversationId, userId, readAt, messageId = null }) => {
  const { rows } = await pool.query(
    `UPDATE conversation_participants
        SET last_read_at = greatest(coalesce(last_read_at, to_timestamp(0)), $3::timestamptz),
            last_read_message_id = $4
      WHERE conversation_id = $1 AND user_id = $2
      RETURNING last_read_at`,
    [conversationId, userId, readAt, messageId],
  );
  return rows[0]?.last_read_at ?? null;
};

/** Channel membership carries the same preferences under a different key. */
export const markChannelRead = async ({ channelId, userId, readAt, messageId = null }) => {
  const { rows } = await pool.query(
    `INSERT INTO channel_members (channel_id, user_id, last_read_at, last_read_message_id, joined_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (channel_id, user_id)
     DO UPDATE SET last_read_at = greatest(coalesce(channel_members.last_read_at, to_timestamp(0)), EXCLUDED.last_read_at),
                   last_read_message_id = EXCLUDED.last_read_message_id
     RETURNING last_read_at`,
    [channelId, userId, readAt, messageId],
  );
  return rows[0]?.last_read_at ?? null;
};

export const setChannelMuted = async ({ channelId, userId, muted }) => {
  await pool.query(
    `INSERT INTO channel_members (channel_id, user_id, muted, joined_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (channel_id, user_id) DO UPDATE SET muted = EXCLUDED.muted`,
    [channelId, userId, muted],
  );
};

/** Who should be notified: everyone present except the author and the muted. */
export const notifiableIds = async ({ conversationId, excludeUserId }) => {
  const { rows } = await pool.query(
    `SELECT user_id FROM conversation_participants
      WHERE conversation_id = $1 AND left_at IS NULL AND muted = false AND user_id <> $2`,
    [conversationId, excludeUserId],
  );
  return rows.map((row) => row.user_id);
};

export default { listForConversation, isParticipant, add, remove, markRead, toParticipant };