/**
 * pruneRecordings — retention policy (F1, F4)
 *
 * Lesson recordings are the largest thing the platform stores and the one nobody ever
 * deletes by hand, so they are also the line item that quietly doubles the S3 bill. This
 * job applies the retention policy that was actually agreed, and nothing more.
 *
 * The exceptions matter more than the rule. A recording is kept regardless of age if:
 *   - it is pinned to a published lesson — it is course content now, not a session artefact
 *   - a learner's certificate cites it as evidence of attendance
 *   - it is under legal hold or attached to an open moderation report
 *   - the tenant has no retention policy at all (silence is not consent to delete)
 *
 * What gets deleted and by whom: this job deletes the *asset*, which removes the row, the
 * HLS renditions and the captions. The underlying objects go through the bucket's own
 * lifecycle rule, and versioning keeps them recoverable for the noncurrent-version window.
 * So a mistake here costs a restore, not the data.
 *
 * There is a warning path: recordings within a week of expiry generate a notification to
 * the host, so "it disappeared without warning" never happens.
 *
 * Schedule: daily, off-peak.
 */

import { runJob, isMain } from './_runJob.js';
import { enqueue, QUEUE_NAMES } from '../queues/queues.js';
import * as recordingPipeline from '../mediasoup/recording/recordingPipeline.js';
import * as UploadService from '../media/UploadService.js';
import * as StorageGuard from '../capacity/StorageGuard.js';
import { metrics } from '../observability/metrics.js';

const BATCH = 200;
const WARN_DAYS_BEFORE = 7;

export async function pruneRecordings({ log, clock, argv = {} } = {}) {
  const dryRun = Boolean(argv.dryRun);
  const summary = {
    tenants: 0,
    skippedNoPolicy: 0,
    warned: 0,
    deleted: 0,
    keptPinned: 0,
    keptHeld: 0,
    bytesReclaimed: 0,
    dryRun,
  };

  const tenants = await recordingPipeline.listRetentionPolicies();

  for (const tenant of tenants) {
    if (clock?.expired()) break;
    summary.tenants += 1;

    if (!tenant.retentionDays || tenant.retentionDays <= 0) {
      summary.skippedNoPolicy += 1;
      continue;
    }

    /* Warn first: a host should hear about it before it is gone. */
    const expiring = await recordingPipeline.listExpiring({
      tenantId: tenant.id,
      inDays: WARN_DAYS_BEFORE,
      retentionDays: tenant.retentionDays,
      limit: BATCH,
    });

    for (const recording of expiring) {
      if (recording.warnedAt || dryRun) continue;
      await enqueue(
        QUEUE_NAMES.NOTIFY,
        'notification.fanout',
        {
          kind: 'recording.expiring',
          recipientIds: [recording.hostId],
          title: 'A recording is about to be deleted',
          body: `"${recording.title}" will be removed in ${WARN_DAYS_BEFORE} days under your retention policy.`,
          url: `/lessons/${recording.lessonId ?? ''}/recording`,
          channels: ['email', 'in-app'],
          data: { recordingId: recording.id },
        },
        { jobId: `recording-expiring:${recording.id}` },
      );
      await recordingPipeline.markWarned(recording.id);
      summary.warned += 1;
    }

    /* Then delete what is past retention and not exempt. */
    let more = true;
    while (more && !clock?.expired()) {
      const expired = await recordingPipeline.listExpired({
        tenantId: tenant.id,
        retentionDays: tenant.retentionDays,
        limit: BATCH,
      });
      more = expired.length === BATCH;
      if (expired.length === 0) break;

      for (const recording of expired) {
        if (clock?.expired()) break;

        if (recording.pinnedToPublishedLesson || recording.citedByCertificate) {
          summary.keptPinned += 1;
          continue;
        }
        if (recording.legalHold || recording.openReportId) {
          summary.keptHeld += 1;
          continue;
        }
        if (dryRun) {
          summary.deleted += 1;
          continue;
        }

        // Deleting the asset takes the renditions and captions with it; the bytes go on
        // the bucket's lifecycle schedule, with versioning as the undo.
        const removed = await UploadService.softDelete({
          assetId: recording.assetId,
          reason: 'recording-retention',
          system: true,
        });

        await recordingPipeline.markPurged(recording.id);
        await StorageGuard.release({ tenantId: tenant.id, bytes: removed?.bytes ?? 0 }).catch(() => {});

        summary.deleted += 1;
        summary.bytesReclaimed += removed?.bytes ?? 0;
      }
    }
  }

  metrics.increment?.('recordings_pruned', summary.deleted);
  metrics.gauge?.('recordings_bytes_reclaimed', summary.bytesReclaimed);
  log.info(summary, 'recordings: retention applied');
  return summary;
}

if (isMain(import.meta.url)) {
  await runJob('pruneRecordings', pruneRecordings, { timeBudgetMs: 20 * 60_000, lockTtlMs: 25 * 60_000 });
}

export default pruneRecordings;