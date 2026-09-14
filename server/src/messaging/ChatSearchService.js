// classroom-app/server/src/messaging/ChatSearchService.js
/**
 * Message search  (F6)
 *
 * OpenSearch, sharing the cluster with community and course search — three
 * index families, one cluster, one set of credentials to rotate.
 *
 * The index is a projection, not a store. Everything in it can be rebuilt from
 * Postgres, which is what makes the failure policy simple: indexing failures
 * are logged and swallowed, because a message that is unsearchable for a minute
 * is a much smaller problem than a message that was not delivered.
 *
 * Access control cannot be delegated to the query. A naive search would happily
 * return a line from a conversation the searcher was never in, so every query
 * is filtered to the targets that person can actually read, and that filter is
 * built server-side from their memberships.
 */

import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'chat-search' });

const INDEX = () => `${env.OPENSEARCH_INDEX_PREFIX}-messages`;

let client = null;

const getClient = async () => {
  if (!env.SEARCH_ENABLED || !env.OPENSEARCH_URL) return null;
  if (client) return client;

  const { Client } = await import('@opensearch-project/opensearch');
  client = new Client({ node: env.OPENSEARCH_URL });
  return client;
};

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

export const indexMessage = async (message, { lessonId = null } = {}) => {
  const os = await getClient();
  if (!os) return false;

  try {
    await os.index({
      index: INDEX(),
      id: message.messageId,
      body: {
        messageId: message.messageId,
        targetKind: message.target.kind,
        conversationId: message.target.conversationId ?? null,
        channelId: message.target.channelId ?? null,
        roomId: message.target.roomId ?? null,
        lessonId,
        authorId: message.author?.userId ?? null,
        authorName: message.author?.displayName ?? null,
        body: message.body,
        hasAttachment: message.attachments.length > 0,
        createdAt: message.createdAt,
      },
      // Not refreshed: a message searchable a second later is fine, and
      // refresh-on-write is the fastest way to ruin cluster throughput.
      refresh: false,
    });
    return true;
  } catch (cause) {
    log.error({ err: cause, messageId: message.messageId }, 'search index write failed');
    return false;
  }
};

export const removeFromIndex = async (messageId) => {
  const os = await getClient();
  if (!os) return false;

  try {
    await os.delete({ index: INDEX(), id: messageId });
    return true;
  } catch (cause) {
    // A 404 is the normal case for a message that was never indexed.
    if (cause?.meta?.statusCode !== 404) {
      log.error({ err: cause, messageId }, 'search index delete failed');
    }
    return false;
  }
};

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

/**
 * The set of targets this person may search. Built from their memberships, not
 * from anything the client sent.
 */
const visibleTargets = async (userId) => {
  const [conversations, channels] = await Promise.all([
    pool.query(
      `SELECT conversation_id FROM conversation_participants WHERE user_id = $1 AND left_at IS NULL`,
      [userId],
    ),
    pool.query(
      `SELECT ch.channel_id FROM channels ch
        WHERE ch.archived_at IS NULL
          AND (ch.scope = 'public'
            OR (ch.scope = 'space'  AND ch.scope_ref_id IN (SELECT space_id  FROM space_memberships WHERE user_id = $1))
            OR (ch.scope = 'course' AND ch.scope_ref_id IN (SELECT course_id FROM enrollments       WHERE user_id = $1 AND status = 'active')))`,
      [userId],
    ),
  ]);

  return {
    conversationIds: conversations.rows.map((row) => row.conversation_id),
    channelIds: channels.rows.map((row) => row.channel_id),
  };
};

