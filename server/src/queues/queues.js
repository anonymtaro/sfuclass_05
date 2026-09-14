/**
 * queues/queues — transcode · notify · chat · recording · maintenance (F7)
 *
 * One place where every queue, its retry policy and its dead-letter route are declared.
 * A queue that is defined next to the code that uses it ends up with a different backoff
 * from its neighbour for no reason anybody remembers.
 *
 * The retry shape is per queue because the failure modes differ:
 *  - transcode  slow, external, expensive → few attempts, long backoff
 *  - notify     cheap, bursty, time-sensitive → more attempts, short backoff
 *  - chat       must not lag → many attempts, very short backoff
 *  - recording  hours of CPU → one retry only; a second failure needs a human
 *
 * Two rules the workers rely on:
 *  1. Every handler is idempotent. At-least-once delivery is the contract, not an edge
 *     case — a worker killed between "work done" and "job acked" WILL see the job again.
 *  2. A permanent failure throws PermanentJobError. Retrying a 400 from MediaConvert
 *     twelve times just moves the same error further away from the log line that explains
 *     it, and burns the queue's throughput doing it.
 */

import { Queue, Worker, QueueEvents, UnrecoverableError } from 'bullmq';

import { queueConnection, workerConnection, QUEUE_PREFIX } from './connection.js';
import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';

export const QUEUE_NAMES = Object.freeze({
  TRANSCODE: 'transcode',
  NOTIFY: 'notify',
  CHAT: 'chat',
  RECORDING: 'recording',
  MAINTENANCE: 'maintenance',
  DEAD: 'dead-letter',
});

/**
 * Throw this when a retry cannot possibly help: a malformed payload, a deleted asset, a
 * 4xx from an AWS API. BullMQ moves the job straight to failed, and maintenanceWorker
 * files it in the dead-letter queue.
 */
export class PermanentJobError extends UnrecoverableError {
  constructor(message, details) {
    super(message);
    this.name = 'PermanentJobError';
    this.details = details;
  }
}

const DEFAULTS = {
  [QUEUE_NAMES.TRANSCODE]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { age: 86_400, count: 1000 },
    removeOnFail: { age: 14 * 86_400 },
  },
  [QUEUE_NAMES.NOTIFY]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 3600, count: 5000 },
    removeOnFail: { age: 7 * 86_400 },
  },
  [QUEUE_NAMES.CHAT]: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: { age: 600, count: 10_000 },
    removeOnFail: { age: 86_400 },
  },
  [QUEUE_NAMES.RECORDING]: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 120_000 },
    removeOnComplete: { age: 7 * 86_400 },
    removeOnFail: { age: 30 * 86_400 },
  },
  [QUEUE_NAMES.MAINTENANCE]: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 30_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { age: 7 * 86_400 },
  },
  [QUEUE_NAMES.DEAD]: {
    attempts: 1,
    removeOnComplete: false,
    removeOnFail: false,
  },
};

/** Concurrency per worker task. Tuned per queue, overridable per environment. */
export const CONCURRENCY = Object.freeze({
  [QUEUE_NAMES.TRANSCODE]: Number(env.WORKER_CONCURRENCY_TRANSCODE ?? 10), // I/O bound: it waits on MediaConvert
  [QUEUE_NAMES.NOTIFY]: Number(env.WORKER_CONCURRENCY_NOTIFY ?? 20),
  [QUEUE_NAMES.CHAT]: Number(env.WORKER_CONCURRENCY_CHAT ?? 20),
  [QUEUE_NAMES.RECORDING]: Number(env.WORKER_CONCURRENCY_RECORDING ?? 1), // ffmpeg eats a core
  [QUEUE_NAMES.MAINTENANCE]: Number(env.WORKER_CONCURRENCY_MAINTENANCE ?? 2),
});

const registry = new Map();
const eventsRegistry = new Map();

function makeQueue(name) {
  const queue = new Queue(name, {
    connection: queueConnection(),
    prefix: QUEUE_PREFIX,
    defaultJobOptions: DEFAULTS[name],
  });
  registry.set(name, queue);
  return queue;
}

export const queues = Object.freeze({
  get transcode() {
    return registry.get(QUEUE_NAMES.TRANSCODE) ?? makeQueue(QUEUE_NAMES.TRANSCODE);
  },
  get notify() {
    return registry.get(QUEUE_NAMES.NOTIFY) ?? makeQueue(QUEUE_NAMES.NOTIFY);
  },
  get chat() {
    return registry.get(QUEUE_NAMES.CHAT) ?? makeQueue(QUEUE_NAMES.CHAT);
  },
  get recording() {
    return registry.get(QUEUE_NAMES.RECORDING) ?? makeQueue(QUEUE_NAMES.RECORDING);
  },
  get maintenance() {
    return registry.get(QUEUE_NAMES.MAINTENANCE) ?? makeQueue(QUEUE_NAMES.MAINTENANCE);
  },
  get dead() {
    return registry.get(QUEUE_NAMES.DEAD) ?? makeQueue(QUEUE_NAMES.DEAD);
  },
});

export function queueByName(name) {
  return registry.get(name) ?? makeQueue(name);
}

