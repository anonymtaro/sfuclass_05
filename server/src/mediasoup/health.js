// classroom-app/server/src/mediasoup/health.js
/**
 * SFU health  (F1)  [EXT]
 *
 * Extended in version 6 with worker-crash detection.
 *
 * A mediasoup worker is a separate C++ process. When one dies it takes every
 * router it owned with it, which means every room on those routers ends —
 * silently, from the application's point of view, because the Node process is
 * still perfectly alive and still answering HTTP.
 *
 * That is the failure this file exists to make visible. Without it the task
 * stays "healthy", keeps being handed new rooms by the registry, and those
 * rooms die too.
 *
 * The policy:
 *
 *   one worker dies      respawn it, stay healthy, record the event
 *   several die quickly  something is systematically wrong — stop accepting
 *                        new rooms and report unhealthy so the node is
 *                        replaced rather than repeatedly re-broken
 *   all workers gone     unhealthy, unconditionally
 *
 * Reported through GET /healthz/sfu, which is what the NLB target group and
 * the drain script in deploy-sfu.yml both read.
 */

import { env } from '../config/env.js';
import { capacity } from '../config/mediasoup.config.js';

/** Deaths within this window count toward the "systematically wrong" rule. */
const CRASH_WINDOW_MS = 5 * 60_000;
const CRASH_THRESHOLD = 3;

const state = {
  expectedWorkers: 0,
  aliveWorkers: 0,
  /** Timestamps of recent deaths, trimmed to the window. */
  crashes: [],
  totalCrashes: 0,
  lastCrashAt: null,
  /** Set when the crash threshold trips; only a restart clears it. */
  degraded: false,
  startedAt: Date.now(),
};

const recentCrashes = () => {
  const cutoff = Date.now() - CRASH_WINDOW_MS;
  state.crashes = state.crashes.filter((at) => at > cutoff);
  return state.crashes.length;
};

// ---------------------------------------------------------------------------
// Reported by WorkerManager
// ---------------------------------------------------------------------------

export const reportWorkersExpected = (count) => {
  state.expectedWorkers = count;
};

export const reportWorkerSpawned = () => {
  state.aliveWorkers += 1;
};

/**
 * A worker died. Called from the worker's own 'died' handler, before the
 * respawn is attempted, so the count is accurate even if the respawn fails.
 */
export const reportWorkerDied = ({ pid, logger = console } = {}) => {
  state.aliveWorkers = Math.max(0, state.aliveWorkers - 1);
  state.crashes.push(Date.now());
  state.totalCrashes += 1;
  state.lastCrashAt = new Date().toISOString();

  const recent = recentCrashes();

  logger.error?.(
    { pid, aliveWorkers: state.aliveWorkers, recentCrashes: recent },
    'mediasoup worker died',
  );

  if (recent >= CRASH_THRESHOLD && !state.degraded) {
    state.degraded = true;
    logger.error?.(
      { recent, windowMinutes: CRASH_WINDOW_MS / 60_000 },
      'too many worker crashes; marking this node unhealthy',
    );

    // Stop taking new rooms immediately. The existing ones on surviving
    // workers keep running; there is no reason to end them as well.
    void import('../lifecycle/drainSfu.js')
      .then(({ beginDrain }) => beginDrain({ logger, reason: 'worker-crashes' }))
      .catch(() => undefined);
  }

  return { degraded: state.degraded, recentCrashes: recent };
};

// ---------------------------------------------------------------------------
// Reported by RoomManager
// ---------------------------------------------------------------------------

let roomCounter = () => 0;
let producerCounter = () => 0;

/** Injected at boot so this module does not import RoomManager and cycle. */
export const registerCounters = ({ rooms, producers }) => {
  if (rooms) roomCounter = rooms;
  if (producers) producerCounter = producers;
};

// ---------------------------------------------------------------------------
// The health answer
// ---------------------------------------------------------------------------

/**
 * The payload behind GET /healthz/sfu.
 *
 * Unhealthy here means "replace this node", not "this node is busy". A node at
 * its room ceiling is perfectly healthy — it simply stops being offered new
 * rooms, which is the registry's job, not this one's.
 */
export const checkSfuHealth = () => {
  const rooms = roomCounter();
  const producers = producerCounter();
  const workersOk = state.aliveWorkers > 0 && !state.degraded;

  // Reported so the drain script and the autoscaling alarm read the same
  // number the node uses for its own decisions.
  const atCapacity = rooms >= capacity.maxRoomsPerNode;

  return {
    ok: workersOk,
    nodeId: env.SFU_NODE_ID,
    release: env.RELEASE_SHA,
    workers: {
      expected: state.expectedWorkers,
      alive: state.aliveWorkers,
      totalCrashes: state.totalCrashes,
      recentCrashes: recentCrashes(),
      lastCrashAt: state.lastCrashAt,
      degraded: state.degraded,
    },
    load: {
      rooms,
      maxRooms: capacity.maxRoomsPerNode,
      producers,
      maxProducers: capacity.maxProducersPerNode,
      atCapacity,
    },
    portRange: { min: env.MEDIASOUP_MIN_PORT, max: env.MEDIASOUP_MAX_PORT },
    uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
  };
};

/**
 * Whether this node should be offered a new room. Distinct from health:
 * a healthy node at capacity says no, and an unhealthy node says no even when
 * it has room.
 */
export const canAcceptRoom = () => {
  if (!checkSfuHealth().ok) return false;
  return roomCounter() < capacity.maxRoomsPerNode;
};

/** Published to CloudWatch as classroom/sfu ActiveRooms, per NodeId. */
export const activeRoomsMetric = () => ({
  namespace: 'classroom/sfu',
  metricName: 'ActiveRooms',
  dimensions: [{ Name: 'NodeId', Value: env.SFU_NODE_ID }],
  value: roomCounter(),
  unit: 'Count',
});

/** Tests only. */
export const resetSfuHealth = () => {
  state.expectedWorkers = 0;
  state.aliveWorkers = 0;
  state.crashes = [];
  state.totalCrashes = 0;
  state.lastCrashAt = null;
  state.degraded = false;
  state.startedAt = Date.now();
  roomCounter = () => 0;
  producerCounter = () => 0;
};

export default checkSfuHealth;