/**
 * db/migrate — migration runner. [EXT] (F7)
 *
 * Runs as a one-off ECS task before the new task set takes traffic. The application never
 * migrates on boot: ten tasks starting together would race, and a migration that runs while
 * the old version is still serving is how a half-applied schema meets live traffic.
 *
 * What makes this safe to run from CI, twice, by accident:
 *
 *  - A Postgres advisory lock. A concurrent run blocks, then finds nothing to do. Not a
 *    row lock and not a table — an advisory lock survives an empty schema and costs nothing.
 *  - Checksums. Every applied file's SHA-256 is stored. Editing a migration that has
 *    already run in production is the single most common way to get two environments with
 *    silently different schemas, so it is a hard failure here, not a warning.
 *  - One transaction per file. A failed migration leaves the ones before it applied and
 *    itself entirely absent — never half.
 *  - No statement timeout. The pool sets one for request traffic; an ALTER on a large table
 *    would hit it and fail at an arbitrary point. A lock timeout is set instead, so a
 *    migration waiting on a lock gives up rather than queueing behind every live query.
 *
 * Expand then contract is a discipline, not something this file can enforce: add in release
 * N, stop writing in N+1, drop in N+2, so a rollback always meets a schema it can read.
 *
 * Usage:
 *   node src/db/migrate.js            apply everything pending
 *   node src/db/migrate.js --status   list applied and pending, exit 0
 *   node src/db/migrate.js --dry-run  show what would run, apply nothing
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Arbitrary but fixed. Any other process using this key would block us, so keep it unique. */
const ADVISORY_LOCK_KEY = 8_421_337;

const LOCK_TIMEOUT = '10s';
const ACQUIRE_TIMEOUT_MS = 120_000;

/* ------------------------------------------------------------------ *
 * Bookkeeping table
 * ------------------------------------------------------------------ */

const SCHEMA_TABLE = `
  create table if not exists schema_migrations (
    filename     text        primary key,
    checksum     text        not null,
    applied_at   timestamptz not null default now(),
    duration_ms  integer     not null,
    release_sha  text
  )
`;

async function listFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

const checksum = (sql) => crypto.createHash('sha256').update(sql).digest('hex');

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

export async function migrate({ dryRun = false, statusOnly = false } = {}) {
  // A dedicated client, not the app pool: migrations need their own session settings and
  // must hold the advisory lock for the whole run.
  const client = new pg.Client({
    connectionString: env.DATABASE_URL,
    ssl: env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: env.PGSSLMODE !== 'no-verify' },
    application_name: 'migrate',
    // No statement_timeout on purpose — see the header.
    statement_timeout: 0,
  });

  await client.connect();
  let locked = false;

  try {
    await client.query(`set lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query(SCHEMA_TABLE);

    const { rows: applied } = await client.query('select filename, checksum from schema_migrations');
    const appliedMap = new Map(applied.map((row) => [row.filename, row.checksum]));
    const files = await listFiles();

    /* Checksum verification runs before anything is applied and before the lock is taken —
       a mismatch is a deploy that must not proceed, not a migration that failed halfway. */
    const drifted = [];
    for (const filename of files) {
      const previous = appliedMap.get(filename);
      if (!previous) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
      if (checksum(sql) !== previous) drifted.push(filename);
    }
    if (drifted.length > 0) {
      throw new Error(
        `Migration files changed after being applied: ${drifted.join(', ')}. ` +
          'Add a new migration instead of editing an applied one.',
      );
    }

    const pending = files.filter((filename) => !appliedMap.has(filename));

    if (statusOnly) {
      logger.info({ applied: applied.length, pending }, 'migrate: status');
      return { applied: applied.length, pending };
    }
    if (pending.length === 0) {
      logger.info('migrate: nothing to do');
      return { applied: 0, pending: [] };
    }
    if (dryRun) {
      logger.info({ pending }, 'migrate: dry run, applying nothing');
      return { applied: 0, pending };
    }

    /* Serialise across tasks. Two migration tasks from two pipelines is not hypothetical. */
    await client.query(`set statement_timeout = ${ACQUIRE_TIMEOUT_MS}`);
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    locked = true;
    await client.query('set statement_timeout = 0');

    // Re-read: another task may have applied these while we waited for the lock.
    const { rows: afterLock } = await client.query('select filename from schema_migrations');
    const done = new Set(afterLock.map((row) => row.filename));
    const toRun = pending.filter((filename) => !done.has(filename));

    if (toRun.length === 0) {
      logger.info('migrate: another task applied everything while we waited');
      return { applied: 0, pending: [] };
    }

    const ran = [];
    for (const filename of toRun) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const startedAt = Date.now();

      logger.info({ filename }, 'migrate: applying');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query(
          `insert into schema_migrations (filename, checksum, duration_ms, release_sha)
           values ($1, $2, $3, $4)`,
          [filename, checksum(sql), Date.now() - startedAt, env.RELEASE_SHA ?? null],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        logger.error({ err: error, filename }, 'migrate: failed');
        throw new Error(`Migration ${filename} failed: ${error.message}`);
      }

      ran.push({ filename, durationMs: Date.now() - startedAt });
      logger.info({ filename, durationMs: Date.now() - startedAt }, 'migrate: applied');
    }

    logger.info({ count: ran.length, files: ran.map((entry) => entry.filename) }, 'migrate: done');
    return { applied: ran.length, pending: [], files: ran };
  } finally {
    if (locked) await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  }
}

/**
 * Read by /readyz: a task whose schema is behind the expected version should not take
 * traffic, because the code it is running assumes the newer schema.
 */
export async function currentVersion(client) {
  const { rows } = await client.query(
    'select filename from schema_migrations order by filename desc limit 1',
  );
  return rows[0]?.filename ?? null;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  const args = new Set(process.argv.slice(2));
  try {
    await migrate({ dryRun: args.has('--dry-run'), statusOnly: args.has('--status') });
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'migrate: aborted');
    // Non-zero is what stops the deploy pipeline before the new task set is promoted.
    process.exit(1);
  }
}

export default migrate;