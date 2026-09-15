// classroom-app/server/src/server.js
/**
 * API entrypoint  (F7)  [EXT]
 *
 * Boot order, and every step depends on the one before it:
 *
 *   1. secrets into process.env      before anything reads configuration
 *   2. import config/env.js          validates and exits on a bad environment
 *   3. tracing                       before the modules it instruments load
 *   4. connect Postgres and Redis    fail fast rather than on first request
 *   5. HTTP server + socket gateways
 *   6. mark ready                    only now does /readyz answer 200 and the
 *                                    load balancer start sending traffic
 *   7. register shutdown handlers
 *
 * Steps 1–3 are why the imports below are dynamic. A static import graph would
 * evaluate config/env.js before hydrateSecrets() had run, and validation would
 * fail on secrets that were about to arrive.
 *
 * Shutdown is the mirror image, and is what makes a rolling deploy invisible:
 * stop accepting connections, let in-flight work finish, close the pools, exit.
 * ECS sends SIGTERM and waits; if this process ignores it, users see dropped
 * requests on every deployment.
 */

import http from 'node:http';
import { hydrateSecrets } from './config/secrets.js';

const bootstrap = async () => {
  // 1. Secrets first.
  await hydrateSecrets();

  // 2. Configuration. Exits the process on anything invalid.
  const { env, isProduction } = await import('./config/env.js');

  // 3. Tracing before the instrumented modules are loaded.
  // tracing.js exports the configured SDK rather than an init function;
  // starting it is what installs the auto-instrumentation hooks, so it has to
  // happen before pool.js, redis.js and express are imported below.
  // Importing tracing.js is what starts the SDK — it calls sdk.start() at
  // module load. Calling it again here binds the metric reader twice and
  // throws, so the import is deliberately the entire statement.
  await import('./observability/tracing.js');

  const { logger } = await import('./observability/logger.js');
  const log = logger.child({ component: 'bootstrap' });

  log.info(
    { release: env.RELEASE_SHA, node: process.version, env: env.NODE_ENV },
    'starting api',
  );

  // 4. Dependencies. A failure here should stop the boot, not surface later as
  //    a confusing 500 on somebody's first request.
  const { pool, verifyDatabaseConnection } = await import('./db/pool.js');
  const { redis, verifyRedisConnection } = await import('./db/redis.js');

  await verifyDatabaseConnection();
  await verifyRedisConnection();
  log.info('database and redis reachable');

  // Refuse to start on an out-of-date schema. Migrations run as their own task
  // before this container is promoted, so a mismatch means the deployment did
  // something out of order.
  const { assertSchemaCurrent } = await import('./db/migrate.js');
  await assertSchemaCurrent();

  // 5. HTTP and sockets.
  const { createApp } = await import('./app.js');
  const app = createApp();
  const server = http.createServer(app);

  // Above the ALB's 60s idle timeout, so the balancer closes idle connections
  // rather than this process closing one mid-response.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 120_000;

  // Development runs the API and the SFU in one process, so the workers have
  // to start here; in AWS they are separate services and mediasoup/index.js
  // owns them instead. Without this, the first room join fails with no router.
  if (!isProduction) {
    const { startWorkers } = await import('./mediasoup/WorkerManager.js');
    await startWorkers();
    log.info('mediasoup workers running in-process (development)');
  }

  const { attachSocketGateways } = await import('./realtime/index.js');
  const io = await attachSocketGateways(server, { redis });

  await new Promise((resolve) => server.listen(env.PORT, resolve));
  log.info({ port: env.PORT }, 'http listening');

  // 6. Ready. Until this flag flips, /readyz returns 503 and the target group
  //    keeps this task out of rotation.
  const { markReady, markDraining } = await import('./lifecycle/readiness.js');
  markReady();
  log.info('ready for traffic');

  // 7. Shutdown.
  const { registerShutdown } = await import('./lifecycle/gracefulShutdown.js');
  registerShutdown({
    graceSec: env.SHUTDOWN_GRACE_SEC,
    logger: log,
    /**
     * Ordered deliberately. Readiness goes first so the load balancer stops
     * sending new requests while the server is still able to answer the ones
     * it already has; connections close last, after the work that needs them.
     */
    steps: [
      {
        name: 'readiness',
        run: async () => {
          markDraining();
          // The ALB needs a couple of health-check intervals to notice.
          await new Promise((resolve) => setTimeout(resolve, isProduction ? 5_000 : 0));
        },
      },
      {
        name: 'http',
        run: () =>
          new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      },
      {
        name: 'sockets',
        run: async () => {
          // Tells clients to reconnect elsewhere rather than leaving them to
          // discover a dead socket by timeout.
          io.emitToAll?.('server:draining', { reason: 'deploy' });
          await io.close();
        },
      },
      { name: 'redis', run: () => redis.quit() },
      { name: 'postgres', run: () => pool.end() },
    ],
  });

  return { server, io };
};

// ---------------------------------------------------------------------------
// Failure modes that must not be silent
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  // Logged and fatal. A process that keeps running after an unhandled
  // rejection is in a state nobody has reasoned about.
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
  console.error('failed to start', error);
  process.exit(1);
});