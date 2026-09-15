/**
 * Media events  (F4)
 *
 * This file describes two things that share one vocabulary:
 *
 *   1. the socket events a client receives while it waits for an upload to
 *      become playable (namespace `/media`)
 *   2. the internal bus events the worker publishes — EventBridge and BullMQ —
 *      which nothing outside the server ever sees
 *
 * They are kept together because they describe the same lifecycle, and keeping
 * them apart is how the two drift until a client shows a spinner forever
 * because the worker renamed a state.
 *
 *   uploading → scanning → processing → ready
 *                       ↘ infected    ↘ failed
 *
 * `asset.ready` is the only event that makes an asset usable. Everything else
 * is progress reporting.
 */

import { z } from 'zod';
import { IsoDateTimeSchema, MetadataSchema, UserIdSchema } from '../zod/common.schema.ts';
import {
  AssetIdSchema,
  AssetKindSchema,
  AssetPurposeSchema,
  AssetStatusSchema,
  UploadIdSchema,
} from '../zod/media.schema.ts';

export const MEDIA_NAMESPACE = '/media' as const;

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/**
 * Follow specific assets. A client watches only what is on screen, so a media
 * library with four hundred items does not subscribe to four hundred streams.
 */
export const WatchAssetsSchema = z.object({
  assetIds: z.array(AssetIdSchema).min(1).max(100),
});

export const UnwatchAssetsSchema = z.object({
  assetIds: z.array(AssetIdSchema).min(1).max(100),
});

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export const UploadProgressSchema = z.object({
  uploadId: UploadIdSchema,
  assetId: AssetIdSchema,
  receivedParts: z.number().int().nonnegative(),
  totalParts: z.number().int().positive(),
  /** Server-side view. The client already knows its own bytes sent. */
  percent: z.number().min(0).max(100),
});

export const AssetStatusChangedSchema = z.object({
  assetId: AssetIdSchema,
  status: AssetStatusSchema,
  purpose: AssetPurposeSchema,
  kind: AssetKindSchema,
  /** 0–100 while processing; null in every other state. */
  progressPercent: z.number().min(0).max(100).nullable().default(null),
  updatedAt: IsoDateTimeSchema,
});

/**
 * The asset is in the delivery bucket and signable. Carries the URLs so a
 * waiting UI can swap its placeholder without another round trip.
 */
export const AssetReadySchema = z.object({
  assetId: AssetIdSchema,
  purpose: AssetPurposeSchema,
  kind: AssetKindSchema,
  downloadUrl: z.string().url().nullable().default(null),
  playbackUrl: z.string().url().nullable().default(null),
  thumbnailUrl: z.string().url().nullable().default(null),
  durationSec: z.number().int().nonnegative().nullable().default(null),
  hasCaptions: z.boolean().default(false),
  readyAt: IsoDateTimeSchema,
});

export const TranscodeFailedSchema = z.object({
  assetId: AssetIdSchema,
  jobId: z.string().max(128),
  /** Safe to show the uploader; the raw provider error stays in the logs. */
  reason: z.string().max(500),
  /** False when the file itself is the problem and a retry would not help. */
  retryable: z.boolean().default(false),
  failedAt: IsoDateTimeSchema,
});

export const AssetInfectedSchema = z.object({
  assetId: AssetIdSchema,
  /** The object is destroyed; only the row and this event survive. */
  signature: z.string().max(200).nullable().default(null),
  detectedAt: IsoDateTimeSchema,
});

export const TranscriptReadySchema = z.object({
  assetId: AssetIdSchema,
  language: z.string().max(16),
  url: z.string().url(),
  source: z.enum(['auto', 'manual']),
});

/** Sent when a tenant crosses a quota threshold, so the bar turns amber. */
export const StorageUsageChangedSchema = z.object({
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().positive(),
  usedPercent: z.number().min(0).max(100),
  /** 80, 95 or 100 — the threshold that was crossed. */
  threshold: z.union([z.literal(80), z.literal(95), z.literal(100)]).nullable().default(null),
});

// ---------------------------------------------------------------------------
// Internal bus — worker and webhooks only
// ---------------------------------------------------------------------------

/**
 * Envelope for anything published to EventBridge or a BullMQ queue.
 *
 * `idempotencyKey` matters more here than anywhere else: MediaConvert and
 * EventBridge both deliver at least once, so every consumer must be able to see
 * the same event twice and do nothing the second time.
 */
