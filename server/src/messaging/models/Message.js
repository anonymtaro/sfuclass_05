// classroom-app/server/src/messaging/models/Message.js
/**
 * Message  (F6)
 *
 * One table for every surface. A direct message, a post in the public lobby and
 * a line in a live lesson differ only in what they are addressed to, so they
 * differ only in which of three columns is populated:
 *
 *   conversation_id   a direct or group conversation
 *   channel_id        the public lobby, a space channel, a course channel
 *   room_id           the chat panel of a live lesson
 *
 * Exactly one is non-null; a check constraint in 008_messaging.sql enforces it.
 * One table means one moderation path, one search index, one retention rule and
 * one set of pagination code — which is the entire reason not to split them.
 *
 * Ordering and pagination rely on message_id being a UUIDv7: it sorts by
 * creation time, so `(created_at, message_id)` is a stable keyset without a
 * second sort column and without ties.
 */

import { pool } from '../../db/pool.js';

const SELECT = `
  m.message_id, m.target_kind, m.conversation_id, m.channel_id, m.room_id,
  m.author_id, m.kind, m.body, m.reply_to_id, m.client_message_id,
  m.created_at, m.edited_at, m.deleted_at, m.deleted_by,
  p.display_name AS author_display_name, p.avatar_url AS author_avatar_url
`;

const FROM = `
  FROM messages m
  LEFT JOIN profiles p ON p.user_id = m.author_id
`;

/** Rebuilds the contract's discriminated union from the three columns. */
const targetOf = (row) => {
  switch (row.target_kind) {
    case 'conversation':
      return { kind: 'conversation', conversationId: row.conversation_id };
    case 'channel':
      return { kind: 'channel', channelId: row.channel_id };
    default:
      return { kind: 'room', roomId: row.room_id };
  }
};

/**
 * A deleted message keeps its row for the audit trail. Body and attachments are
 * cleared here rather than in the database, so a moderator query can still see
 * what was removed while a client cannot.
 */
export const toMessage = (row, { attachments = [], reactions = [], viewerId = null } = {}) => {
  const deleted = Boolean(row.deleted_at);

  return {
    messageId: row.message_id,
    target: targetOf(row),
    kind: row.kind,
    author: row.author_id
      ? {
          userId: row.author_id,
          displayName: row.author_display_name ?? 'Unknown',
          avatarUrl: row.author_avatar_url ?? null,
        }
      : null,
    body: deleted ? '' : row.body,
    mentions: [],
    attachments: deleted ? [] : attachments,
    replyToId: row.reply_to_id,
    reactions: reactions.map((reaction) => ({
      emoji: reaction.emoji,
      count: Number(reaction.count),
      reacted: viewerId ? reaction.user_ids?.includes(viewerId) ?? false : false,
    })),
    clientMessageId: row.client_message_id,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    createdAt: row.created_at,
  };
};

// ---------------------------------------------------------------------------
// Keyset cursors
// ---------------------------------------------------------------------------

/**
 * Opaque to clients, deliberately: the sort key can change later without
 * breaking a released mobile build that stored one.
 */
export const encodeCursor = (row) =>
  Buffer.from(`${new Date(row.created_at).toISOString()}|${row.message_id}`).toString('base64url');

export const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const [createdAt, messageId] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!createdAt || !messageId) return null;
    return { createdAt, messageId };
  } catch {
    return null;
  }
};