/**
 * Enqueue with an explicit idempotency key. Callers should always pass one: a request
 * handler that retries, a socket that reconnects and a webhook that AWS delivers twice
 * all produce the same job id and therefore one job.
 */
export async function enqueue(queueName, jobName, payload, { jobId, delay, priority, ...rest } = {}) {
  const queue = queueByName(queueName);
  const job = await queue.add(jobName, payload, { jobId, delay, priority, ...rest });
  metrics.increment?.('queue_job_enqueued', 1, { queue: queueName, job: jobName });
  return job;
}

/* ------------------------------------------------------------------ *
 * Worker factory
 * ------------------------------------------------------------------ */

const workers = new Set();

/**
 * Build a worker with the logging, metrics and failure classification every worker needs,
 * so an individual worker file contains only its own logic.
 *
 * @param {string} queueName
 * @param {(job: import('bullmq').Job) => Promise<unknown>} processor
 */
export function defineWorker(queueName, processor, options = {}) {
  const worker = new Worker(
    queueName,
    async (job) => {
      const started = Date.now();
      const log = logger.child({ queue: queueName, job: job.name, jobId: job.id, attempt: job.attemptsMade + 1 });

      try {
        const result = await processor(job, log);
        metrics.observe?.('queue_job_ms', Date.now() - started, { queue: queueName, job: job.name, outcome: 'ok' });
        return result;
      } catch (error) {
        const permanent = error instanceof UnrecoverableError;
        metrics.observe?.('queue_job_ms', Date.now() - started, {
          queue: queueName,
          job: job.name,
          outcome: permanent ? 'permanent' : 'retry',
        });
        log[permanent ? 'error' : 'warn'](
          { err: error, permanent, details: error.details ?? null },
          'queues: job failed',
        );
        throw error;
      }
    },
    {
      connection: workerConnection(queueName),
      prefix: QUEUE_PREFIX,
      concurrency: options.concurrency ?? CONCURRENCY[queueName] ?? 5,
      // A job that outlives its lock gets processed twice. Long jobs must extend the lock
      // via job.updateProgress() rather than raise this blindly.
      lockDuration: options.lockDuration ?? 60_000,
      stalledInterval: options.stalledInterval ?? 30_000,
      maxStalledCount: options.maxStalledCount ?? 2,
      ...options.workerOptions,
    },
  );

  worker.on('failed', (job, error) => {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (exhausted) {
      metrics.increment?.('queue_job_dead', 1, { queue: queueName, job: job.name });
      // Park it for a human. maintenanceWorker sweeps this queue and reports on it.
      queues.dead
        .add(
          'dead',
          {
            queue: queueName,
            name: job.name,
            data: job.data,
            failedReason: error?.message ?? String(error),
            attemptsMade: job.attemptsMade,
            failedAt: new Date().toISOString(),
          },
          { jobId: `dead:${queueName}:${job.id}` },
        )
        .catch((deadError) => logger.error({ err: deadError }, 'queues: dead-letter write failed'));
    }
  });

  worker.on('error', (error) => logger.error({ err: error, queue: queueName }, 'queues: worker error'));

  workers.add(worker);
  logger.info({ queue: queueName, concurrency: worker.opts.concurrency }, 'queues: worker started');
  return worker;
}

/* ------------------------------------------------------------------ *
 * Observability and shutdown
 * ------------------------------------------------------------------ */

/** Queue depth and oldest-job age, the two numbers the alarms in section 11.1 watch. */
export async function collectQueueMetrics() {
  const snapshot = {};
  for (const name of Object.values(QUEUE_NAMES)) {
    const queue = queueByName(name);
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    const [oldest] = await queue.getJobs(['waiting'], 0, 0, true);
    const oldestAgeMs = oldest?.timestamp ? Date.now() - oldest.timestamp : 0;

    snapshot[name] = { ...counts, oldestAgeMs };
    metrics.gauge?.('queue_depth', counts.waiting ?? 0, { queue: name });
    metrics.gauge?.('queue_active', counts.active ?? 0, { queue: name });
    metrics.gauge?.('queue_failed', counts.failed ?? 0, { queue: name });
    metrics.gauge?.('queue_oldest_age_ms', oldestAgeMs, { queue: name });
  }
  return snapshot;
}

export function queueEvents(name) {
  if (!eventsRegistry.has(name)) {
    eventsRegistry.set(name, new QueueEvents(name, { connection: queueConnection(), prefix: QUEUE_PREFIX }));
  }
  return eventsRegistry.get(name);
}

/**
 * Stop taking new jobs and let the running ones finish. `close(false)` waits for active
 * jobs — the whole point of a drain. gracefulShutdown calls this, then closeConnections().
 */
export async function closeWorkers({ timeoutMs = 25_000 } = {}) {
  const closing = [...workers].map((worker) => worker.close(false));
  const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.());
  await Promise.race([Promise.allSettled(closing), timeout]);
  workers.clear();
  logger.info('queues: workers closed');
}

export async function closeQueues() {
  await Promise.allSettled([...registry.values()].map((queue) => queue.close()));
  await Promise.allSettled([...eventsRegistry.values()].map((events) => events.close()));
  registry.clear();
  eventsRegistry.clear();
}