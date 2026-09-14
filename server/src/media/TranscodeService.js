// classroom-app/server/src/media/TranscodeService.js
/**
 * Transcoding  (F4)  [NEW]
 *
 * Turns an uploaded video into an HLS ladder so it plays on a phone on mobile
 * data and on a laptop on fibre, without either of them choosing badly.
 *
 * The ladder is built from what the source actually is, not from a fixed list.
 * Upscaling a 480p webcam recording to 1080p produces a bigger file that looks
 * identical — the rung is pure cost — so the ladder never exceeds the source.
 *
 * The job is submitted here and completed by a webhook. Polling is the fallback
 * for when EventBridge drops something, which it does rarely enough that a
 * poller as the primary path would be waste and often enough that not having
 * one leaves assets stuck in `processing` forever.
 */

import { env } from '../config/env.js';
import { buckets } from '../config/storage.config.js';
import { logger } from '../observability/logger.js';
import * as Assets from './models/Asset.js';

const log = logger.child({ component: 'transcode' });

/**
 * Candidate rungs, largest first. 240p exists for the learner on a train; 1080p
 * for the shared screen where the text has to be readable.
 */
const LADDER = [
  { label: '1080p', height: 1080, bitrateKbps: 4_500, maxSourceHeight: 1080 },
  { label: '720p', height: 720, bitrateKbps: 2_400, maxSourceHeight: 720 },
  { label: '480p', height: 480, bitrateKbps: 1_100, maxSourceHeight: 480 },
  { label: '240p', height: 240, bitrateKbps: 400, maxSourceHeight: 240 },
];

// ---------------------------------------------------------------------------
// Ladder  (pure)
// ---------------------------------------------------------------------------

/**
 * Which rungs to produce for a given source.
 *
 * @param {{ height?: number|null, durationSec?: number|null, kind?: string }} probe
 */
export const buildLadder = (probe = {}) => {
  const sourceHeight = probe.height ?? 720;

  // Never upscale, and always keep at least the lowest rung so a weak
  // connection has somewhere to go.
  const rungs = LADDER.filter((rung) => rung.height <= sourceHeight);
  const selected = rungs.length > 0 ? rungs : [LADDER.at(-1)];

  // An audio-only rendition for lectures people listen to while commuting.
  // Only worth the encode above ten minutes.
  const withAudio =
    (probe.durationSec ?? 0) > 600
      ? [...selected, { label: 'audio', height: null, bitrateKbps: 96 }]
      : selected;

  return withAudio;
};

/** Six seconds: short enough to switch rung quickly, long enough to be cheap. */
export const SEGMENT_SECONDS = 6;

