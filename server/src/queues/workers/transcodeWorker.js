/**
 * transcodeWorker — submit + poll MediaConvert (F4)
 *
 * Two job types, one queue:
 *
 *   transcode.submit   creates the MediaConvert job and records its id on the asset
 *   transcode.poll     a safety net that re-checks the job's state
 *
 * The happy path never runs `poll`. MediaConvert reports completion through EventBridge to
 * media/webhooks/mediaConvertWebhook.js, which flips the asset to `ready`. The poll job
 * exists because a missed EventBridge delivery would otherwise leave an asset stuck in
 * `processing` forever, and a learner staring at a spinner has no idea why.
 *
 * Idempotency, in a worker that spends money on every duplicate:
 *  - `submit` is keyed on the asset id, and the handler re-reads the asset first. If it
 *    already carries a MediaConvert job id, the worker adopts it rather than paying twice.
 *  - MediaConvert's own ClientRequestToken carries the same key, so even a race between
 *    two tasks ends with one job.
 */

import { MediaConvertClient, CreateJobCommand, GetJobCommand } from '@aws-sdk/client-mediaconvert';

import { defineWorker, enqueue, QUEUE_NAMES, PermanentJobError } from '../queues.js';
import { env } from '../../config/env.js';
import * as TranscodeService from '../../media/TranscodeService.js';
import * as TranscriptService from '../../media/TranscriptService.js';
import * as UploadService from '../../media/UploadService.js';
import { metrics } from '../../observability/metrics.js';

/** Endpoint is account-specific; resolved once at boot and cached for the task's life. */
const client = new MediaConvertClient({
  region: env.AWS_REGION,
  ...(env.MEDIACONVERT_ENDPOINT ? { endpoint: env.MEDIACONVERT_ENDPOINT } : {}),
});

const POLL_DELAYS_MS = [60_000, 120_000, 300_000, 600_000, 900_000];

const handlers = {
  'transcode.submit': submit,
  'transcode.poll': poll,
};

async function submit(job, log) {
  const { assetId, ladder = 'standard' } = job.data;

  const asset = await UploadService.getAsset(assetId);
  if (!asset) throw new PermanentJobError('Asset no longer exists', { assetId });
  if (asset.status === 'ready') {
    log.info({ assetId }, 'transcode: asset already ready, nothing to do');
    return { skipped: 'already-ready' };
  }
  if (asset.status === 'quarantined' || asset.status === 'rejected') {
    // Never transcode something the scanner refused to promote.
    throw new PermanentJobError('Asset did not pass the virus scan', { assetId, status: asset.status });
  }
  if (asset.transcodeJobId) {
    log.info({ assetId, mediaConvertJobId: asset.transcodeJobId }, 'transcode: adopting existing job');
    await schedulePoll(assetId, 0);
    return { adopted: asset.transcodeJobId };
  }

  const settings = TranscodeService.buildJobSettings(asset, { ladder });

  let response;
  try {
    response = await client.send(
      new CreateJobCommand({
        Role: env.MEDIACONVERT_ROLE_ARN,
        Queue: env.MEDIACONVERT_QUEUE_ARN,
        // Same token for the same asset: MediaConvert deduplicates for us.
        ClientRequestToken: `asset-${assetId}`,
        UserMetadata: { assetId, tenantId: asset.tenantId, ladder },
        Settings: settings,
      }),
    );
  } catch (error) {
    // 4xx from MediaConvert is a bad job definition — retrying twelve times only delays
    // the moment somebody reads the error.
    if (error?.$metadata?.httpStatusCode >= 400 && error.$metadata.httpStatusCode < 500) {
      throw new PermanentJobError(`MediaConvert rejected the job: ${error.message}`, { assetId });
    }
    throw error;
  }

  const mediaConvertJobId = response.Job?.Id;
  await TranscodeService.recordSubmission({ assetId, mediaConvertJobId, ladder });
  metrics.increment?.('transcode_submitted', 1, { ladder });
  log.info({ assetId, mediaConvertJobId }, 'transcode: job submitted');

  await schedulePoll(assetId, 0);
  return { mediaConvertJobId };
}

/**
 * The safety net. Runs on a widening schedule and stops as soon as the webhook has already
 * done the work — which is the normal case.
 */
async function poll(job, log) {
  const { assetId, attempt = 0 } = job.data;

  const asset = await UploadService.getAsset(assetId);
  if (!asset) throw new PermanentJobError('Asset no longer exists', { assetId });
  if (asset.status === 'ready' || asset.status === 'failed') return { settled: asset.status };
  if (!asset.transcodeJobId) throw new PermanentJobError('Asset has no MediaConvert job', { assetId });

  const { Job: mcJob } = await client.send(new GetJobCommand({ Id: asset.transcodeJobId }));
  const status = mcJob?.Status;

  if (status === 'COMPLETE') {
    // The webhook is late or lost. Finish the work here; both paths are idempotent.
    log.warn({ assetId }, 'transcode: completed via poll — check the EventBridge rule');
    await TranscodeService.markComplete({ assetId, outputs: mcJob.OutputGroupDetails ?? [] });
    metrics.increment?.('transcode_completed', 1, { via: 'poll' });

    if (TranscriptService.shouldCaption(asset)) {
      await enqueue(QUEUE_NAMES.TRANSCODE, 'transcript.submit', { assetId, language: asset.language ?? 'en' }, {
        jobId: `transcript:${assetId}`,
      });
    }
    return { status };
  }

  if (status === 'ERROR' || status === 'CANCELED') {
    await TranscodeService.markFailed({ assetId, reason: mcJob?.ErrorMessage ?? status });
    metrics.increment?.('transcode_failed', 1, { reason: status });
    throw new PermanentJobError(`MediaConvert job ${status}`, { assetId, errorMessage: mcJob?.ErrorMessage });
  }

  // Still running. Re-arm, or give up and let the reconcile sweeper see a stuck asset.
  if (attempt >= POLL_DELAYS_MS.length - 1) {
    await TranscodeService.markStalled({ assetId, lastStatus: status });
    return { status, stalled: true };
  }
  await schedulePoll(assetId, attempt + 1);
  return { status, requeued: true };
}

async function schedulePoll(assetId, attempt) {
  await enqueue(
    QUEUE_NAMES.TRANSCODE,
    'transcode.poll',
    { assetId, attempt },
    {
      // Attempt in the id: re-arming is a new job, but two workers re-arming the same
      // attempt is still one job.
      jobId: `transcode-poll:${assetId}:${attempt}`,
      delay: POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)],
    },
  );
}

async function transcript(job, log) {
  const { assetId, language = 'en' } = job.data;
  const result = await TranscriptService.submit({ assetId, language });
  log.info({ assetId, transcribeJobName: result.jobName }, 'transcode: transcription submitted');
  return result;
}

handlers['transcript.submit'] = transcript;

export function createTranscodeWorker() {
  return defineWorker(
    QUEUE_NAMES.TRANSCODE,
    async (job, log) => {
      const handler = handlers[job.name];
      if (!handler) throw new PermanentJobError(`Unknown transcode job: ${job.name}`);
      return handler(job, log);
    },
    // Nothing here is CPU bound — the work happens in MediaConvert and this waits on it.
    { concurrency: undefined, lockDuration: 120_000 },
  );
}

export default createTranscodeWorker;