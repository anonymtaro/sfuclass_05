// classroom-app/server/src/mediasoup/WorkerManager.js
/**
 * Worker pool  (F1)  [UNCHANGED]
 *
 * Reference implementation, unchanged in behaviour from version 5. If your
 * existing file differs, keep yours — the only thing version 6 requires is that
 * the 'died' handler calls into mediasoup/health.js, which is the block marked
 * below.
 *
 * A mediasoup worker is a separate process that owns routers. One worker
 * saturates one core, so the pool is sized to the machine and routers are
 * spread across it.
 *
 * Rooms are assigned to the least-loaded worker at creation and stay there for
 * life — a router cannot move between workers, and the peers of one room must
 * share a router to exchange media at all. That is why the SFU is the stateful
 * service in this platform and why deploy-sfu.yml drains instead of replacing.
 */

import * as mediasoup from 'mediasoup';
import { workerSettings } from '../config/mediasoup.config.js';
import { logger } from '../observability/logger.js';
import { reportWorkerDied, reportWorkerSpawned, reportWorkersExpected } from './health.js';

const log = logger.child({ component: 'worker-manager' });

/** @type {{ worker: import('mediasoup').types.Worker, routers: Set<string> }[]} */
const pool = [];
let started = false;

const spawn = async (index) => {
  const worker = await mediasoup.createWorker({
    logLevel: workerSettings.logLevel,
    logTags: workerSettings.logTags,
    rtcMinPort: workerSettings.rtcMinPort,
    rtcMaxPort: workerSettings.rtcMaxPort,
  });

  const slot = { worker, routers: new Set() };

  worker.on('died', (error) => {
    // A worker never comes back by itself. Everything it owned is gone.
    const lostRooms = [...slot.routers];
    slot.routers.clear();

    const { degraded } = reportWorkerDied({ pid: worker.pid, logger: log });

    log.error(
      { pid: worker.pid, err: error, lostRooms: lostRooms.length },
      'worker died; its rooms are gone',
    );

    // Tell the rooms so their peers get a proper "the session ended" rather
    // than a socket that simply stops carrying media.
    void import('../classroom/RoomManager.js')
      .then(({ handleWorkerLoss }) => handleWorkerLoss(lostRooms))
      .catch(() => undefined);

    // Respawn unless the node has already been written off; respawning into a
    // systematic failure just produces another crash a minute later.
    if (!degraded) {
      void respawn(index).catch((cause) =>
        log.error({ err: cause }, 'could not respawn a worker'),
      );
    }
  });

  reportWorkerSpawned();
  log.info({ pid: worker.pid, index }, 'mediasoup worker started');
  return slot;
};

const respawn = async (index) => {
  const slot = await spawn(index);
  pool[index] = slot;
};

/**
 * Starts the pool. Idempotent, so a second call during a hot reload does not
 * double the worker count.
 */
export const startWorkers = async () => {
  if (started) return pool;
  started = true;

  const count = workerSettings.count;
  reportWorkersExpected(count);

  for (let index = 0; index < count; index += 1) {
    pool[index] = await spawn(index);
  }

  log.info({ count, portRange: [workerSettings.rtcMinPort, workerSettings.rtcMaxPort] }, 'worker pool ready');
  return pool;
};

/**
 * Least-loaded worker, by router count rather than round-robin: rooms have very
 * different lifetimes, and round-robin drifts into one worker holding every
 * long-running lecture.
 */
export const getWorker = () => {
  if (pool.length === 0) throw new Error('worker pool has not been started');

  const alive = pool.filter((slot) => slot && !slot.worker.closed);
  if (alive.length === 0) throw new Error('no mediasoup workers are alive');

  return alive.reduce((best, slot) => (slot.routers.size < best.routers.size ? slot : best));
};

/** Called by createRouter so the pool knows what each worker is carrying. */
export const trackRouter = (worker, roomId) => {
  const slot = pool.find((entry) => entry?.worker === worker);
  slot?.routers.add(roomId);
};

export const untrackRouter = (worker, roomId) => {
  const slot = pool.find((entry) => entry?.worker === worker);
  slot?.routers.delete(roomId);
};

export const getWorkerStats = async () =>
  Promise.all(
    pool.filter(Boolean).map(async (slot) => ({
      pid: slot.worker.pid,
      closed: slot.worker.closed,
      routers: slot.routers.size,
      resource: await slot.worker.getResourceUsage(),
    })),
  );

export const getRouterCount = () =>
  pool.filter(Boolean).reduce((total, slot) => total + slot.routers.size, 0);

/** Shutdown step. Closing a worker closes its routers and transports with it. */
export const closeWorkers = async () => {
  for (const slot of pool.filter(Boolean)) {
    try {
      slot.worker.close();
    } catch (cause) {
      log.warn({ err: cause, pid: slot.worker.pid }, 'worker close failed');
    }
  }
  pool.length = 0;
  started = false;
};

export default startWorkers;