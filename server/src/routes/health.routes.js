/**
 * health.routes — /healthz · /readyz · /startupz (F7) [EXT]
 *
 * Three endpoints because they answer three different questions, and conflating them is
 * how a deploy takes traffic before its database is reachable — or how a slow query
 * restarts a perfectly healthy container.
 *
 *   /healthz    Is the process alive and the event loop moving? No dependency calls,
 *               no I/O. Used by the ECS container health check, which kills on failure.
 *   /readyz     Can this task serve a request right now — pg, redis, s3 answered inside
 *               the timeout and the schema is at the expected version? Used by the ALB
 *               target group, which only stops routing.
 *   /startupz   Did first boot finish — config validated, secrets loaded, workers
 *               registered? Used by the ECS startup grace period.
 *   /healthz/sfu  mediasoup workers alive, port range bound, room count under the cap.
 *               Used by the NLB and by the drain script.
 *
 * All four are unauthenticated (a load balancer cannot hold a token), so they must never
 * leak configuration: names and booleans, no connection strings, no versions of anything
 * an attacker could fingerprint. They are excluded from the request log and never cached.
 */

import { Router } from 'express';

import { env } from '../config/env.js';
import { checkReadiness, checkStartup } from '../lifecycle/readiness.js';
import { isDraining } from '../lifecycle/drainSfu.js';
import * as sfuHealth from '../mediasoup/health.js';
import { route, noStore } from './_helpers.js';

const router = Router();

const startedAt = Date.now();

/** Event loop lag, sampled cheaply. A blocked loop is the failure /healthz exists to catch. */
let lagMs = 0;
let lastTick = process.hrtime.bigint();
const lagTimer = setInterval(() => {
  const now = process.hrtime.bigint();
  lagMs = Math.max(0, Number(now - lastTick) / 1e6 - 500);
  lastTick = now;
}, 500);
lagTimer.unref();

const base = () => ({
  service: env.SERVICE_NAME,
  release: env.RELEASE_SHA ?? 'unknown',
  uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
});

/* ------------------------------------------------------------------ *
 * Liveness
 * ------------------------------------------------------------------ */

router.get(
  '/healthz',
  route(async (_req, res) => {
    noStore(res);
    const blocked = lagMs > 1000;
    res.status(blocked ? 503 : 200);
    return { ...base(), status: blocked ? 'blocked' : 'ok', eventLoopLagMs: Math.round(lagMs) };
  }),
);

/* ------------------------------------------------------------------ *
 * Readiness
 * ------------------------------------------------------------------ */

router.get(
  '/readyz',
  route(async (_req, res) => {
    noStore(res);

    // Draining tasks report not-ready so the balancer stops sending work, while the
    // process stays alive long enough to finish what it already has.
    if (isDraining()) {
      res.status(503);
      return { ...base(), status: 'draining', checks: {} };
    }

    const readiness = await checkReadiness({ force: true });
    const ready = readiness.ok;

    res.status(ready ? 200 : 503);
    return {
      ...base(),
      status: ready ? 'ready' : 'not-ready',
      checks: readiness.checks,
    };
  }),
);

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

router.get(
  '/startupz',
  route(async (_req, res) => {
    noStore(res);
    const state = checkStartup();
    const done = state.ok;
    res.status(done ? 200 : 503);
    return { ...base(), status: done ? 'started' : 'starting', steps: state };
  }),
);

/* ------------------------------------------------------------------ *
 * SFU
 * ------------------------------------------------------------------ */

router.get(
  '/healthz/sfu',
  route(async (_req, res) => {
    noStore(res);
    const status = await sfuHealth.snapshot();
    const healthy = status.workersAlive > 0 && status.workersAlive === status.workersExpected && status.portRangeBound;

    res.status(healthy && !isDraining() ? 200 : 503);
    return {
      ...base(),
      status: isDraining() ? 'draining' : healthy ? 'ok' : 'unhealthy',
      workersAlive: status.workersAlive,
      workersExpected: status.workersExpected,
      portRangeBound: status.portRangeBound,
      rooms: status.rooms,
      roomCap: status.roomCap,
      producers: status.producers,
      atCapacity: status.rooms >= status.roomCap,
    };
  }),
);

export default router;