// classroom-app/server/src/messaging/models/Conversation.js
/**
 * Conversation  (F6)
 *
 * A participant set. A 1:1 chat and a small group chat are the same object with
 * a different size, which is why there is no separate "DirectMessage" table.
 *
 * The one piece of real machinery here is `findDirectBetween`. Opening a DM from
 * a profile card must be idempotent — a double-tap cannot produce two threads
 * with the same person — and the obvious implementations are all subtly wrong:
 * a `participant_key` column drifts when someone leaves, and a self-join
 * without the cardinality check matches any group that happens to contain both
 * people. The query below requires the conversation to be direct, to contain
 * both, and to contain nobody else.
 */

import { pool } from '../../db/pool.js';

const SELECT = `
  c.conversation_id, c.kind, c.title, c.created_by,
  c.created_at, c.updated_at, c.last_message_at, c.archived_at
`;

export const toConversation = (row, { participants = [], unreadCount = 0, muted = false, lastMessage = null }) => ({
  conversationId: row.conversation_id,
  kind: row.kind,
  title: row.title,
  participants,
  createdBy: row.created_by,
  lastMessage,
  lastMessageAt: row.last_message_at,
  unreadCount,
  muted,
  archived: Boolean(row.archived_at),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const findById = async (conversationId) => {
  const { rows } = await pool.query(
    `SELECT ${SELECT} FROM conversations c WHERE c.conversation_id = $1`,
    [conversationId],
  );
  return rows[0] ?? null;
};

/**
 * The existing 1:1 between two people, or null.
 *
 * `having count(*) = 2` is the part that matters: without it, a group
 * containing both of them would match and the next direct message would land
 * in the wrong thread.
 */
export const findDirectBetween = async (userA, userB) => {
  const { rows } = await pool.query(
    `SELECT ${SELECT}
       FROM conversations c
       JOIN conversation_participants p ON p.conversation_id = c.conversation_id
      WHERE c.kind = 'direct'
        AND c.archived_at IS NULL
        AND p.left_at IS NULL
      GROUP BY c.conversation_id, c.kind, c.title, c.created_by,
               c.created_at, c.updated_at, c.last_message_at, c.archived_at
     HAVING count(*) = 2
        AND bool_or(p.user_id = $1)
        AND bool_or(p.user_id = $2)
      LIMIT 1`,
    [userA, userB],
  );
  return rows[0] ?? null;
};

/**
 * Creates a conversation and its participants in one transaction. A
 * conversation with no participants is unreachable, so the two writes must
 * succeed or fail together.
 */
export const create = async ({ conversationId, tenantId, kind, title = null, createdBy, participantIds }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO conversations (conversation_id, tenant_id, kind, title, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())`,
      [conversationId, tenantId, kind, title, createdBy],
    );

    // One statement rather than a loop: a group of fifty would otherwise be
    // fifty round trips inside a transaction.
    await client.query(
      `INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
       SELECT $1, unnest($2::uuid[]), 'member', now()`,
      [conversationId, participantIds],
    );

    await client.query(
      `UPDATE conversation_participants SET role = 'owner'
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, createdBy],
    );

    await client.query('COMMIT');
  } catch (cause) {
    await client.query('ROLLBACK');
    throw cause;
  } finally {
    client.release();
  }

  return findById(conversationId);
};

/**
 * A person's conversations, most recently active first, with their unread
 * count computed in the same query — the list screen would otherwise be one
 * query plus one per row.
 */
export const listForUser = async ({ userId, cursor, limit = 25, archived = false }) => {
  const params = [userId, limit + 1];
  const where = [
    'p.user_id = $1',
    'p.left_at IS NULL',
    archived ? 'c.archived_at IS NOT NULL' : 'c.archived_at IS NULL',
  ];

  if (cursor) {
    params.push(cursor);
    where.push(`c.last_message_at < $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT ${SELECT}, p.muted, p.last_read_at,
            (SELECT count(*)::int FROM messages m
              WHERE m.conversation_id = c.conversation_id
                AND m.deleted_at IS NULL
                AND m.author_id <> $1
                AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)
            ) AS unread_count
       FROM conversations c
       JOIN conversation_participants p ON p.conversation_id = c.conversation_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $2`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    rows: page,
    hasMore,
    nextCursor: hasMore ? page.at(-1)?.last_message_at ?? null : null,
  };
};

/** Keeps the conversation list ordered without a join on every read. */
export const touch = async (conversationId) => {
  await pool.query(
    `UPDATE conversations SET last_message_at = now(), updated_at = now()
      WHERE conversation_id = $1`,
    [conversationId],
  );
};

export const setArchived = async (conversationId, archived) => {
  await pool.query(
    `UPDATE conversations SET archived_at = $2, updated_at = now() WHERE conversation_id = $1`,
    [conversationId, archived ? new Date().toISOString() : null],
  );
};

export default { findById, findDirectBetween, create, listForUser, touch, toConversation };