const outputGroup = (ladder, destination) => ({
  Name: 'Apple HLS',
  OutputGroupSettings: {
    Type: 'HLS_GROUP_SETTINGS',
    HlsGroupSettings: {
      Destination: destination,
      SegmentLength: SEGMENT_SECONDS,
      MinSegmentLength: 0,
      // Single file per rung rather than thousands of .ts segments: fewer
      // objects, fewer requests, and a CDN that caches whole renditions.
      SegmentControl: 'SEGMENTED_FILES',
      ManifestDurationFormat: 'INTEGER',
      OutputSelection: 'MANIFESTS_AND_SEGMENTS',
    },
  },
  Outputs: ladder.map((rung) =>
    rung.label === 'audio'
      ? {
          NameModifier: '_audio',
          AudioDescriptions: [
            { CodecSettings: { Codec: 'AAC', AacSettings: { Bitrate: rung.bitrateKbps * 1000, CodingMode: 'CODING_MODE_2_0', SampleRate: 48_000 } } },
          ],
          ContainerSettings: { Container: 'M3U8' },
        }
      : {
          NameModifier: `_${rung.label}`,
          VideoDescription: {
            Height: rung.height,
            CodecSettings: {
              Codec: 'H_264',
              H264Settings: {
                RateControlMode: 'QVBR',
                MaxBitrate: rung.bitrateKbps * 1000,
                // Keyframes on the segment boundary, or a player cannot switch
                // rung cleanly and stutters every time the network changes.
                GopSize: SEGMENT_SECONDS,
                GopSizeUnits: 'SECONDS',
                SceneChangeDetect: 'TRANSITION_DETECTION',
              },
            },
          },
          AudioDescriptions: [
            { CodecSettings: { Codec: 'AAC', AacSettings: { Bitrate: 128_000, CodingMode: 'CODING_MODE_2_0', SampleRate: 48_000 } } },
          ],
          ContainerSettings: { Container: 'M3U8' },
        },
  ),
});

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export const submitJob = async ({ assetId }) => {
  const asset = await Assets.findById(assetId);
  if (!asset) return { skipped: true, reason: 'asset is gone' };
  if (asset.status !== 'processing') {
    return { skipped: true, reason: `asset is ${asset.status}` };
  }

  if (!env.MEDIACONVERT_ROLE_ARN) {
    // No transcoder configured — development, or a deployment that serves
    // originals. The asset is usable as it stands rather than stuck.
    log.warn({ assetId }, 'no MediaConvert role; serving the original');
    await Assets.setStatus({ assetId, from: 'processing', to: 'ready' });
    return { skipped: true, reason: 'transcoding not configured' };
  }

  const { MediaConvertClient, CreateJobCommand } = await import('@aws-sdk/client-mediaconvert');
  const client = new MediaConvertClient({
    region: env.AWS_REGION,
    endpoint: env.MEDIACONVERT_ENDPOINT || undefined,
  });

  const ladder = buildLadder(asset.probe);
  const prefix = asset.objectKey.replace(/\.[^.]+$/, '');
  const destination = `s3://${buckets.delivery}/${prefix}/hls/`;

  const job = await client.send(
    new CreateJobCommand({
      Role: env.MEDIACONVERT_ROLE_ARN,
      Queue: env.MEDIACONVERT_QUEUE_ARN || undefined,
      // Echoed back on the completion event, so the webhook knows which asset
      // this was without a lookup table.
      UserMetadata: { assetId, purpose: asset.purpose },
      Settings: {
        Inputs: [
          {
            FileInput: `s3://${buckets.delivery}/${asset.objectKey}`,
            AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
            VideoSelector: {},
          },
        ],
        OutputGroups: [
          outputGroup(ladder, destination),
          // A poster frame, taken a few seconds in: frame zero of a lecture is
          // almost always a black screen or somebody's half-open mouth.
          {
            Name: 'Thumbnail',
            OutputGroupSettings: {
              Type: 'FILE_GROUP_SETTINGS',
              FileGroupSettings: { Destination: `s3://${buckets.delivery}/${prefix}/thumb/` },
            },
            Outputs: [
              {
                NameModifier: '_poster',
                VideoDescription: {
                  Width: 1280,
                  CodecSettings: {
                    Codec: 'FRAME_CAPTURE',
                    FrameCaptureSettings: { FramerateNumerator: 1, FramerateDenominator: 10, MaxCaptures: 1, Quality: 80 },
                  },
                },
                ContainerSettings: { Container: 'RAW' },
              },
            ],
          },
        ],
      },
    }),
  );

  await Assets.setStatus({
    assetId,
    to: 'processing',
    patch: {},
  });

  await recordJob({ assetId, jobId: job.Job.Id, state: 'queued' });

  log.info({ assetId, jobId: job.Job.Id, rungs: ladder.length }, 'transcode submitted');
  return { jobId: job.Job.Id, ladder };
};

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * Called by the webhook, and by the reconcile job when the webhook never came.
 * Idempotent: the status guard means a second call changes nothing.
 */
export const completeJob = async ({ assetId, jobId, outputs = [], durationMs = null }) => {
  const asset = await Assets.findById(assetId);
  if (!asset) return { skipped: true };
  if (asset.status === 'ready') return { skipped: true, reason: 'already ready' };

  const prefix = asset.objectKey.replace(/\.[^.]+$/, '');

  const renditions = outputs
    .filter((output) => output.height)
    .map((output) => ({
      label: output.height >= 1080 ? '1080p' : `${output.height}p`,
      width: output.width ?? null,
      height: output.height,
      bitrateKbps: Math.round((output.bitrate ?? 0) / 1000),
    }));

  const updated = await Assets.setStatus({
    assetId,
    from: 'processing',
    to: 'ready',
    patch: {
      renditions,
      durationSec: durationMs ? Math.round(durationMs / 1000) : asset.probe.durationSec,
      // The manifest, not the original, is what a player is given.
      objectKey: `${prefix}/hls/index.m3u8`,
    },
  });

  await recordJob({ assetId, jobId, state: 'succeeded' });
  log.info({ assetId, jobId, renditions: renditions.length }, 'transcode complete');

  // Captions are worth having and not worth blocking playback on.
  const { enqueueTranscript } = await import('../queues/queues.js');
  await enqueueTranscript({ assetId }).catch(() => undefined);

  notify(assetId, 'media:asset.ready', {
    assetId,
    purpose: asset.purpose,
    kind: asset.kind,
    durationSec: updated?.probe.durationSec ?? null,
    hasCaptions: false,
    readyAt: new Date().toISOString(),
  });

  return { ready: true, renditions };
};

