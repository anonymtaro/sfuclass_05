// classroom-app/server/src/mediasoup/recording/recordingPipeline.js
/**
 * Recording lifecycle  (F4)  [NEW]
 *
 * Owns a recording from the moment a host presses record to the moment the
 * asset is playable:
 *
 *   start   pick what to record, tap it, spawn ffmpeg
 *   run     follow the room — a new screen share or a changed speaker restarts
 *           the tap so the recording follows the lesson rather than one person
 *   stop    finalise the file, upload it, register an Asset, hand it to the
 *           worker for transcoding
 *
 * The upload is server-side and direct to S3, not through the presigned flow
 * clients use: there is no browser here, the file is already on local disk, and
 * the SFU task holds an IAM role that can write to the raw bucket.
 *
 * Failure policy is deliberate. A recording that cannot be uploaded is kept on
 * disk and retried, because the alternative is losing a lecture nobody can
 * repeat. A recording that cannot be started does not stop the lesson — the
 * host is told, and the class continues.
 */

import { randomUUID } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import { env } from '../../config/env.js';
import { buildKey, purposes } from '../../config/storage.config.js';
import { logger } from '../../observability/logger.js';
import { PlainTransportRecorder } from './PlainTransportRecorder.js';

const log = logger.child({ component: 'recording-pipeline' });

/** roomId -> session. One recording per room; a second start is a no-op. */
const sessions = new Map();

/**
 * What gets recorded when several people are producing.
 *
 * 'screen-priority' is the default because a lesson with a shared screen is
 * almost always about the screen. Falling back to the active speaker means a
 * discussion still records something useful.
 */
