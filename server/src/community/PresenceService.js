// classroom-app/server/src/community/PresenceService.js
/**
 * Presence  (F2, shared with F6)  [NEW]
 *
 * One presence system for the whole platform. The community member list, the
 * chat conversation list and the classroom participant panel all read this —
 * two systems disagreeing about who is online is worse than having none.
 *
 * Redis, with a TTL per user. The TTL is the design: presence is not a flag
 * somebody sets to false on the way out, because nobody reliably leaves. A
 * closed laptop, a killed tab, a task that crashed — none of them send a
 * goodbye. A key that expires on its own turns every one of those into
 * "offline" a minute later without special handling.
 *
 * Heartbeats come from the client over the socket, not from the connection
 * being open: a socket in a background tab stays open for hours while the
 * person is somewhere else entirely.
 */

import { env } from '../config/env.js';
import { redis } from '../db/redis.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'presence' });

export const STATES = ['online', 'away', 'in-class', 'offline'];

const userKey = (userId) => `${env.REDIS_PREFIX}:presence:user:${userId}`;
const spaceKey = (spaceId) => `${env.REDIS_PREFIX}:presence:space:${spaceId}`;
const channel = `${env.REDIS_PREFIX}:presence:events`;

/** A missed heartbeat should not flicker someone offline; two should. */
const TTL_SEC = env.PRESENCE_TTL_SEC;

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Records a heartbeat. Cheap by design — this is called by every connected
 * client every thirty seconds, so it is two commands and no reads.
 *
 * `roomId` is set while the person is in a lesson, which is what lets a
 * colleague click through and join them.
 */
export const heartbeat = async ({ userId, state = 'online', roomId = null, spaceIds = [] }) => {
  const payload = JSON.stringify({ state, roomId, at: Date.now() });

  const pipeline = redis.multi().set(userKey(userId), payload, 'EX', TTL_SEC);

  // Space membership sets are what make "who is online in this space" a single
  // command instead of a scan over every member.
  for (const spaceId of spaceIds) {
    pipeline.zadd(spaceKey(spaceId), Date.now(), userId);
  }

  await pipeline.exec();

  // Published so other API tasks can push the change to their own sockets.
  await redis.publish(channel, JSON.stringify({ userId, state, roomId })).catch(() => undefined);

  return { state, roomId };
};

/**
 * Explicit sign-out or a deliberate disconnect. The TTL would handle it, but a
 * minute of stale "online" after someone closes the tab is noticeable.
 */
export const clear = async ({ userId, spaceIds = [] }) => {
  const pipeline = redis.multi().del(userKey(userId));
  for (const spaceId of spaceIds) pipeline.zrem(spaceKey(spaceId), userId);
  await pipeline.exec();

  await redis
    .publish(channel, JSON.stringify({ userId, state: 'offline', roomId: null }))
    .catch(() => undefined);
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Batch lookup. A member list of fifty people is one MGET, not fifty GETs —
 * and a missing key is 'offline' rather than an error, which is why callers
 * never have to handle a null.
 */
export const getMany = async (userIds) => {
  if (userIds.length === 0) return [];

  const raw = await redis.mget(userIds.map(userKey));

  return userIds.map((userId, index) => {
    const entry = raw[index];
    if (!entry) {
      return { userId, state: 'offline', roomId: null, updatedAt: null };
    }
    const parsed = JSON.parse(entry);
    return {
      userId,
      state: parsed.state,
      roomId: parsed.roomId,
      updatedAt: new Date(parsed.at).toISOString(),
    };
  });
};

export const get = async (userId) => (await getMany([userId]))[0];

export const isOnline = async (userId) => {
  const entry = await get(userId);
  return entry.state === 'online' || entry.state === 'in-class';
};

/**
 * How many people are in a space right now.
 *
 * The sorted set is trimmed on read rather than on a timer: entries older than
 * the TTL are removed as a side effect of the count, so a space nobody visits
 * costs nothing to keep tidy.
 */
export const spaceOnlineCount = async (spaceId) => {
  const cutoff = Date.now() - TTL_SEC * 1_000;
  await redis.zremrangebyscore(spaceKey(spaceId), 0, cutoff);
  return redis.zcard(spaceKey(spaceId));
};

/** A sample for the avatar row; the full list comes from HTTP when asked. */
export const spaceOnlineSample = async (spaceId, limit = 20) => {
  const cutoff = Date.now() - TTL_SEC * 1_000;
  await redis.zremrangebyscore(spaceKey(spaceId), 0, cutoff);
  return redis.zrevrange(spaceKey(spaceId), 0, limit - 1);
};

/** Counts for a list of spaces, in one round trip. */
export const spaceCounts = async (spaceIds) => {
  if (spaceIds.length === 0) return {};
  const cutoff = Date.now() - TTL_SEC * 1_000;

  const pipeline = redis.multi();
  for (const spaceId of spaceIds) {
    pipeline.zremrangebyscore(spaceKey(spaceId), 0, cutoff);
    pipeline.zcard(spaceKey(spaceId));
  }

  const results = await pipeline.exec();
  const counts = {};
  spaceIds.forEach((spaceId, index) => {
    // Two commands per space; the count is the second of each pair.
    counts[spaceId] = results?.[index * 2 + 1]?.[1] ?? 0;
  });
  return counts;
};

// ---------------------------------------------------------------------------
// Cross-task fan-out
// ---------------------------------------------------------------------------

/**
 * Subscribes to presence changes from every other API task. The socket
 * gateway calls this once at boot and pushes what it receives to its own
 * connected clients.
 */
export const subscribe = async (onChange) => {
  // A dedicated connection: a client in subscriber mode cannot run commands.
  const subscriber = redis.duplicate();
  await subscriber.subscribe(channel);

  subscriber.on('message', (_channel, message) => {
    try {
      onChange(JSON.parse(message));
    } catch (cause) {
      log.warn({ err: cause }, 'malformed presence event');
    }
  });

  return async () => {
    await subscriber.unsubscribe(channel);
    subscriber.disconnect();
  };
};

/**
 * The state a person should be shown as, given their privacy setting.
 * Pure, so both the socket and the HTTP path apply the same rule.
 *
 * Someone who has switched presence off is always 'offline' to others. The
 * setting hides them; it never makes them look more available than they are.
 */
export const visibleState = (entry, { showPresence = true } = {}) =>
  showPresence ? entry.state : 'offline';

export default { heartbeat, clear, get, getMany, spaceOnlineCount, spaceCounts, subscribe };