/**
 * db/redis — application Redis client. [EXT]
 *
 * Same ElastiCache cluster as the queues, different keys. `queues/connection.js` owns the
 * BullMQ connections and their `{prefix:bull}` namespace; this file owns everything else,
 * and the two never share a client — a blocking BullMQ connection cannot be borrowed for a
 * GET, and a busy GET connection makes BullMQ's blocking reads unpredictable.
 *
 * Four uses, four prefixes, so a `SCAN` during an incident tells you what you are looking
 * at and a stray key has an owner:
 *
 *   ent:    entitlement cache (billing), TTL 60s
 *   seat:   seat reservations (the Lua script in capacity/)
 *   pres:   presence and unread counters
 *   sock:   Socket.IO adapter and per-socket rate budgets
 *
 * On eviction: presence and unread counters are reconstructible, the entitlement cache is a
 * cache, and seat reservations have their own TTL. Nothing here is the only copy of
 * anything — which is why "Redis is lost" is degraded, not down. Keep it that way: if
 * something is ever written here that Postgres does not also know, that rule is broken.
 */

import IORedis from 'ioredis';

import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';

export const PREFIX = Object.freeze({
  entitlement: `${env.REDIS_PREFIX ?? 'cp'}:ent:`,
  seat: `${env.REDIS_PREFIX ?? 'cp'}:seat:`,
  presence: `${env.REDIS_PREFIX ?? 'cp'}:pres:`,
  socket: `${env.REDIS_PREFIX ?? 'cp'}:sock:`,
  rate: `${env.REDIS_PREFIX ?? 'cp'}:rate:`,
});

/** `key(PREFIX.presence, userId)` — never build a key by hand with a template literal. */
export const key = (prefix, ...parts) => `${prefix}${parts.join(':')}`;

function options() {
  return {
    ...(env.REDIS_TLS ? { tls: { servername: new URL(env.REDIS_URL).hostname } } : {}),
    connectTimeout: 10_000,
    keepAlive: 30_000,
    // Bounded: an application read should fail fast and let the caller degrade, rather
    // than queue commands while the cluster is unreachable.
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    retryStrategy: (attempt) => {
      if (attempt > 20) return null; // give up reconnecting; the process is unhealthy
      return Math.min(attempt * 200, 5_000);
    },
    reconnectOnError: (error) => {
      // Mid-failover we can land on a replica; force a fresh handshake and retry the command.
      if (error.message.includes('READONLY')) return 2;
      return false;
    },
  };
}

const clients = new Set();

function instrument(name, client) {
  client.on('error', (error) => {
    metrics.increment?.('redis_error', 1, { client: name });
    logger.error({ err: error, client: name }, 'redis: error');
  });
  client.on('reconnecting', (delay) => logger.warn({ client: name, delay }, 'redis: reconnecting'));
  client.on('ready', () => logger.info({ client: name }, 'redis: ready'));
  clients.add(client);
  return client;
}

/** The main client. Commands only — never subscribe on this one. */
export const redis = instrument('main', new IORedis(env.REDIS_URL, options()));

/**
 * A subscriber connection can only run subscribe-family commands, so pub/sub needs its own.
 * The Socket.IO Redis adapter needs a matching pair.
 */
export function createSubscriber(name = 'subscriber') {
  return instrument(name, new IORedis(env.REDIS_URL, options()));
}

export function duplicate(name) {
  return instrument(name, redis.duplicate());
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Cache-aside with a TTL. Used for entitlements, where a 60-second stale read is fine and a
 * database round trip per request is not.
 */
export async function cached(cacheKey, ttlSeconds, produce) {
  try {
    const hit = await redis.get(cacheKey);
    if (hit !== null) {
      metrics.increment?.('redis_cache_hit');
      return JSON.parse(hit);
    }
  } catch (error) {
    // A cache that is down must not take the request with it.
    logger.warn({ err: error, cacheKey }, 'redis: cache read failed, falling through');
    return produce();
  }

  metrics.increment?.('redis_cache_miss');
  const value = await produce();
  redis.set(cacheKey, JSON.stringify(value), 'EX', ttlSeconds).catch((error) => {
    logger.warn({ err: error, cacheKey }, 'redis: cache write failed');
  });
  return value;
}

/** Delete by prefix without KEYS — SCAN in batches, so a big namespace cannot block the server. */
export async function deleteByPrefix(prefix, { batch = 500 } = {}) {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', batch);
    cursor = next;
    if (found.length > 0) {
      await redis.unlink(...found); // UNLINK, not DEL: frees memory off the main thread
      removed += found.length;
    }
  } while (cursor !== '0');
  return removed;
}

/** Used by /readyz. */
export async function ping({ timeoutMs = 2000 } = {}) {
  const started = Date.now();
  try {
    await Promise.race([
      redis.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('redis ping timed out')), timeoutMs).unref?.()),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, reason: error.message };
  }
}

export async function closeRedis() {
  await Promise.allSettled(
    [...clients].map(async (client) => {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }),
  );
  clients.clear();
  logger.info('redis: connections closed');
}

export default redis;