/**
 * maintenanceWorker — sweeps, retries, dead letters (F7)
 *
 * The jobs nobody asks for and everybody needs. EventBridge fires these on a schedule
 * through jobs/; each one is leader-elected with a Redis lock so two tasks waking at the
 * same minute do the work once.
 *
 * Principles for everything in this file:
 *  - A sweep repairs, it does not delete. Anything destructive is either retention policy
 *    the tenant configured, or it moves the row to a state a human can inspect.
 *  - Sweeps are batched and bounded. An unbounded repair job that runs after a week-long
 *    outage will hold a connection for an hour and take the database with it.
 *  - Every sweep reports what it found even when it found nothing, because "the sweep is
 *    not running" and "there was nothing to sweep" look identical in a log that is silent.
 */

import { defineWorker, enqueue, queues, collectQueueMetrics, QUEUE_NAMES, PermanentJobError } from '../queues.js';
import { acquireLock } from '../connection.js';
import { metrics } from '../../observability/metrics.js';
import * as UploadService from '../../media/UploadService.js';
import * as StorageGuard from '../../capacity/StorageGuard.js';
import * as ReminderRules from '../../scheduling/ReminderRules.js';

const BATCH = 500;

const handlers = {
  'maintenance.queueMetrics': queueMetricsSweep,
  'maintenance.deadLetters': deadLetterReport,
  'maintenance.retryFailed': retryFailed,
  'maintenance.stuckUploads': stuckUploads,
  'maintenance.quotaDrift': quotaDrift,
  'maintenance.reminders': reminderSweep,
  'maintenance.orphanedObjects': orphanedObjects,
};