export const failJob = async ({ assetId, jobId, reason, retryable = false }) => {
  await Assets.setStatus({
    assetId,
    from: 'processing',
    to: 'failed',
    // The provider's message is kept in the job row; the learner-facing error
    // says what they can do about it.
    error: 'This video could not be processed. Try uploading it again.',
  });

  await recordJob({ assetId, jobId, state: 'failed', error: reason });
  log.error({ assetId, jobId, reason }, 'transcode failed');

  notify(assetId, 'media:transcode.failed', {
    assetId,
    jobId,
    reason: 'This video could not be processed.',
    retryable,
    failedAt: new Date().toISOString(),
  });

  return { failed: true };
};

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Asks MediaConvert directly about assets that have been processing too long.
 * Called by jobs/reconcileTranscodes.js. This is the safety net for a dropped
 * EventBridge event — without it an asset sits in `processing` indefinitely and
 * the learner sees a spinner that never resolves.
 */
export const reconcile = async ({ olderThanMinutes = 90 } = {}) => {
  const stuck = await Assets.findStuckProcessing({ olderThanMinutes });
  if (stuck.length === 0) return { checked: 0, resolved: 0 };

  if (!env.MEDIACONVERT_ROLE_ARN) return { checked: stuck.length, resolved: 0 };

  const { MediaConvertClient, GetJobCommand } = await import('@aws-sdk/client-mediaconvert');
  const client = new MediaConvertClient({
    region: env.AWS_REGION,
    endpoint: env.MEDIACONVERT_ENDPOINT || undefined,
  });

  let resolved = 0;

  for (const asset of stuck) {
    const jobId = await lastJobId(asset.assetId);
    if (!jobId) {
      // Never submitted, or the submission failed. Resubmitting is right.
      await submitJob({ assetId: asset.assetId }).catch(() => undefined);
      continue;
    }

    try {
      const { Job } = await client.send(new GetJobCommand({ Id: jobId }));

      if (Job.Status === 'COMPLETE') {
        await completeJob({ assetId: asset.assetId, jobId, outputs: [] });
        resolved += 1;
      } else if (Job.Status === 'ERROR' || Job.Status === 'CANCELED') {
        await failJob({ assetId: asset.assetId, jobId, reason: Job.ErrorMessage ?? Job.Status });
        resolved += 1;
      }
      // PROGRESSING and SUBMITTED are left alone: a long video is allowed to
      // take a long time.
    } catch (cause) {
      log.error({ err: cause, assetId: asset.assetId, jobId }, 'could not check a transcode job');
    }
  }

  log.info({ checked: stuck.length, resolved }, 'transcode reconciliation finished');
  return { checked: stuck.length, resolved };
};

export const getJob = async (assetId) => {
  const { pool } = await import('../db/pool.js');
  const { rows } = await pool.query(
    `SELECT * FROM transcode_jobs WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [assetId],
  );
  if (!rows[0]) return null;

  return {
    jobId: rows[0].job_id,
    assetId,
    state: rows[0].state,
    progressPercent: rows[0].progress_percent ?? 0,
    error: rows[0].error,
    startedAt: rows[0].created_at.toISOString(),
    finishedAt: rows[0].finished_at?.toISOString() ?? null,
  };
};

const recordJob = async ({ assetId, jobId, state, error = null }) => {
  const { pool } = await import('../db/pool.js');
  await pool
    .query(
      `INSERT INTO transcode_jobs (asset_id, job_id, state, error, finished_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $3 IN ('succeeded','failed') THEN now() ELSE NULL END)
       ON CONFLICT (job_id) DO UPDATE
         SET state = EXCLUDED.state, error = EXCLUDED.error, finished_at = EXCLUDED.finished_at`,
      [assetId, jobId, state, error],
    )
    .catch((cause) => log.error({ err: cause, jobId }, 'could not record the transcode job'));
};

const lastJobId = async (assetId) => (await getJob(assetId))?.jobId ?? null;

const notify = (assetId, event, payload) => {
  void import('../realtime/presenceGateway.js')
    .then(({ broadcastToAssetWatchers }) => broadcastToAssetWatchers(assetId, event, payload))
    .catch(() => undefined);
};

export default { submitJob, completeJob, failJob, reconcile, getJob, buildLadder };