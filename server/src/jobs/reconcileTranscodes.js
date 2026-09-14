/**
 * reconcileTranscodes — stuck asset sweeper (F4)
 *
 * An asset is supposed to move `processing` → `ready` when MediaConvert finishes and
 * EventBridge tells the webhook. Three things break that chain, all of them rare and all of
 * them invisible to the learner, who just sees a spinner forever:
 *
 *   - the EventBridge delivery is lost, or the webhook task was mid-deploy
 *   - the submit job died between creating the MediaConvert job and recording its id
 *   - MediaConvert failed and nobody was listening
 *
 * This sweep is the backstop for all three. It never transcodes anything itself — it
 * re-enqueues work onto the transcode queue, where the idempotency rules already live, so
 * running it twice costs nothing.
 *
 * Schedule: every 15 minutes.
 */

import { runJob, isMain } from './_runJob.js';
import { enqueue, QUEUE_NAMES } from '../queues/queues.js';
import * as TranscodeService from '../media/TranscodeService.js';
import * as UploadService from '../media/UploadService.js';
import { metrics } from '../observability/metrics.js';

/** Long enough that a normally slow transcode is not "stuck". */
const STUCK_AFTER_MINUTES = 45;
const FAILED_AFTER_HOURS = 12;
const BATCH = 200;

export async function reconcileTranscodes({ log, clock, argv = {} } = {}) {
  const limit = argv.limit ?? BATCH;
  const summary = { neverSubmitted: 0, repolled: 0, markedFailed: 0, completedLate: 0, scanned: 0 };

  /* 1 — uploaded and scanned, but no transcode job was ever created. */
  const unsubmitted = await UploadService.listNeedingTranscode({ limit });
  summary.scanned += unsubmitted.length;

  for (const asset of unsubmitted) {
    if (clock?.expired()) break;
    await enqueue(QUEUE_NAMES.TRANSCODE, 'transcode.submit', { assetId: asset.id }, {
      jobId: `transcode:${asset.id}`,
    });
    summary.neverSubmitted += 1;
  }

  /* 2 — submitted, still processing, past the point where that is normal. */
  const stuck = await TranscodeService.listStuck({ olderThanMinutes: STUCK_AFTER_MINUTES, limit });
  summary.scanned += stuck.length;

  for (const asset of stuck) {
    if (clock?.expired()) break;

    const state = await TranscodeService.describeRemoteJob(asset.transcodeJobId);

    if (!state) {
      // MediaConvert has no such job: the id was recorded for a job that never started, or
      // it aged out of the API's retention. Resubmit from scratch.
      await TranscodeService.clearSubmission(asset.id);
      await enqueue(QUEUE_NAMES.TRANSCODE, 'transcode.submit', { assetId: asset.id }, {
        jobId: `transcode:${asset.id}:resubmit:${Date.now()}`,
      });
      summary.neverSubmitted += 1;
      continue;
    }

    if (state.status === 'COMPLETE') {
      await TranscodeService.markComplete({ assetId: asset.id, outputs: state.outputs });
      summary.completedLate += 1;
      log.warn({ assetId: asset.id }, 'reconcile: completed but never delivered — check the EventBridge rule');
      continue;
    }

    if (state.status === 'ERROR' || state.status === 'CANCELED') {
      await TranscodeService.markFailed({ assetId: asset.id, reason: state.errorMessage ?? state.status });
      summary.markedFailed += 1;
      continue;
    }

    // Genuinely still running — re-arm the poll so it is watched again.
    await enqueue(QUEUE_NAMES.TRANSCODE, 'transcode.poll', { assetId: asset.id, attempt: 0 }, {
      jobId: `transcode-poll:${asset.id}:reconcile:${Math.floor(Date.now() / 900_000)}`,
      delay: 60_000,
    });
    summary.repolled += 1;
  }

  /* 3 — processing for half a day. Whatever happened, it is not coming back. */
  const abandoned = await TranscodeService.listStuck({ olderThanMinutes: FAILED_AFTER_HOURS * 60, limit });
  for (const asset of abandoned) {
    if (clock?.expired()) break;
    await TranscodeService.markFailed({ assetId: asset.id, reason: 'abandoned-by-reconciler' });
    summary.markedFailed += 1;
    log.error({ assetId: asset.id, hours: FAILED_AFTER_HOURS }, 'reconcile: asset abandoned');
  }

  metrics.gauge?.('transcode_stuck_assets', stuck.length);
  metrics.gauge?.('transcode_abandoned_assets', abandoned.length);
  return summary;
}

if (isMain(import.meta.url)) {
  await runJob('reconcileTranscodes', reconcileTranscodes, { timeBudgetMs: 5 * 60_000 });
}

export default reconcileTranscodes;