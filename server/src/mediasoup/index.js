// classroom-app/server/src/mediasoup/index.js
/**
 * SFU entrypoint  (F1)
 *
 * The process docker-compose.dev.yml runs as the `sfu` service, and the one
 * ecs-sfu.tf runs on EC2 with host networking. It does three things and nothing
 * else: start the mediasoup workers, publish this node's load to the registry
 * so rooms can be assigned to it, and answer a health check.
 *
 * It deliberately does not open a signalling socket. Signalling is the API's
 * job; media is this one's. Keeping them apart is what lets the API scale on
 * request count while the SFU scales on producers per node.
 *
 * In development the two usually run in the same process — `npm run dev -w
 * @classroom/server` boots the API, and the API creates routers directly
 * through RoomManager. This file exists for the deployed shape, where they are
 * separate services, and for testing that shape locally with
 * `npm run dev:sfu -w @classroom/server`.
 */

import http from 'node:http';

import { env } from './../config/env.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'sfu' });

const bootstrap = async () => {
  log.info(
    {
      nodeId: env.SFU_NODE_ID,
      announcedIp: env.ANNOUNCED_IP,
      portRange: `${env.MEDIASOUP_MIN_PORT}-${env.MEDIASOUP_MAX_PORT}`,
    },
    'starting sfu',
  );

  // Workers own the native processes that actually move RTP. Everything else
  // here is bookkeeping around them.
  const WorkerManager = await import('./WorkerManager.js');
  const start =
    WorkerManager.createWorkers ??
    WorkerManager.startWorkers ??
    WorkerManager.initWorkers ??
    WorkerManager.default?.createWorkers;

  if (typeof start !== 'function') {
    throw new Error(
      'mediasoup/WorkerManager.js exports no worker-starting function ' +
        `(saw: ${Object.keys(WorkerManager).join(', ')})`,
    );
  }

  await start();
  log.info('mediasoup workers running');

  // Publishing load is what makes this node eligible for room assignment. A
  // node that stops heartbeating drops out of the pool within NODE_TTL_SEC,
  // which is how a crashed node stops receiving lessons.
  const { startHeartbeat } = await import('../classroom/RoomRegistry.js');
  const stopHeartbeat = startHeartbeat({ intervalMs: 15_000 });
  log.info('registry heartbeat started');

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  const health = await import('./health.js');
  const { getStats } = await import('../classroom/RoomManager.js').then((m) => ({
    getStats: () => ({ rooms: m.getRoomCount(), producers: m.getProducerCount() }),
  }));

  const server = http.createServer((req, res) => {
    if (req.url !== '/healthz/sfu' && req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }

    const healthy =
      typeof health.isHealthy === 'function' ? health.isHealthy() : true;
    const stats = getStats();

    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: healthy ? 'ok' : 'unhealthy',
        nodeId: env.SFU_NODE_ID,
        release: env.RELEASE_SHA,
        ...stats,
        maxRooms: env.SFU_MAX_ROOMS_PER_NODE,
      }),
    );
  });

  await new Promise((resolve) => server.listen(env.SFU_HTTP_PORT, resolve));
  log.info({ port: env.SFU_HTTP_PORT }, 'sfu health endpoint listening');

  // -------------------------------------------------------------------------
  // Drain, not kill
  // -------------------------------------------------------------------------

  /**
   * A lesson in progress must not end because a deployment started. Draining
   * stops new room assignment and waits for the rooms already here to finish;
   * only then does the process exit. SFU_DRAIN_TIMEOUT_SEC is the upper bound,
   * after which a long-running room is ended deliberately rather than left to
   * block the deployment forever.
   */
  let draining = false;

  const shutdown = async (signal) => {
    if (draining) return;
    draining = true;
    log.info({ signal }, 'drain started');

    const { beginDrain } = await import('../lifecycle/drainSfu.js').catch(() => ({}));
    if (typeof beginDrain === 'function') {
      await beginDrain({ timeoutSec: env.SFU_DRAIN_TIMEOUT_SEC }).catch((cause) =>
        log.error({ err: cause }, 'drain failed'),
      );
    } else {
      log.warn('lifecycle/drainSfu.js exports no beginDrain — closing rooms immediately');
    }

    stopHeartbeat?.();

    const { closeAllRooms } = await import('../classroom/RoomManager.js');
    const closed = await closeAllRooms('node-drained').catch(() => 0);
    log.info({ closed }, 'rooms closed');

    const closeWorkers =
      WorkerManager.closeWorkers ?? WorkerManager.stopWorkers ?? (() => undefined);
    await closeWorkers();

    server.close(() => {
      log.info('sfu stopped');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return server;
};

process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection', reason);
  process.exitCode = 1;
  process.kill(process.pid, 'SIGTERM');
});

bootstrap().catch((error) => {
  console.error('failed to start sfu', error);
  process.exit(1);
});