/**
 * recordingWorker — ffmpeg mux + upload (F1, F4)
 *
 * The SFU's PlainTransportRecorder writes raw per-track files while a lesson runs. When the
 * room ends, this worker turns them into one playable asset and hands it to the media
 * domain, after which it is an ordinary video: transcoded, captioned, quota-counted,
 * signed-delivered.
 *
 * This is the only worker that is genuinely CPU-heavy and the only one that touches the
 * disk, which drives three decisions:
 *
 *  - Concurrency 1. ffmpeg will take every core it is given; two muxes on one task make
 *    both slow and neither finishes sooner.
 *  - Scratch space is checked before starting and always cleaned in `finally`. A worker
 *    task that fills its volume takes every later job down with it, and the failure looks
 *    like something else entirely.
 *  - The BullMQ lock is extended through progress updates. A two-hour lesson mux outlives
 *    any sane lockDuration, and a lost lock means a second worker starts the same mux.
 *
 * Idempotency: keyed on the recording id. If the asset already exists and is complete, the
 * job cleans up and returns rather than re-encoding an hour of video.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { defineWorker, enqueue, QUEUE_NAMES, PermanentJobError } from '../queues.js';
import { env } from '../../config/env.js';
import * as recordingPipeline from '../../mediasoup/recording/recordingPipeline.js';
import * as UploadService from '../../media/UploadService.js';
import * as StorageGuard from '../../capacity/StorageGuard.js';
import { metrics } from '../../observability/metrics.js';

const SCRATCH_ROOT = env.RECORDING_SCRATCH_DIR ?? path.join(os.tmpdir(), 'recordings');
const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB headroom before starting a mux

const handlers = {
  'recording.mux': mux,
  'recording.cleanup': cleanup,
};

export function createRecordingWorker() {
  return defineWorker(QUEUE_NAMES.RECORDING, async (job, log) => {
    const handler = handlers[job.name];
    if (!handler) throw new PermanentJobError(`Unknown recording job: ${job.name}`);
    return handler(job, log);
  }, {
    concurrency: 1,
    // Long, but not the real protection — the progress heartbeat below is.
    lockDuration: 300_000,
  });
}

/* ------------------------------------------------------------------ *
 * Mux
 * ------------------------------------------------------------------ */