export const InternalEventSchema = z.object({
  eventId: z.uuid(),
  type: z.string().max(64),
  occurredAt: IsoDateTimeSchema,
  idempotencyKey: z.string().max(200),
  actorId: UserIdSchema.nullable().default(null),
  metadata: MetadataSchema,
});

export const MEDIA_INTERNAL_EVENTS = {
  uploadCompleted: 'media.upload.completed',
  scanRequested: 'media.scan.requested',
  scanPassed: 'media.scan.passed',
  scanFailed: 'media.scan.failed',
  transcodeRequested: 'media.transcode.requested',
  transcodeSucceeded: 'media.transcode.succeeded',
  transcodeFailed: 'media.transcode.failed',
  transcriptRequested: 'media.transcript.requested',
  transcriptCompleted: 'media.transcript.completed',
  assetReady: 'media.asset.ready',
  assetDeleted: 'media.asset.deleted',
  /** Emitted by pruneRecordings.js and pruneChatRetention.js. */
  retentionExpired: 'media.retention.expired',
} as const;

export type MediaInternalEvent =
  (typeof MEDIA_INTERNAL_EVENTS)[keyof typeof MEDIA_INTERNAL_EVENTS];

export const MediaInternalPayloadSchema = InternalEventSchema.extend({
  type: z.enum([
    MEDIA_INTERNAL_EVENTS.uploadCompleted,
    MEDIA_INTERNAL_EVENTS.scanRequested,
    MEDIA_INTERNAL_EVENTS.scanPassed,
    MEDIA_INTERNAL_EVENTS.scanFailed,
    MEDIA_INTERNAL_EVENTS.transcodeRequested,
    MEDIA_INTERNAL_EVENTS.transcodeSucceeded,
    MEDIA_INTERNAL_EVENTS.transcodeFailed,
    MEDIA_INTERNAL_EVENTS.transcriptRequested,
    MEDIA_INTERNAL_EVENTS.transcriptCompleted,
    MEDIA_INTERNAL_EVENTS.assetReady,
    MEDIA_INTERNAL_EVENTS.assetDeleted,
    MEDIA_INTERNAL_EVENTS.retentionExpired,
  ]),
  assetId: AssetIdSchema,
  purpose: AssetPurposeSchema,
  /** S3 key in whichever bucket the asset currently sits in. */
  objectKey: z.string().max(1024).nullable().default(null),
  jobId: z.string().max(128).nullable().default(null),
  error: z.string().max(500).nullable().default(null),
});
export type MediaInternalPayload = z.infer<typeof MediaInternalPayloadSchema>;

// ---------------------------------------------------------------------------
// Socket event names
// ---------------------------------------------------------------------------

export const MEDIA_CLIENT_EVENTS = {
  watch: 'media:asset.watch',
  unwatch: 'media:asset.unwatch',
} as const;

export const MEDIA_SERVER_EVENTS = {
  uploadProgress: 'media:upload.progress',
  statusChanged: 'media:asset.status',
  assetReady: 'media:asset.ready',
  transcodeFailed: 'media:transcode.failed',
  assetInfected: 'media:asset.infected',
  transcriptReady: 'media:transcript.ready',
  storageUsageChanged: 'media:storage.changed',
} as const;

export type MediaClientEvent = (typeof MEDIA_CLIENT_EVENTS)[keyof typeof MEDIA_CLIENT_EVENTS];
export type MediaServerEvent = (typeof MEDIA_SERVER_EVENTS)[keyof typeof MEDIA_SERVER_EVENTS];

export type MediaClientPayloads = {
  [MEDIA_CLIENT_EVENTS.watch]: z.infer<typeof WatchAssetsSchema>;
  [MEDIA_CLIENT_EVENTS.unwatch]: z.infer<typeof UnwatchAssetsSchema>;
};

export type MediaServerPayloads = {
  [MEDIA_SERVER_EVENTS.uploadProgress]: z.infer<typeof UploadProgressSchema>;
  [MEDIA_SERVER_EVENTS.statusChanged]: z.infer<typeof AssetStatusChangedSchema>;
  [MEDIA_SERVER_EVENTS.assetReady]: z.infer<typeof AssetReadySchema>;
  [MEDIA_SERVER_EVENTS.transcodeFailed]: z.infer<typeof TranscodeFailedSchema>;
  [MEDIA_SERVER_EVENTS.assetInfected]: z.infer<typeof AssetInfectedSchema>;
  [MEDIA_SERVER_EVENTS.transcriptReady]: z.infer<typeof TranscriptReadySchema>;
  [MEDIA_SERVER_EVENTS.storageUsageChanged]: z.infer<typeof StorageUsageChangedSchema>;
};