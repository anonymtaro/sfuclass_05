// classroom-app/server/src/messaging/models/Receipt.js
/**
 * Read and delivery receipts  (F6)
 *
 * Only for direct conversations, and only when both people have receipts on.
 *
 * Two deliberate limits:
 *
 *   Receipts are mutual. Someone who switches `sendReadReceipts` off stops
 *   sending them *and* stops seeing other people's. Otherwise the setting is a
 *   way to read without being seen to read, which is not a feature anyone asks
 *   for honestly.
 *
 *   Channels have none. "Seen by 47 people" is noise, and storing a row per
 *   member per message in the public lobby would dwarf the messages table. The
 *   unread counter is enough there.
 *
 * The per-message row exists because a DM needs to show a marker against a
 * specific message. The coarse read position on the participant row stays the
 * source of truth for counting; this is the fine-grained view on top.
 */

import { pool } from '../../db/pool.js';

/**
 * Marks everything up to and including a message as read, in one statement.
 *
 * A client reading a thread has read every message above the one at the bottom
 * of the screen, so inserting one row per message is both correct and what the
 * UI needs — but only for messages that were not already marked.
 */
export const markReadThrough = async ({ conversationId, userId, messageId, readAt }) => {
  const { rows } = await pool.query(
    `INSERT INTO message_receipts (message_id, user_id, read_at)
     SELECT m.message_id, $2, $4::timestamptz
       FROM messages m
      WHERE m.conversation_id = $1
        AND m.author_id <> $2
        AND m.deleted_at IS NULL
        AND m.created_at <= (SELECT created_at FROM messages WHERE message_id = $3)
        AND NOT EXISTS (
          SELECT 1 FROM message_receipts r
           WHERE r.message_id = m.message_id AND r.user_id = $2 AND r.read_at IS NOT NULL
        )
     ON CONFLICT (message_id, user_id) DO UPDATE SET read_at = EXCLUDED.read_at
     RETURNING message_id`,
    [conversationId, userId, messageId, readAt],
  );
  return rows.length;
};

/**
 * Delivered, not read: the message reached a device. Set when a socket
 * acknowledges it, which is why it is cheap enough to do per message.
 */
export const markDelivered = async ({ messageId, userId }) => {
  await pool.query(
    `INSERT INTO message_receipts (message_id, user_id, delivered_at)
     VALUES ($1, $2, now())
     ON CONFLICT (message_id, user_id)
     DO UPDATE SET delivered_at = coalesce(message_receipts.delivered_at, now())`,
    [messageId, userId],
  );
};

/**
 * Who has read each message in a page. Respects the reader's own setting: a
 * person who does not send receipts does not appear here.
 */
export const listForMessages = async (messageIds) => {
  if (messageIds.length === 0) return new Map();

  const { rows } = await pool.query(
    `SELECT r.message_id, r.user_id, r.read_at, r.delivered_at
       FROM message_receipts r
       JOIN profiles p ON p.user_id = r.user_id
      WHERE r.message_id = ANY($1::uuid[])
        AND r.read_at IS NOT NULL
        AND coalesce((p.privacy->>'sendReadReceipts')::boolean, true) = true`,
    [messageIds],
  );

  const byMessage = new Map();
  for (const row of rows) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push({ userId: row.user_id, readAt: row.read_at, deliveredAt: row.delivered_at });
    byMessage.set(row.message_id, list);
  }
  return byMessage;
};

/** The furthest message the other person has read, for the marker position. */
export const lastReadMessage = async ({ conversationId, userId }) => {
  const { rows } = await pool.query(
    `SELECT r.message_id, r.read_at
       FROM message_receipts r
       JOIN messages m ON m.message_id = r.message_id
      WHERE m.conversation_id = $1 AND r.user_id = $2 AND r.read_at IS NOT NULL
      ORDER BY m.created_at DESC
      LIMIT 1`,
    [conversationId, userId],
  );
  return rows[0] ?? null;
};

/** Whether receipts apply at all between these people. */
export const receiptsEnabled = async (userIds) => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS opted_out
       FROM profiles
      WHERE user_id = ANY($1::uuid[])
        AND coalesce((privacy->>'sendReadReceipts')::boolean, true) = false`,
    [userIds],
  );
  return (rows[0]?.opted_out ?? 0) === 0;
};

export default { markReadThrough, markDelivered, listForMessages, receiptsEnabled };