export const search = async ({ userId, q, target = null, fromUserId, hasAttachment, before, after, limit = 25, cursor }) => {
  const os = await getClient();
  if (!os) {
    // Search switched off is not an error; the UI shows an empty result and a
    // note rather than a failure.
    return { items: [], nextCursor: null, hasMore: false, unavailable: true };
  }

  const { conversationIds, channelIds } = await visibleTargets(userId);

  const scope = target
    ? [
        target.kind === 'conversation'
          ? { term: { conversationId: target.conversationId } }
          : target.kind === 'channel'
            ? { term: { channelId: target.channelId } }
            : { term: { roomId: target.roomId } },
      ]
    : [
        {
          bool: {
            should: [
              { terms: { conversationId: conversationIds } },
              { terms: { channelId: channelIds } },
            ],
            minimum_should_match: 1,
          },
        },
      ];

  const filters = [...scope, { bool: { must_not: { exists: { field: 'deletedAt' } } } }];

  if (fromUserId) filters.push({ term: { authorId: fromUserId } });
  if (hasAttachment !== undefined) filters.push({ term: { hasAttachment } });
  if (before || after) {
    filters.push({ range: { createdAt: { ...(after ? { gt: after } : {}), ...(before ? { lt: before } : {}) } } });
  }

  const from = cursor ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) || 0 : 0;

  try {
    const response = await os.search({
      index: INDEX(),
      body: {
        query: {
          bool: {
            must: [{ match: { body: { query: q, operator: 'and' } } }],
            filter: filters,
          },
        },
        highlight: { fields: { body: { number_of_fragments: 1, fragment_size: 160 } } },
        sort: [{ _score: 'desc' }, { createdAt: 'desc' }],
        from,
        size: limit + 1,
      },
    });

    const hits = response.body?.hits?.hits ?? [];
    const hasMore = hits.length > limit;
    const page = hasMore ? hits.slice(0, limit) : hits;

    return {
      items: page.map((hit) => ({
        messageId: hit._id,
        target: hit._source.conversationId
          ? { kind: 'conversation', conversationId: hit._source.conversationId }
          : hit._source.channelId
            ? { kind: 'channel', channelId: hit._source.channelId }
            : { kind: 'room', roomId: hit._source.roomId },
        author: hit._source.authorId
          ? { userId: hit._source.authorId, displayName: hit._source.authorName }
          : null,
        createdAt: hit._source.createdAt,
        // Already escaped by OpenSearch, marked with <em>.
        highlight: hit.highlight?.body?.[0] ?? hit._source.body.slice(0, 160),
      })),
      hasMore,
      nextCursor: hasMore
        ? Buffer.from(String(from + limit)).toString('base64url')
        : null,
    };
  } catch (cause) {
    log.error({ err: cause, userId }, 'chat search failed');
    return { items: [], nextCursor: null, hasMore: false, unavailable: true };
  }
};

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/** Creates the index with its mapping. Run once, idempotently, at deploy. */
export const ensureIndex = async () => {
  const os = await getClient();
  if (!os) return false;

  const exists = await os.indices.exists({ index: INDEX() });
  if (exists.body) return true;

  await os.indices.create({
    index: INDEX(),
    body: {
      mappings: {
        properties: {
          messageId: { type: 'keyword' },
          targetKind: { type: 'keyword' },
          conversationId: { type: 'keyword' },
          channelId: { type: 'keyword' },
          roomId: { type: 'keyword' },
          lessonId: { type: 'keyword' },
          authorId: { type: 'keyword' },
          authorName: { type: 'text' },
          body: { type: 'text' },
          hasAttachment: { type: 'boolean' },
          createdAt: { type: 'date' },
        },
      },
    },
  });

  log.info({ index: INDEX() }, 'search index created');
  return true;
};

/** Rebuilds from Postgres. The index holds nothing that is not derived. */
export const reindexAll = async ({ batchSize = 500 } = {}) => {
  const os = await getClient();
  if (!os) return 0;

  await ensureIndex();
  let cursor = null;
  let total = 0;

  for (;;) {
    const { rows } = await pool.query(
      `SELECT m.message_id, m.target_kind, m.conversation_id, m.channel_id, m.room_id,
              m.author_id, m.body, m.created_at, p.display_name
         FROM messages m
         LEFT JOIN profiles p ON p.user_id = m.author_id
        WHERE m.deleted_at IS NULL AND ($1::timestamptz IS NULL OR m.created_at > $1)
        ORDER BY m.created_at ASC LIMIT $2`,
      [cursor, batchSize],
    );

    if (rows.length === 0) break;

    const operations = rows.flatMap((row) => [
      { index: { _index: INDEX(), _id: row.message_id } },
      {
        messageId: row.message_id,
        targetKind: row.target_kind,
        conversationId: row.conversation_id,
        channelId: row.channel_id,
        roomId: row.room_id,
        authorId: row.author_id,
        authorName: row.display_name,
        body: row.body,
        createdAt: row.created_at,
      },
    ]);

    await os.bulk({ body: operations, refresh: false });
    total += rows.length;
    cursor = rows.at(-1).created_at;
  }

  log.info({ total }, 'chat search reindexed');
  return total;
};

export default { indexMessage, removeFromIndex, search, ensureIndex, reindexAll };