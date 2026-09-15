/**
 * db/pool — PostgreSQL connection pools. [EXT] (F7)
 *
 * Three things this file is responsible for, each of which has taken a production system
 * down somewhere:
 *
 *  1. TLS is required, not preferred. `sslmode=require` alone encrypts but does not verify
 *     — it accepts any certificate, which is an encrypted connection to whoever answered.
 *     The RDS CA bundle is loaded and the hostname verified unless the environment
 *     explicitly says otherwise (a local Docker Postgres).
 *  2. The pool is capped below what the instance can take. `max` × (api tasks + worker
 *     tasks + migration task) must stay under the RDS `max_connections`, or a scale-out
 *     event locks everyone out of the database at exactly the moment traffic spiked.
 *  3. Everything times out. A statement timeout, an idle-in-transaction timeout and a
 *     connection acquire timeout. A query with no ceiling holds a connection forever, and
 *     twenty of them are an outage that looks like a slow database.
 *
 * The read replica is a separate pool. Writes never go to it — there is no automatic
 * routing here, because a silent fallback that sometimes writes to a replica fails in a
 * way nobody can reproduce. Callers ask for `readPool` explicitly.
 */

import fs from 'node:fs';
import pg from 'pg';

import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';

const { Pool, types } = pg;

/* ------------------------------------------------------------------ *
 * Type parsing
 * ------------------------------------------------------------------ */

// int8 comes back as a string by default so that values above 2^53 survive. Storage byte
// counts are int8 and are compared numerically all over this codebase, so parse them — and
// accept that anything above 9 PB would be wrong, which it will not be.
types.setTypeParser(types.builtins.INT8, (value) => (value === null ? null : Number(value)));
// numeric stays a string on purpose: money and scores must not go through a float.

/* ------------------------------------------------------------------ *
 * TLS
 * ------------------------------------------------------------------ */

function tlsConfig() {
  if (env.PGSSLMODE === 'disable') {
    if (env.NODE_ENV === 'production') {
      throw new Error('PGSSLMODE=disable is not allowed in production');
    }
    return false;
  }

  // The RDS bundle is baked into the image; no network fetch at boot.
  const caPath = env.PG_CA_BUNDLE_PATH ?? '/etc/ssl/certs/rds-combined-ca-bundle.pem';
  const ca = fs.existsSync(caPath) ? fs.readFileSync(caPath, 'utf8') : undefined;

  if (!ca && env.NODE_ENV === 'production') {
    throw new Error(`No RDS CA bundle at ${caPath}; refusing to connect without verification`);
  }

  return {
    ca,
    rejectUnauthorized: env.PGSSLMODE !== 'no-verify',
  };
}

/* ------------------------------------------------------------------ *
 * Pools
 * ------------------------------------------------------------------ */

function createPool(connectionString, { name, max, readOnly = false }) {
  const pool = new Pool({
    connectionString,
    ssl: tlsConfig(),
    max,
    min: 0,
    // Acquire timeout: fail fast rather than queue behind an exhausted pool.
    connectionTimeoutMillis: Number(env.PG_CONNECT_TIMEOUT_MS ?? 5_000),
    idleTimeoutMillis: Number(env.PG_IDLE_TIMEOUT_MS ?? 30_000),
    // Recycle connections so a long-lived task cannot pin a connection to a failed-over
    // instance, and so pgbouncer-style server-side state never accumulates.
    maxLifetimeSeconds: Number(env.PG_MAX_LIFETIME_SEC ?? 1800),
    application_name: `${env.SERVICE_NAME}${readOnly ? '-ro' : ''}@${env.RELEASE_SHA?.slice(0, 7) ?? 'dev'}`,
    statement_timeout: Number(env.PG_STATEMENT_TIMEOUT ?? 15_000),
    // A transaction left open by a crashed handler holds locks until this fires.
    idle_in_transaction_session_timeout: Number(env.PG_IDLE_TX_TIMEOUT_MS ?? 30_000),
    query_timeout: Number(env.PG_QUERY_TIMEOUT_MS ?? 20_000),
  });

  // An idle client erroring is a failover or a server-side kill, not a query failure. It
  // must be handled, or node treats it as an unhandled 'error' event and exits.
  pool.on('error', (error) => {
    metrics.increment?.('pg_idle_client_error', 1, { pool: name });
    logger.error({ err: error, pool: name }, 'db: idle client error');
  });

  pool.on('connect', () => metrics.gauge?.('pg_pool_total', pool.totalCount, { pool: name }));

  return pool;
}

/** Primary. Every write and every read that must see its own write. */
export const pool = createPool(env.DATABASE_URL, {
  name: 'primary',
  max: Number(env.PG_POOL_MAX ?? 10),
});

/**
 * Replica. Feeds, search fallback and reporting. Replica lag is real — never read something
 * here that was just written on the primary.
 */
export const readPool = env.DATABASE_READ_URL
  ? createPool(env.DATABASE_READ_URL, {
      name: 'replica',
      max: Number(env.PG_POOL_READ_MAX ?? env.PG_POOL_MAX ?? 10),
      readOnly: true,
    })
  : pool; // dev and single-instance environments read from the primary

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Query the primary. Logs anything slow enough to be worth a look. */
export async function query(text, params, { client = pool } = {}) {
  const started = Date.now();
  try {
    return await client.query(text, params);
  } finally {
    const ms = Date.now() - started;
    metrics.observe?.('pg_query_ms', ms);
    if (ms > Number(env.PG_SLOW_QUERY_MS ?? 500)) {
      logger.warn({ ms, sql: text.replace(/\s+/g, ' ').slice(0, 200) }, 'db: slow query');
    }
  }
}

export const readQuery = (text, params) => query(text, params, { client: readPool });

/** Verify the primary connection during process startup. */
export async function verifyDatabaseConnection() {
  await pool.query({ text: 'select 1', query_timeout: Number(env.PG_CONNECT_TIMEOUT_MS ?? 5_000) });
}

/**
 * Run a function inside a transaction on one client. Rolls back on any throw, and always
 * releases — a leaked client is a connection gone for the life of the task.
 */
export async function withTransaction(fn, { isolation = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Used by /readyz. Cheap, and it times out rather than hanging the probe. */
export async function ping({ timeoutMs = 2000 } = {}) {
  const started = Date.now();
  const client = await pool.connect();
  try {
    await client.query({ text: 'select 1', query_timeout: timeoutMs });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, reason: error.message };
  } finally {
    client.release();
  }
}

export function poolStats() {
  return {
    primary: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    replica: readPool === pool ? null : { total: readPool.totalCount, idle: readPool.idleCount, waiting: readPool.waitingCount },
  };
}

/** Called by gracefulShutdown after the server has stopped accepting requests. */
export async function closePools() {
  await Promise.allSettled([pool.end(), readPool === pool ? Promise.resolve() : readPool.end()]);
  logger.info('db: pools closed');
}

export default pool;