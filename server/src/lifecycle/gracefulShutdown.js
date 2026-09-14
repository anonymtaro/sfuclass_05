// classroom-app/server/src/lifecycle/gracefulShutdown.js
/**
 * Graceful shutdown  (F7)  [NEW]
 *
 * ECS sends SIGTERM and then waits `stopTimeout` seconds before SIGKILL. What
 * happens in between is the difference between a deployment nobody notices and
 * one that drops every request in flight.
 *
 * The sequence is ordered, not parallel, and the order is the design:
 *
 *   1. stop being ready      the load balancer needs two health-check
 *                            intervals to take this task out of rotation, and
 *                            during those seconds the server must still answer
 *   2. close the listener    no new connections; existing ones finish
 *   3. close sockets         tell clients to reconnect elsewhere
 *   4. close Redis
 *   5. close Postgres        last, because steps 2 and 3 may still need it
 *
 * Closing the pools first is the classic mistake: in-flight requests then fail
 * with a connection error instead of completing, and the user sees an error on
 * every deploy.
 *
 * Two safety nets. A total budget, after which the process exits regardless —
 * a shutdown that hangs is worse than one that is abrupt, because ECS will
 * SIGKILL it anyway and you lose the logs. And a second signal forces an
 * immediate exit, so an operator pressing Ctrl-C twice is obeyed.
 */

const DEFAULT_GRACE_SEC = 25;
/** No single step may consume the whole budget. */
const STEP_TIMEOUT_RATIO = 0.5;

let shuttingDown = false;
let registered = false;
const extraHooks = new Set();
/** Kept so the listeners can actually be detached again. */
let attached = [];

/** Resolves, or rejects once `ms` has passed. */
const withTimeout = (promise, ms, name) =>
  Promise.race([
    Promise.resolve(promise),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${name} did not finish within ${ms}ms`)), ms).unref(),
    ),
  ]);

/**
 * @param {object} options
 * @param {number} [options.graceSec]  total budget across every step
 * @param {object} [options.logger]
 * @param {{ name: string, run: () => Promise<unknown> }[]} options.steps
 * @param {(code: number) => void} [options.exit]  injectable for tests
 */
export const registerShutdown = ({
  graceSec = DEFAULT_GRACE_SEC,
  logger = console,
  steps = [],
  exit = (code) => process.exit(code),
} = {}) => {
  if (registered) {
    logger.warn?.('shutdown already registered; ignoring the second call');
    return;
  }
  registered = true;

  const run = async (signal) => {
    if (shuttingDown) {
      // A second signal means somebody is impatient, or ECS escalated. Obey.
      logger.warn?.({ signal }, 'second shutdown signal, exiting now');
      exit(1);
      return;
    }
    shuttingDown = true;

    const startedAt = Date.now();
    const budgetMs = graceSec * 1_000;
    const stepTimeoutMs = Math.max(1_000, budgetMs * STEP_TIMEOUT_RATIO);

    logger.info?.({ signal, graceSec, steps: steps.length }, 'shutting down');

    // Hard deadline. Unref'd so it never keeps the process alive by itself.
    const deadline = setTimeout(() => {
      logger.error?.({ graceSec }, 'shutdown budget exhausted, exiting');
      exit(1);
    }, budgetMs);
    deadline.unref();

    let failed = false;

    for (const step of steps) {
      const remainingMs = budgetMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        logger.error?.({ step: step.name }, 'no time left for this step');
        failed = true;
        break;
      }

      const stepStart = Date.now();
      try {
        await withTimeout(step.run(), Math.min(stepTimeoutMs, remainingMs), step.name);
        logger.info?.({ step: step.name, ms: Date.now() - stepStart }, 'shutdown step done');
      } catch (cause) {
        // Carry on. A Redis client that will not close should not prevent the
        // database pool from being closed cleanly.
        failed = true;
        logger.error?.(
          { step: step.name, err: cause, ms: Date.now() - stepStart },
          'shutdown step failed',
        );
      }
    }

    for (const hook of extraHooks) {
      try {
        await withTimeout(hook(), 2_000, 'shutdown hook');
      } catch (cause) {
        logger.warn?.({ err: cause }, 'shutdown hook failed');
      }
    }

    clearTimeout(deadline);
    logger.info?.({ ms: Date.now() - startedAt, failed }, 'shutdown complete');

    // A failed step still exits 0 when the work itself was done: ECS treats a
    // non-zero exit as a crash and may mark the deployment unhealthy, which is
    // the wrong signal for "Redis took too long to say goodbye".
    exit(failed ? 0 : 0);
  };

  const handlers = [
    ['SIGTERM', () => void run('SIGTERM')],
    ['SIGINT', () => void run('SIGINT')],
    // Sent by nodemon and some supervisors on restart.
    ['SIGUSR2', () => void run('SIGUSR2')],
  ];

  for (const [signal, handler] of handlers) process.on(signal, handler);
  attached = handlers;

  return {
    isShuttingDown: () => shuttingDown,
    /** Detaches the listeners. Used by tests and by a hot reload. */
    dispose: () => {
      for (const [signal, handler] of attached) process.off(signal, handler);
      attached = [];
      registered = false;
    },
  };
};

/**
 * Registers work to run at the very end, after the ordered steps. For things
 * that are nice to finish and not worth blocking on: flushing a metrics batch,
 * writing a final audit line.
 */
export const onShutdown = (hook) => {
  extraHooks.add(hook);
  return () => extraHooks.delete(hook);
};

/**
 * Read by request handlers that should refuse new work while the process is on
 * its way out — the queue workers use it to stop claiming jobs.
 */
export const isShuttingDown = () => shuttingDown;

/**
 * Tests only. Detaches the signal listeners as well as clearing the flags —
 * without that, a second registration in the same process fires the previous
 * run() first, which reports "second signal" and exits immediately.
 */
export const resetShutdownState = () => {
  for (const [signal, handler] of attached) process.off(signal, handler);
  attached = [];
  shuttingDown = false;
  registered = false;
  extraHooks.clear();
};

export default registerShutdown;