const pickSources = (room, strategy = 'screen-priority') => {
  const screen = room.findProducer?.({ source: 'screen' });
  const speaker = room.getActiveSpeaker?.();

  const videoProducer =
    strategy === 'screen-priority' && screen
      ? screen
      : (speaker?.producers?.camera ?? screen ?? null);

  // Everyone's audio would need mixing, which means re-encoding, which means
  // burning SFU cpu. The host's track is recorded and the worker mixes the
  // rest from the per-peer tracks if a full mix is ever wanted.
  const audioProducer = room.getHostProducer?.('microphone') ?? speaker?.producers?.microphone ?? null;

  return { videoProducer, audioProducer, followed: videoProducer === screen ? 'screen' : 'speaker' };
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export const startRecording = async ({ room, startedBy, strategy = 'screen-priority' }) => {
  if (!env.RECORDING_ENABLED) {
    throw new Error('recording is disabled on this deployment');
  }
  if (sessions.has(room.id)) {
    return sessions.get(room.id).summary();
  }

  const sessionId = randomUUID();
  const { videoProducer, audioProducer, followed } = pickSources(room, strategy);

  const recorder = new PlainTransportRecorder({
    roomId: room.id,
    router: room.router,
    sessionId,
  });

  const session = {
    sessionId,
    roomId: room.id,
    lessonId: room.lessonId ?? null,
    startedBy,
    startedAt: new Date().toISOString(),
    strategy,
    followed,
    recorder,
    summary: () => ({
      sessionId,
      roomId: room.id,
      startedAt: session.startedAt,
      recording: recorder.isRunning,
      following: session.followed,
    }),
  };

  try {
    await recorder.start({ audioProducer, videoProducer });
    sessions.set(room.id, session);

    // Everyone in the room must know. Recording someone without telling them
    // is a legal problem in most of the places this will run.
    room.broadcast?.('classroom:recording.changed', {
      recording: true,
      startedBy: startedBy?.userId ?? null,
    });

    log.info({ roomId: room.id, sessionId, followed }, 'recording started');
    return session.summary();
  } catch (cause) {
    // The lesson continues. Only the recording failed.
    log.error({ err: cause, roomId: room.id }, 'could not start recording');
    throw cause;
  }
};

/**
 * Re-points the tap without ending the file. Called when someone starts or
 * stops sharing a screen, so a recording follows the lesson.
 *
 * This does end up as two files. Stitching them is the worker's job during
 * transcoding — doing it here would mean re-encoding on the SFU.
 */
export const followRoomChange = async ({ room, reason }) => {
  const session = sessions.get(room.id);
  if (!session) return null;

  const { videoProducer } = pickSources(room, session.strategy);
  const nowFollowing = videoProducer ? 'screen' : 'speaker';
  if (nowFollowing === session.followed) return session.summary();

  log.info({ roomId: room.id, reason, from: session.followed, to: nowFollowing }, 'recording source changed');

  const previous = await session.recorder.stop();
  session.segments = [...(session.segments ?? []), previous];

  const recorder = new PlainTransportRecorder({
    roomId: room.id,
    router: room.router,
    sessionId: `${session.sessionId}-${(session.segments.length + 1).toString().padStart(2, '0')}`,
  });

  const { audioProducer } = pickSources(room, session.strategy);
  await recorder.start({ audioProducer, videoProducer });

  session.recorder = recorder;
  session.followed = nowFollowing;
  return session.summary();
};

// ---------------------------------------------------------------------------
// Stop and upload
// ---------------------------------------------------------------------------

export const stopRecording = async ({ roomId, reason = 'host' }) => {
  const session = sessions.get(roomId);
  if (!session) return null;
  sessions.delete(roomId);

  const final = await session.recorder.stop();
  const segments = [...(session.segments ?? []), final];
  const durationSec = segments.reduce((total, segment) => total + segment.durationSec, 0);

  log.info({ roomId, sessionId: session.sessionId, durationSec, segments: segments.length, reason }, 'recording stopped');

  // A recording shorter than this is somebody pressing the button twice.
  if (durationSec < 5) {
    await session.recorder.cleanup();
    return { sessionId: session.sessionId, discarded: true, reason: 'too short' };
  }

  try {
    const assets = [];
    for (const [index, segment] of segments.entries()) {
      assets.push(await uploadSegment({ session, segment, index }));
    }

    await session.recorder.cleanup();

    // The worker takes it from here: HLS ladder, captions, thumbnail.
    const { enqueueTranscode } = await import('../../queues/queues.js');
    for (const asset of assets) {
      await enqueueTranscode({ assetId: asset.assetId, purpose: 'recording' });
    }

    return {
      sessionId: session.sessionId,
      durationSec,
      assets: assets.map((asset) => asset.assetId),
      discarded: false,
    };
  } catch (cause) {
    // Deliberately not cleaned up. The file stays on disk and
    // jobs/reconcileTranscodes.js finds it; losing a lecture to a transient S3
    // error is not an acceptable outcome.
    log.error(
      { err: cause, sessionId: session.sessionId, path: session.recorder.outputPath },
      'recording upload failed; the file has been kept for retry',
    );
    throw cause;
  }
};

const uploadSegment = async ({ session, segment, index }) => {
  const { size } = await stat(segment.outputPath);
  const assetId = randomUUID();

  const key = buildKey('recording', { roomId: session.roomId, assetId });
  const objectKey = `${key}/${index.toString().padStart(2, '0')}.mp4`;

  const { putObject } = await import('../../media/StorageClient.js');
  const { registerAsset } = await import('../../media/UploadService.js');

  // Straight into raw. Recordings are produced by this platform, not uploaded
  // by a user, so they skip the quarantine scan.
  await putObject({
    bucket: 'raw',
    key: objectKey,
    body: await readFile(segment.outputPath),
    contentType: 'video/mp4',
  });

  const retentionDays = purposes.recording.retentionDays;

  return registerAsset({
    assetId,
    purpose: 'recording',
    kind: 'video',
    status: 'processing',
    fileName: `${session.lessonId ?? session.roomId}-${index + 1}.mp4`,
    contentType: 'video/mp4',
    sizeBytes: size,
    objectKey,
    ownerId: session.startedBy?.userId ?? null,
    metadata: {
      roomId: session.roomId,
      lessonId: session.lessonId ?? '',
      sessionId: session.sessionId,
      durationSec: String(segment.durationSec),
      followed: session.followed,
    },
    expiresAt: retentionDays
      ? new Date(Date.now() + retentionDays * 86_400_000).toISOString()
      : null,
  });
};

// ---------------------------------------------------------------------------
// Room and node lifecycle
// ---------------------------------------------------------------------------

/** A room ending while recording still has to produce a file. */
export const handleRoomClosed = async (roomId) => {
  if (!sessions.has(roomId)) return null;
  return stopRecording({ roomId, reason: 'room-closed' }).catch((cause) => {
    log.error({ err: cause, roomId }, 'could not finalise a recording on room close');
    return null;
  });
};

/**
 * Shutdown step for the SFU. Runs before the drain wait, so recordings are
 * finalised while the rooms are still alive rather than after they are gone.
 */
export const stopAllRecordings = async () => {
  const roomIds = [...sessions.keys()];
  if (roomIds.length === 0) return [];

  log.warn({ count: roomIds.length }, 'finalising recordings before shutdown');
  return Promise.allSettled(roomIds.map((roomId) => stopRecording({ roomId, reason: 'shutdown' })));
};

export const isRecording = (roomId) => sessions.has(roomId);
export const activeRecordings = () => [...sessions.values()].map((session) => session.summary());

/** Tests only. */
export const resetRecordingState = () => sessions.clear();

export default { startRecording, stopRecording, followRoomChange, isRecording };