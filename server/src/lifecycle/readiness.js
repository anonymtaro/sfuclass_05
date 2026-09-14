// classroom-app/server/src/lifecycle/readiness.js
/**
 * Readiness and liveness  (F7)  [NEW]
 *
 * Three endpoints exist because they answer three different questions, and
 * conflating them is how a cluster ends up restarting healthy tasks:
 *
 *   /startupz  has the first boot finished? Probed during the ECS start
 *              period. Slow is fine here.
 *   /healthz   is the process alive and the event loop turning? No dependency
 *              calls at all. This one decides whether the container is killed,
 *              so it must not fail because Postgres is having a bad minute —
 *              restarting the app would not fix the database.
 *   /readyz    can this task serve a request right now? Checks Postgres, Redis
 *              and S3. The load balancer uses this one, so a task with a dead
 *              dependency stops receiving traffic without being killed.
 *
 * Probes are cached briefly. The ALB polls every few seconds across every
 * task, and an uncached readiness check would be a self-inflicted load test on
 * the database.
 */

import { env } from '../config/env.js';

const STATES = { starting: 'starting', ready: 'ready', draining: 'draining' };

let state = STATES.starting;
let startedAt = null;
let cache = { at: 0, result: null };

/** Long enough to absorb an ALB polling burst, short enough to be current. */
const CACHE_MS = 2_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const markStarted = () => {
  startedAt = Date.now();
};

export const markReady = () => {
  state = STATES.ready;
  startedAt ??= Date.now();
};

/**
 * Called first during shutdown. From here /readyz answers 503 while /healthz
 * still answers 200, which is exactly the combination that makes the load
 * balancer stop sending work without the orchestrator killing the process
 * mid-request.
 */
export const markDraining = () => {
  state = STATES.draining;
  cache = { at: 0, result: null };
};

export const isReady = () => state === STATES.ready;
export const isDraining = () => state === STATES.draining;
export const getState = () => state;

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

const timeout = (promise, ms, name) =>
  Promise.race([
    Promise.resolve(promise),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);

/**
 * Each probe is the cheapest call that proves the connection works end to end.
 * `SELECT 1` goes through the pool, the socket and the server, which is the
 * whole path a real query takes minus the query.
 */
const probes = {
  async postgres() {
    const { pool } = await import('../db/pool.js');
    await pool.query('SELECT 1');
  },

  async redis() {
    const { redis } = await import('../db/redis.js');
    const reply = await redis.ping();
    if (reply !== 'PONG') throw new Error(`unexpected reply: ${reply}`);
  },

  async s3() {
    // HeadBucket, not ListObjects: it proves reachability and permission
    // without paying for a listing on a bucket with a million objects.
    const { headDeliveryBucket } = await import('../media/StorageClient.js');
    await headDeliveryBucket();
  },
};

/**
 * Which probes matter for this process. The worker never serves HTTP but does
 * need every dependency; the SFU needs neither Postgres nor S3 to relay media,
 * so failing its readiness on them would take a working node out of rotation.
 */
const probesFor = (role) => {
  switch (role) {
    case 'sfu':
      return ['redis'];
    case 'worker':
      return ['postgres', 'redis', 's3'];
    default:
      return ['postgres', 'redis', 's3'];
  }
};

/**
 * Runs the probes in parallel with a per-probe timeout.
 *
 * @param {{ role?: string, force?: boolean }} options
 */
export const checkReadiness = async ({ role = 'api', force = false } = {}) => {
  if (!force && cache.result && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.result, cached: true };
  }

  const names = probesFor(role);

  const checks = await Promise.all(
    names.map(async (name) => {
      const start = Date.now();
      try {
        await timeout(probes[name](), env.READINESS_TIMEOUT_MS, name);
        return { name, ok: true, ms: Date.now() - start };
      } catch (cause) {
        return {
          name,
          ok: false,
          ms: Date.now() - start,
          // Safe to expose: a probe name and a timeout, never a connection
          // string. This body is read by the load balancer and by on-call.
          error: cause?.message?.slice(0, 200) ?? 'unknown',
        };
      }
    }),
  );

  const dependenciesOk = checks.every((check) => check.ok);

  const result = {
    // Draining tasks report not-ready even when every dependency is fine.
    ok: dependenciesOk && state === STATES.ready,
    state,
    checks,
    release: env.RELEASE_SHA,
    cached: false,
  };

  cache = { at: Date.now(), result };
  return result;
};

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

let lastLagSample = 0;
let lagMs = 0;

/**
 * Event-loop lag, sampled on a timer. A process pinned by a synchronous loop
 * answers HTTP eventually but is effectively dead, and this is the only signal
 * that distinguishes it from a merely busy one.
 */
const startLagSampling = () => {
  const interval = 1_000;
  let expected = Date.now() + interval;

  const timer = setInterval(() => {
    const now = Date.now();
    lagMs = Math.max(0, now - expected);
    expected = now + interval;
    lastLagSample = now;
  }, interval);

  timer.unref();
};

startLagSampling();

/** No dependency calls. Alive is not the same as useful. */
export const checkLiveness = () => {
  // Two seconds of lag means the loop is blocked, not busy.
  const blocked = lagMs > 2_000;
  const stale = lastLagSample > 0 && Date.now() - lastLagSample > 5_000;

  return {
    ok: !blocked && !stale,
    state,
    release: env.RELEASE_SHA,
    uptimeSec: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
    eventLoopLagMs: lagMs,
  };
};

export const checkStartup = () => ({
  ok: state !== STATES.starting,
  state,
  release: env.RELEASE_SHA,
});

/** Tests only. */
export const resetReadiness = () => {
  state = STATES.starting;
  startedAt = null;
  cache = { at: 0, result: null };
};

export default checkReadiness;