async function mux(job, log) {
  const { recordingId, roomId, lessonId, tenantId } = job.data;

  const recording = await recordingPipeline.get(recordingId);
  if (!recording) throw new PermanentJobError('Recording no longer exists', { recordingId });
  if (recording.status === 'ready' && recording.assetId) {
    log.info({ recordingId }, 'recording: already muxed');
    await scheduleCleanup(recordingId, recording.workDir);
    return { skipped: 'already-ready' };
  }
  if (!recording.tracks?.length) throw new PermanentJobError('Recording has no tracks', { recordingId });

  const workDir = recording.workDir ?? path.join(SCRATCH_ROOT, recordingId);
  const outputPath = path.join(workDir, `${recordingId}.mp4`);

  await assertDiskSpace(workDir, log);
  await recordingPipeline.markMuxing(recordingId);

  // Keeps the BullMQ lock alive across an encode that can run for an hour.
  const heartbeat = setInterval(() => {
    job.updateProgress({ stage: 'mux', at: Date.now() }).catch(() => {});
  }, 15_000);
  heartbeat.unref?.();

  const startedAt = Date.now();
  try {
    const args = recordingPipeline.buildFfmpegArgs(recording, { outputPath });
    await runFfmpeg(args, { log, onProgress: (seconds) => job.updateProgress({ stage: 'mux', seconds }).catch(() => {}) });

    const stat = await fs.stat(outputPath);
    if (stat.size === 0) throw new Error('ffmpeg produced an empty file');

    // Quota before upload — a recording is the largest object the platform creates.
    const quota = await StorageGuard.reserve({ tenantId, bytes: stat.size, purpose: 'recording' });
    if (!quota.ok) {
      await recordingPipeline.markFailed(recordingId, 'quota-exceeded');
      throw new PermanentJobError('Tenant storage quota exceeded; recording discarded', {
        recordingId,
        bytes: stat.size,
      });
    }

    const asset = await UploadService.uploadLocalFile({
      tenantId,
      filePath: outputPath,
      filename: `${lessonId ?? roomId}-${recordingId}.mp4`,
      contentType: 'video/mp4',
      purpose: 'recording',
      contextId: lessonId ?? null,
      reservationId: quota.reservationId,
    });

    await recordingPipeline.markReady({ recordingId, assetId: asset.id, durationSeconds: recording.durationSeconds });

    // From here it is an ordinary video asset: HLS ladder, then captions.
    await enqueue(QUEUE_NAMES.TRANSCODE, 'transcode.submit', { assetId: asset.id, ladder: 'standard' }, {
      jobId: `transcode:${asset.id}`,
    });

    metrics.observe?.('recording_mux_ms', Date.now() - startedAt);
    metrics.increment?.('recording_completed');
    log.info({ recordingId, assetId: asset.id, bytes: stat.size, ms: Date.now() - startedAt }, 'recording: muxed');

    await scheduleCleanup(recordingId, workDir);
    return { assetId: asset.id, bytes: stat.size };
  } catch (error) {
    if (!(error instanceof PermanentJobError)) {
      await recordingPipeline.markFailed(recordingId, error.message).catch(() => {});
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    // The mp4 goes either way; the raw tracks stay until cleanup, so a retry can re-mux.
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * ffmpeg
 * ------------------------------------------------------------------ */

function runFfmpeg(args, { log, onProgress }) {
  return new Promise((resolve, reject) => {
    const child = spawn(env.FFMPEG_PATH ?? 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    // ffmpeg writes progress to stderr; keep only the tail so a failure log is readable.
    const tail = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      tail.push(chunk);
      if (tail.length > 40) tail.shift();
      const match = /time=(\d+):(\d+):(\d+)/.exec(chunk);
      if (match && onProgress) {
        onProgress(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
      }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const detail = tail.join('').slice(-2000);
      log.error({ code, detail }, 'recording: ffmpeg failed');
      // A bad input file will fail identically on every retry.
      if (/Invalid data|No such file|Decoder .* not found/.test(detail)) {
        reject(new PermanentJobError(`ffmpeg cannot process this input (exit ${code})`, { detail }));
        return;
      }
      reject(new Error(`ffmpeg exited with ${code}`));
    });
  });
}

/* ------------------------------------------------------------------ *
 * Scratch space
 * ------------------------------------------------------------------ */

async function assertDiskSpace(workDir, log) {
  await fs.mkdir(workDir, { recursive: true });
  const stats = await fs.statfs(workDir);
  const freeBytes = stats.bavail * stats.bsize;

  if (freeBytes < MIN_FREE_BYTES) {
    log.error({ freeBytes, workDir }, 'recording: not enough scratch space');
    // Transient: another mux finishing, or the cleanup job, will free space.
    throw new Error(`Insufficient scratch space: ${Math.round(freeBytes / 1e9)} GB free`);
  }
}

async function scheduleCleanup(recordingId, workDir) {
  await enqueue(
    QUEUE_NAMES.RECORDING,
    'recording.cleanup',
    { recordingId, workDir },
    { jobId: `recording-cleanup:${recordingId}`, delay: 3_600_000 }, // an hour's grace for a manual re-mux
  );
}

async function cleanup(job, log) {
  const { recordingId, workDir } = job.data;
  if (!workDir?.startsWith(SCRATCH_ROOT)) {
    throw new PermanentJobError('Refusing to delete a path outside the scratch root', { workDir });
  }
  await fs.rm(workDir, { recursive: true, force: true });
  await recordingPipeline.markCleaned(recordingId).catch(() => {});
  log.info({ recordingId, workDir }, 'recording: scratch cleaned');
  return { cleaned: true };
}

export default createRecordingWorker;