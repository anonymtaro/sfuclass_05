/**
 * queues/connection — shared Redis connection and prefixes. (F7)
 *
 * BullMQ has connection rules that are easy to violate by accident and painful to debug:
 *
 *  - A Worker holds a *blocking* connection (BRPOPLPUSH). It cannot be shared with a
 *    Queue, and it must have `maxRetriesPerRequest: null`, or ioredis aborts the blocking
 *    command mid-wait and the worker silently stops taking jobs.
 *  - Queues can share one connection. Workers cannot share with each other either, so
 *    each gets its own — that is the connection count to size ElastiCache against.
 *  - Every key is prefixed. The prefix is wrapped in a hash tag `{…}` so that, if the
 *    cluster is ever moved to cluster mode, a queue's keys land on one slot instead of
 *    failing with CROSSSLOT.
 *
 * This module also owns shutdown: lifecycle/gracefulShutdown.js calls closeConnections()
 * after the workers have drained, and nothing else closes a connection directly.
 */

import IORedis from 'ioredis';

import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';

/** All BullMQ keys live under this. Separate from the app's own Redis key prefixes. */
export const QUEUE_PREFIX = `{${env.REDIS_PREFIX ?? 'cp'}:bull}`;

const baseOptions = () => ({
  ...(env.REDIS_TLS ? { tls: { servername: new URL(env.REDIS_URL).hostname } } : {}),
  lazyConnect: false,
  connectTimeout: 10_000,
  keepAlive: 30_000,
  // Retries are for a failover, not for a dead cluster: back off and keep trying, because
  // an ElastiCache failover takes tens of seconds and the worker should survive it.
  retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  reconnectOnError: (error) => {
    // READONLY means we reconnected to a replica mid-failover; force a fresh handshake.
    if (error.message.includes('READONLY')) return 2;
    return false;
  },
});

const pool = new Set();

function track(name, connection) {
  connection.on('error', (error) => logger.error({ err: error, connection: name }, 'queues: redis error'));
  connection.on('end', () => logger.warn({ connection: name }, 'queues: redis connection ended'));
  connection.on('reconnecting', (delay) => logger.warn({ connection: name, delay }, 'queues: redis reconnecting'));
  pool.add(connection);
  return connection;
}

let sharedQueueConnection = null;

/** One connection for every Queue and QueueEvents instance. Non-blocking, safe to share. */
export function queueConnection() {
  if (!sharedQueueConnection) {
    sharedQueueConnection = track('queues', new IORedis(env.REDIS_URL, baseOptions()));
  }
  return sharedQueueConnection;
}

/**
 * A dedicated blocking connection per worker.
 * `maxRetriesPerRequest: null` is required — with the ioredis default, a worker stops
 * consuming after a brief network blip and looks alive while doing nothing.
 */
export function workerConnection(name) {
  return track(`worker:${name}`, new IORedis(env.REDIS_URL, {
    ...baseOptions(),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  }));
}

/** Plain connection for things that are not BullMQ (rate limit counters in a job, locks). */
export function utilityConnection(name = 'utility') {
  return track(name, new IORedis(env.REDIS_URL, baseOptions()));
}

/**
 * A single-runner lock, for scheduled jobs that must not double-fire when EventBridge
 * delivers twice or two tasks wake at the same moment.
 *
 * @returns {Promise<null | (() => Promise<void>)>} release function, or null if not acquired
 */
export async function acquireLock(key, ttlMs = 60_000) {
  const client = queueConnection();
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const lockKey = `${QUEUE_PREFIX}:lock:${key}`;

  const acquired = await client.set(lockKey, token, 'PX', ttlMs, 'NX');
  if (!acquired) return null;

  return async () => {
    // Compare-and-delete: never release a lock that has already expired and been retaken.
    await client.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      lockKey,
      token,
    );
  };
}

export async function pingRedis() {
  const started = Date.now();
  await queueConnection().ping();
  return { ok: true, latencyMs: Date.now() - started };
}

/** Called by gracefulShutdown, after the workers have closed. */
export async function closeConnections() {
  const closing = [...pool].map(async (connection) => {
    try {
      await connection.quit();
    } catch {
      connection.disconnect();
    }
  });
  await Promise.allSettled(closing);
  pool.clear();
  sharedQueueConnection = null;
  logger.info('queues: redis connections closed');
}