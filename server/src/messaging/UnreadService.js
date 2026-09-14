// classroom-app/server/src/messaging/UnreadService.js
/**
 * Unread counters  (F6)
 *
 * Redis, not Postgres. A badge is read on every app open and every socket
 * reconnect, and computing it from the messages table means a count query per
 * conversation per read — which on a person with forty threads is forty queries
 * to render one number.
 *
 * Redis holds the counters; Postgres holds the truth. The counters are derived
 * data and are rebuilt from `last_read_at` whenever they are missing, which
 * makes a Redis flush a performance event rather than a correctness one.
 *
 * Counters are per user per target, in a hash, so the whole badge state is one
 * HGETALL.
 */

import { env } from '../config/env.js';
import { redis } from '../db/redis.js';
import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'unread' });

const key = (userId) => `${env.REDIS_PREFIX}:unread:${userId}`;
const mentionKey = (userId) => `${env.REDIS_PREFIX}:mentions:${userId}`;

/** Stable string for a target, used as the hash field. */
const fieldOf = (target) => {
  switch (target.kind) {
    case 'conversation':
      return `c:${target.conversationId}`;
    case 'channel':
      return `ch:${target.channelId}`;
    default:
      return `r:${target.roomId}`;
  }
};

/** A counter that is never read again should not live forever. */
const TTL_SEC = 90 * 86_400;

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * One message arrived. Increments everyone's counter except the author's, and
 * flags a mention separately so the badge can be red rather than grey.
 */
export const incrementUnread = async ({ target, authorId, recipients = [], message }) => {
  const field = fieldOf(target);

  // For a channel the recipient list is "everyone in scope", which can be the
  // whole tenant. Materialising it per message would be the most expensive
  // thing in the product, so channels count lazily instead: the counter is
  // computed from last_read_at when the client asks.
  if (target.kind === 'channel') return;

  const mentioned = new Set((message?.mentions ?? []).map((mention) => mention.userId));

  const pipeline = redis.pipeline();
  for (const userId of recipients) {
    if (userId === authorId) continue;
    pipeline.hincrby(key(userId), field, 1);
    pipeline.expire(key(userId), TTL_SEC);
    if (mentioned.has(userId)) {
      pipeline.hincrby(mentionKey(userId), field, 1);
      pipeline.expire(mentionKey(userId), TTL_SEC);
    }
  }

  await pipeline.exec();
};

/** Reading a thread clears it. The read position in Postgres moves too. */
export const clear = async ({ userId, target }) => {
  const field = fieldOf(target);
  await redis.multi().hdel(key(userId), field).hdel(mentionKey(userId), field).exec();
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The badge. Direct conversations come from Redis; channels are computed,
 * because their audience is a scope rather than a list.
 */
export const summary = async ({ userId }) => {
  const [counters, mentions] = await Promise.all([
    redis.hgetall(key(userId)),
    redis.hgetall(mentionKey(userId)),
  ]);

  let conversations = 0;
  for (const [field, value] of Object.entries(counters)) {
    if (field.startsWith('c:')) conversations += Number(value) || 0;
  }

  const channels = await channelUnread(userId);

  return {
    total: conversations + channels.total,
    conversations,
    channels: channels.total,
    mentions: Object.values(mentions).reduce((sum, value) => sum + (Number(value) || 0), 0),
  };
};

/**
 * Channel counts, in one query across every channel the person can see. Still
 * a count, but one round trip rather than one per channel, and only when the
 * client actually asks for the badge.
 */
const channelUnread = async (userId) => {
  const { rows } = await pool.query(
    `SELECT ch.channel_id, count(m.message_id)::int AS unread
       FROM channels ch
       LEFT JOIN channel_members cm ON cm.channel_id = ch.channel_id AND cm.user_id = $1
       LEFT JOIN messages m ON m.channel_id = ch.channel_id
            AND m.deleted_at IS NULL
            AND m.author_id <> $1
            AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
      WHERE ch.archived_at IS NULL
        AND coalesce(cm.muted, false) = false
        AND (
          ch.scope = 'public'
          OR (ch.scope = 'space'  AND ch.scope_ref_id IN (SELECT space_id  FROM space_memberships WHERE user_id = $1))
          OR (ch.scope = 'course' AND ch.scope_ref_id IN (SELECT course_id FROM enrollments       WHERE user_id = $1 AND status = 'active'))
        )
      GROUP BY ch.channel_id`,
    [userId],
  );

  return {
    total: rows.reduce((sum, row) => sum + row.unread, 0),
    byChannel: Object.fromEntries(rows.map((row) => [row.channel_id, row.unread])),
  };
};

/** Per-target counts, for the conversation list. */
export const perTarget = async ({ userId }) => {
  const counters = await redis.hgetall(key(userId));
  const mentions = await redis.hgetall(mentionKey(userId));
  const channels = await channelUnread(userId);

  const targets = Object.entries(counters).map(([field, value]) => ({
    field,
    unreadCount: Number(value) || 0,
    mentioned: Number(mentions[field] ?? 0) > 0,
  }));

  for (const [channelId, unread] of Object.entries(channels.byChannel)) {
    if (unread > 0) targets.push({ field: `ch:${channelId}`, unreadCount: unread, mentioned: false });
  }

  return targets;
};

/**
 * Rebuilds a person's counters from Postgres. Called after a Redis flush and by
 * the maintenance worker; the counters are derived data, so this is always safe
 * to run.
 */
export const rebuild = async ({ userId }) => {
  const { rows } = await pool.query(
    `SELECT cp.conversation_id,
            count(m.message_id)::int AS unread
       FROM conversation_participants cp
       LEFT JOIN messages m ON m.conversation_id = cp.conversation_id
            AND m.deleted_at IS NULL
            AND m.author_id <> $1
            AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)
      WHERE cp.user_id = $1 AND cp.left_at IS NULL
      GROUP BY cp.conversation_id`,
    [userId],
  );

  const pipeline = redis.pipeline();
  pipeline.del(key(userId));
  for (const row of rows) {
    if (row.unread > 0) pipeline.hset(key(userId), `c:${row.conversation_id}`, row.unread);
  }
  pipeline.expire(key(userId), TTL_SEC);
  await pipeline.exec();

  log.debug({ userId, conversations: rows.length }, 'unread counters rebuilt');
  return rows.length;
};

export default { incrementUnread, clear, summary, perTarget, rebuild };