const targetClause = (target, params) => {
  switch (target.kind) {
    case 'conversation':
      params.push(target.conversationId);
      return `m.conversation_id = $${params.length}`;
    case 'channel':
      params.push(target.channelId);
      return `m.channel_id = $${params.length}`;
    default:
      params.push(target.roomId);
      return `m.room_id = $${params.length}`;
  }
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const findById = async (messageId) => {
  const { rows } = await pool.query(`SELECT ${SELECT} ${FROM} WHERE m.message_id = $1`, [messageId]);
  return rows[0] ?? null;
};

/**
 * One page of history, newest first — the efficient direction for the index.
 * Clients reverse it for display; that reversal lives in one place, in useChat.
 */
export const listByTarget = async ({ target, cursor, limit = 25, order = 'desc' }) => {
  const params = [];
  const where = [targetClause(target, params)];

  const decoded = decodeCursor(cursor);
  if (decoded) {
    params.push(decoded.createdAt, decoded.messageId);
    const comparison = order === 'desc' ? '<' : '>';
    // Row-value comparison, so the index on (created_at, message_id) is used
    // and two messages in the same millisecond never collide.
    where.push(`(m.created_at, m.message_id) ${comparison} ($${params.length - 1}, $${params.length})`);
  }

  params.push(limit + 1);

  const { rows } = await pool.query(
    `SELECT ${SELECT} ${FROM}
      WHERE ${where.join(' AND ')}
      ORDER BY m.created_at ${order === 'desc' ? 'DESC' : 'ASC'}, m.message_id ${order === 'desc' ? 'DESC' : 'ASC'}
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    rows: page,
    hasMore,
    nextCursor: hasMore && page.length > 0 ? encodeCursor(page.at(-1)) : null,
  };
};

/** The page containing a specific message, for a search hit or a reply link. */
export const listAround = async ({ target, messageId, limit = 25 }) => {
  const anchor = await findById(messageId);
  if (!anchor) return { rows: [], hasMore: false, nextCursor: null };

  const half = Math.floor(limit / 2);
  const params = [];
  const clause = targetClause(target, params);
  params.push(anchor.created_at, half);

  const { rows } = await pool.query(
    `(SELECT ${SELECT} ${FROM} WHERE ${clause} AND m.created_at <= $${params.length - 1}
        ORDER BY m.created_at DESC LIMIT $${params.length})
     UNION ALL
     (SELECT ${SELECT} ${FROM} WHERE ${clause} AND m.created_at > $${params.length - 1}
        ORDER BY m.created_at ASC LIMIT $${params.length})
     ORDER BY created_at ASC`,
    params,
  );

  return { rows, hasMore: false, nextCursor: null };
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Insert, or return the existing row for the same client_message_id.
 *
 * This is what makes the whole delivery story work: the socket send, the HTTP
 * retry and the offline outbox replay all carry the same key, so a message that
 * arrives three times is stored once. `ON CONFLICT DO UPDATE` rather than
 * `DO NOTHING` because RETURNING is empty on a no-op conflict, and the caller
 * needs the row either way.
 */
export const insert = async ({
  messageId,
  tenantId,
  target,
  authorId,
  kind = 'text',
  body,
  replyToId = null,
  clientMessageId = null,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO messages (
        message_id, tenant_id, target_kind, conversation_id, channel_id, room_id,
        author_id, kind, body, reply_to_id, client_message_id, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (author_id, client_message_id) WHERE client_message_id IS NOT NULL
     DO UPDATE SET body = messages.body
     RETURNING message_id`,
    [
      messageId,
      tenantId,
      target.kind,
      target.kind === 'conversation' ? target.conversationId : null,
      target.kind === 'channel' ? target.channelId : null,
      target.kind === 'room' ? target.roomId : null,
      authorId,
      kind,
      body,
      replyToId,
      clientMessageId,
    ],
  );

  return findById(rows[0].message_id);
};

export const update = async ({ messageId, body }) => {
  const { rows } = await pool.query(
    `UPDATE messages SET body = $2, edited_at = now()
      WHERE message_id = $1 AND deleted_at IS NULL
      RETURNING message_id`,
    [messageId, body],
  );
  return rows[0] ? findById(messageId) : null;
};

/** Soft delete. The row survives; the content does not. */
export const softDelete = async ({ messageId, deletedBy }) => {
  const { rows } = await pool.query(
    `UPDATE messages
        SET deleted_at = now(), deleted_by = $2, body = ''
      WHERE message_id = $1 AND deleted_at IS NULL
      RETURNING message_id, deleted_at`,
    [messageId, deletedBy],
  );
  return rows[0] ?? null;
};

/** Retention sweep. Returns the ids so their attachments can be reaped too. */
export const deleteOlderThan = async ({ days, limit = 1_000 }) => {
  const { rows } = await pool.query(
    `DELETE FROM messages
      WHERE message_id IN (
        SELECT message_id FROM messages
         WHERE created_at < now() - ($1 || ' days')::interval
         ORDER BY created_at ASC LIMIT $2
      )
      RETURNING message_id`,
    [days, limit],
  );
  return rows.map((row) => row.message_id);
};

export const countSince = async ({ target, since, excludeAuthorId }) => {
  const params = [];
  const clause = targetClause(target, params);
  params.push(since ?? new Date(0).toISOString(), excludeAuthorId ?? null);

  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM messages m
      WHERE ${clause}
        AND m.created_at > $${params.length - 1}
        AND m.deleted_at IS NULL
        AND ($${params.length}::uuid IS NULL OR m.author_id <> $${params.length})`,
    params,
  );
  return rows[0]?.count ?? 0;
};

export default { toMessage, insert, update, softDelete, listByTarget, findById };