export function createMaintenanceWorker() {
  return defineWorker(QUEUE_NAMES.MAINTENANCE, async (job, log) => {
    const handler = handlers[job.name];
    if (!handler) throw new PermanentJobError(`Unknown maintenance job: ${job.name}`);

    // Single-runner: EventBridge can deliver twice, and two tasks can wake together.
    const release = await acquireLock(`maintenance:${job.name}`, 10 * 60_000);
    if (!release) {
      log.debug({ job: job.name }, 'maintenance: another task holds the lock');
      return { skipped: 'not-leader' };
    }
    try {
      return await handler(job, log);
    } finally {
      await release();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Queue health
 * ------------------------------------------------------------------ */

/** Feeds the transcode-lag and chat-latency alarms. Runs every minute. */
async function queueMetricsSweep(_job, log) {
  const snapshot = await collectQueueMetrics();
  log.info({ snapshot }, 'maintenance: queue metrics');
  return snapshot;
}

/**
 * Dead letters are not retried automatically — they got there by failing every attempt.
 * This reports them, loudly enough to page someone if the count is climbing.
 */
async function deadLetterReport(_job, log) {
  const jobs = await queues.dead.getJobs(['waiting', 'completed'], 0, BATCH - 1);
  const byQueue = {};
  for (const job of jobs) {
    const key = `${job.data.queue}:${job.data.name}`;
    byQueue[key] = (byQueue[key] ?? 0) + 1;
  }

  metrics.gauge?.('dead_letter_total', jobs.length);
  if (jobs.length > 0) log.error({ total: jobs.length, byQueue }, 'maintenance: dead letters waiting');
  return { total: jobs.length, byQueue };
}

/**
 * Retry jobs that failed for a reason that has probably passed — an AWS throttle, a
 * failover. Bounded and deliberately conservative: anything that failed permanently is
 * skipped, since a PermanentJobError will fail the same way forever.
 */
async function retryFailed(job, log) {
  const queueName = job.data.queue ?? QUEUE_NAMES.NOTIFY;
  const olderThanMs = job.data.olderThanMs ?? 15 * 60_000;
  const queue = queues[queueName] ?? null;
  if (!queue) throw new PermanentJobError(`Unknown queue: ${queueName}`);

  const failed = await queue.getJobs(['failed'], 0, BATCH - 1);
  let retried = 0;

  for (const failedJob of failed) {
    const age = Date.now() - (failedJob.finishedOn ?? failedJob.timestamp ?? 0);
    if (age < olderThanMs) continue;
    if (/PermanentJobError|Unrecoverable/.test(failedJob.failedReason ?? '')) continue;

    await failedJob.retry();
    retried += 1;
  }

  log.info({ queue: queueName, candidates: failed.length, retried }, 'maintenance: retried failed jobs');
  return { queue: queueName, retried };
}

/* ------------------------------------------------------------------ *
 * Media sweeps (F4)
 * ------------------------------------------------------------------ */

/**
 * Uploads abandoned mid-flight: the browser was closed, the phone lost signal. The S3
 * multipart upload is aborted (it is billed until it is), the quota reservation released,
 * and the asset row marked so it stops showing a progress bar that will never move.
 */
async function stuckUploads(job, log) {
  const olderThanMinutes = job.data.olderThanMinutes ?? 60 * 24;
  const stale = await UploadService.listStale({ olderThanMinutes, limit: BATCH });

  let aborted = 0;
  for (const asset of stale) {
    try {
      await UploadService.abort({ assetId: asset.id, reason: 'stale', system: true });
      await StorageGuard.releaseReservation(asset.reservationId).catch(() => {});
      aborted += 1;
    } catch (error) {
      log.warn({ err: error, assetId: asset.id }, 'maintenance: could not abort a stale upload');
    }
  }

  log.info({ found: stale.length, aborted }, 'maintenance: stale uploads swept');
  return { found: stale.length, aborted };
}

/**
 * Recorded usage drifts from reality — an aborted upload, a failed delete, a replica lag.
 * This recomputes per tenant and repairs the counter. It is also the alarm in section 11.1:
 * a large drift means something is leaking.
 */
async function quotaDrift(job, log) {
  const tenants = job.data.tenantIds ?? (await StorageGuard.tenantsToAudit({ limit: 50 }));
  const drifted = [];

  for (const tenantId of tenants) {
    const { recordedBytes, actualBytes } = await StorageGuard.recompute(tenantId);
    const delta = actualBytes - recordedBytes;
    if (Math.abs(delta) > 10 * 1024 * 1024) {
      drifted.push({ tenantId, recordedBytes, actualBytes, delta });
      await StorageGuard.repair(tenantId, actualBytes);
    }
  }

  metrics.gauge?.('storage_quota_drift_tenants', drifted.length);
  if (drifted.length > 0) log.warn({ drifted }, 'maintenance: storage quota drift repaired');
  return { audited: tenants.length, repaired: drifted.length };
}

/**
 * Objects in the raw and quarantine buckets with no asset row — an upload that was
 * presigned and then abandoned, or a row deleted before its object. Reported, never
 * deleted here: lifecycle rules on the bucket do the deleting, on a schedule the tenant
 * can see.
 */
async function orphanedObjects(job, log) {
  const report = await UploadService.findOrphanedObjects({ limit: job.data.limit ?? 1000 });
  metrics.gauge?.('storage_orphaned_objects', report.objects.length);
  if (report.objects.length > 0) {
    log.warn({ count: report.objects.length, bytes: report.totalBytes }, 'maintenance: orphaned objects found');
  }
  return { count: report.objects.length, totalBytes: report.totalBytes };
}

/* ------------------------------------------------------------------ *
 * Scheduling (F1, F3)
 * ------------------------------------------------------------------ */

/**
 * Two things at once: hand due reminders to the notify queue, and re-plan any upcoming
 * session whose reminder rows went missing (a Redis flush, an outage during creation).
 */
async function reminderSweep(_job, log) {
  const due = await ReminderRules.enqueueDue();
  const resynced = await ReminderRules.resyncUpcoming({ withinMs: 48 * 3600_000 });

  log.info({ ...due, resynced }, 'maintenance: reminders swept');
  return { ...due, resynced };
}

/* ------------------------------------------------------------------ *
 * Scheduling helper for jobs/
 * ------------------------------------------------------------------ */

/**
 * Called by the EventBridge entrypoints in jobs/. The job id carries the minute, so a
 * duplicate EventBridge delivery lands on the same id and is ignored by BullMQ — belt and
 * braces with the Redis lock above.
 */
export async function scheduleMaintenance(name, data = {}) {
  const minute = new Date().toISOString().slice(0, 16);
  return enqueue(QUEUE_NAMES.MAINTENANCE, name, data, { jobId: `${name}:${minute}` });
}

export default createMaintenanceWorker;