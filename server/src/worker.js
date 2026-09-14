// classroom-app/server/src/worker.js
/**
 * Background worker entrypoint  (F7)  [NEW]
 *
 * A separate process and a separate ECS service from the API, for one reason:
 * transcoding a two-hour lecture must not compete with a learner's request for
 * the next page of a chat thread. They have different CPU profiles, different
 * scaling signals and different failure modes, and sharing a process means the
 * worse of both.
 *
 * What runs here:
 *   transcodeWorker      MediaConvert submission and polling      (F4)
 *   notificationWorker   push, email and in-app fan-out           (F2, F5, F6)
 *   chatFanoutWorker     unread counters and mentions             (F6)
 *   recordingWorker      ffmpeg mux and upload                    (F1, F4)
 *   maintenanceWorker    sweeps, retries, dead letters
 *
 * Scheduled jobs are not here. EventBridge invokes them as one-off tasks, so a
 * daily digest cannot be run twice by two worker replicas.
 *
 * Shutdown matters more than in the API. A worker killed mid-job leaves a
 * MediaConvert job with nobody watching it, so SIGTERM stops the workers from
 * taking new jobs and then waits for the current ones — which is why the ECS
 * stopTimeout for this service is longer than for the API.
 */

import http from 'node:http';
import { hydrateSecrets } from './config/secrets.js';

const bootstrap = async () => {
  await hydrateSecrets();

  const { env } = await import('./config/env.js');
  const { initTracing } = await import('./observability/tracing.js');
  await initTracing({ serviceName: `${env.SERVICE_NAME}-worker`, release: env.RELEASE_SHA });

  const { logger } = await import('./observability/logger.js');
  const log = logger.child({ component: 'worker' });

  log.info({ release: env.RELEASE_SHA, concurrency: env.WORKER_CONCURRENCY }, 'starting worker');

  const { pool, verifyDatabaseConnection } = await import('./db/pool.js');
  const { redis, verifyRedisConnection } = await import('./db/redis.js');
  await verifyDatabaseConnection();
  await verifyRedisConnection();

  // -------------------------------------------------------------------------
  // Workers
  // -------------------------------------------------------------------------
  const { createWorkers } = await import('./queues/workers/index.js');
  const workers = await createWorkers({
    connection: redis,
    concurrency: env.WORKER_CONCURRENCY,
    logger: log,
  });

  log.info({ queues: workers.map((worker) => worker.name) }, 'workers running');

  // -------------------------------------------------------------------------
  // Health endpoint
  // -------------------------------------------------------------------------
  // A worker has no traffic, so ECS cannot tell a wedged one from a quiet one.
  // This tiny server is what the container health check probes: it reports
  // whether the workers are still attached to Redis, not merely whether the
  // process exists.
  let draining = false;
  const healthServer = http.createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const running = workers.filter((worker) => worker.isRunning()).length;
    const healthy = !draining && running === workers.length;
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: healthy ? 'ok' : draining ? 'draining' : 'degraded',
        release: env.RELEASE_SHA,
        workers: { running, expected: workers.length },
      }),
    );
  });

  const healthPort = env.PORT + 1;
  await new Promise((resolve) => healthServer.listen(healthPort, resolve));
  log.info({ port: healthPort }, 'worker health endpoint listening');

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------
  const { registerShutdown } = await import('./lifecycle/gracefulShutdown.js');
  registerShutdown({
    // Generous: a running transcode submission is worth waiting for, and an
    // interrupted one becomes a stuck asset the reconcile job has to find.
    graceSec: Math.max(env.SHUTDOWN_GRACE_SEC, 60),
    logger: log,
    steps: [
      {
        name: 'stop accepting jobs',
        run: async () => {
          draining = true;
          // pause(true) waits for in-flight jobs rather than abandoning them.
          await Promise.all(workers.map((worker) => worker.pause(true)));
        },
      },
      {
        name: 'close workers',
        run: async () => {
          await Promise.all(workers.map((worker) => worker.close()));
        },
      },
      {
        name: 'health server',
        run: () =>
          new Promise((resolve, reject) =>
            healthServer.close((error) => (error ? reject(error) : resolve())),
          ),
      },
      { name: 'redis', run: () => redis.quit() },
      { name: 'postgres', run: () => pool.end() },
    ],
  });

  return workers;
};

process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection', reason);
  process.exitCode = 1;
  process.kill(process.pid, 'SIGTERM');
});

process.on('uncaughtException', (error) => {
  console.error('uncaught exception', error);
  process.exitCode = 1;
  process.kill(process.pid, 'SIGTERM');
});

bootstrap().catch((error) => {
  console.error('worker failed to start', error);
  process.exit(1);
});