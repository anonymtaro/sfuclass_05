/**
 * Media  (F4)
 *
 * Everything a user uploads becomes an Asset, whatever it is for: a lesson
 * video, a course document, an assignment submission, an avatar, a chat
 * attachment. One pipeline, one quota, one virus scan, one delivery path.
 *
 *   presign  →  client PUTs parts to S3  →  complete  →  quarantine scan
 *            →  ready  (and, for video, a transcode job on top)
 *
 * Bytes never travel through the API. The API only issues presigned URLs and
 * records state, which is what keeps a 2 GB upload from occupying a request
 * handler for twenty minutes.
 *
 * Delivery is always a short-lived signed CloudFront URL from a separate
 * origin, never a link to the raw bucket and never the app domain.
 */

import { z } from 'zod';
import {
  ActorRefSchema,
  DurationSecondsSchema,
  IsoDateTimeSchema,
  MetadataSchema,
  PaginationQuerySchema,
  TimestampsSchema,
  UrlSchema,
  UserIdSchema,
  displayText,
  entityId,
  paginated,
} from './common.schema.ts';

// ---------------------------------------------------------------------------
// Identifiers and enumerations
// ---------------------------------------------------------------------------

export const AssetIdSchema = entityId('AssetId');
export const UploadIdSchema = entityId('UploadId');
export type AssetId = z.infer<typeof AssetIdSchema>;
export type UploadId = z.infer<typeof UploadIdSchema>;

/**
 * Asset lifecycle. Only `ready` is servable.
 *
 *   uploading    parts are being written to the raw bucket
 *   scanning     in quarantine, waiting for AntivirusScan
 *   processing   transcoding or transcribing
 *   ready        in the delivery bucket, signable
 *   failed       processing gave up; `error` explains why
 *   infected     the scan rejected it; the object is destroyed, the row is kept
 */
export const ASSET_STATUSES = [
  'uploading',
  'scanning',
  'processing',
  'ready',
  'failed',
  'infected',
] as const;
export const AssetStatusSchema = z.enum(ASSET_STATUSES);
export type AssetStatus = z.infer<typeof AssetStatusSchema>;

export const ASSET_KINDS = ['video', 'audio', 'image', 'document', 'archive', 'other'] as const;
export const AssetKindSchema = z.enum(ASSET_KINDS);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/**
 * What the asset was uploaded for. Drives the storage prefix, the retention
 * rule and which quota bucket it counts against.
 */
export const ASSET_PURPOSES = [
  'lesson-video',
  'lesson-document',
  'course-cover',
  'avatar',
  'chat-attachment',
  'post-attachment',
  'assignment-submission',
  'assignment-brief',
  'recording',
] as const;
export const AssetPurposeSchema = z.enum(ASSET_PURPOSES);
export type AssetPurpose = z.infer<typeof AssetPurposeSchema>;

/** Accepted content types per purpose, enforced before a presign is issued. */
export const ALLOWED_CONTENT_TYPES: Record<AssetPurpose, readonly string[]> = {
  'lesson-video': ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'],
  'lesson-document': ['application/pdf', 'image/png', 'image/jpeg', 'text/markdown'],
  'course-cover': ['image/png', 'image/jpeg', 'image/webp'],
  avatar: ['image/png', 'image/jpeg', 'image/webp'],
  // Deliberately broad: people send each other whatever they are working on.
  // The scan, not the content type, is what makes this safe.
  'chat-attachment': ['*/*'],
  'post-attachment': ['*/*'],
  'assignment-submission': ['*/*'],
  'assignment-brief': ['application/pdf', 'image/png', 'image/jpeg'],
  recording: ['video/mp4'],
};

// ---------------------------------------------------------------------------
// Asset
// ---------------------------------------------------------------------------

export const VideoRenditionSchema = z.object({
  /** '1080p', '720p', '480p', 'audio' */
  label: z.string().max(16),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  bitrateKbps: z.number().int().positive(),
});

export const CaptionTrackSchema = z.object({
  language: z.string().max(16),
  label: displayText(64),
  /** Signed VTT URL, valid as long as the playback URL beside it. */
  url: UrlSchema,
  /** Machine transcription from Transcribe, or a human upload. */
  source: z.enum(['auto', 'manual']),
});

export const MediaProbeSchema = z.object({
  durationSec: DurationSecondsSchema.nullable().default(null),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  pageCount: z.number().int().positive().nullable().default(null),
});

export const AssetSchema = z
  .object({
    assetId: AssetIdSchema,
    ownerId: UserIdSchema,
    uploadedBy: ActorRefSchema,
    purpose: AssetPurposeSchema,
    kind: AssetKindSchema,
    status: AssetStatusSchema,

    fileName: displayText(255),
    contentType: z.string().max(128),
    sizeBytes: z.number().int().nonnegative(),
    /** SHA-256 of the original, used for dedupe and integrity checks. */
    checksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),

    probe: MediaProbeSchema.default({
      durationSec: null,
      width: null,
      height: null,
      pageCount: null,
    }),

    /**
     * Signed and short-lived — CDN_SIGNED_URL_TTL_SEC. Null unless the asset is
     * ready. Clients must not cache these past their expiry.
     */
    downloadUrl: UrlSchema.nullable().default(null),
    /** HLS manifest for video, null otherwise. */
    playbackUrl: UrlSchema.nullable().default(null),
    thumbnailUrl: UrlSchema.nullable().default(null),
    renditions: z.array(VideoRenditionSchema).default([]),
    captions: z.array(CaptionTrackSchema).default([]),

    /** Populated when status is 'failed'. Safe to show to the uploader. */
    error: z.string().max(500).nullable().default(null),
    metadata: MetadataSchema,
    expiresAt: IsoDateTimeSchema.nullable().default(null),
  })
  .merge(TimestampsSchema);
export type Asset = z.infer<typeof AssetSchema>;

/** What a list or an embedded reference carries. No signed URLs in bulk. */
export const AssetRefSchema = AssetSchema.pick({
  assetId: true,
  kind: true,
  status: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  thumbnailUrl: true,
});
export type AssetRef = z.infer<typeof AssetRefSchema>;

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export const CreateUploadSchema = z.strictObject({
  purpose: AssetPurposeSchema,
  fileName: displayText(255),
  contentType: z.string().max(128),
  sizeBytes: z.number().int().positive(),
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /** Course, lesson, conversation or assignment the asset belongs to. */
  contextId: z.uuid().optional(),
  metadata: MetadataSchema.optional(),
});
export type CreateUpload = z.infer<typeof CreateUploadSchema>;

export const UploadPartSchema = z.object({
  partNumber: z.number().int().min(1).max(10_000),
  url: UrlSchema,
  /** Bytes this part covers, so the client can slice without guessing. */
  offset: z.number().int().nonnegative(),
  size: z.number().int().positive(),
});

/**
 * The presign response. Multipart is used above the part size; below it there
 * is a single part and the client still follows the same complete call, so the
 * upload path has one shape rather than two.
 */
export const UploadTicketSchema = z.object({
  uploadId: UploadIdSchema,
  assetId: AssetIdSchema,
  parts: z.array(UploadPartSchema).min(1),
  partSizeBytes: z.number().int().positive(),
  /** After this the URLs are dead and the client must request a new ticket. */
  expiresAt: IsoDateTimeSchema,
  /** Headers S3 will require on each PUT. */
  requiredHeaders: z.record(z.string(), z.string()).default({}),
});
export type UploadTicket = z.infer<typeof UploadTicketSchema>;

export const CompletedPartSchema = z.object({
  partNumber: z.number().int().min(1),
  /** Returned by S3 on each PUT; the completion fails without all of them. */
  etag: z.string().min(1).max(128),
});

export const CompleteUploadSchema = z.strictObject({
  parts: z.array(CompletedPartSchema).min(1),
});

export const AbortUploadSchema = z.strictObject({
  reason: z.string().max(200).optional(),
});

/** Lets a resumed upload learn which parts already landed. */
export const UploadStatusSchema = z.object({
  uploadId: UploadIdSchema,
  assetId: AssetIdSchema,
  receivedParts: z.array(z.number().int().min(1)),
  expiresAt: IsoDateTimeSchema,
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export const CreateDownloadSchema = z.strictObject({
  /** 'inline' previews in the browser, 'attachment' forces a save dialog. */
  disposition: z.enum(['inline', 'attachment']).default('attachment'),
});

export const DownloadTicketSchema = z.object({
  url: UrlSchema,
  expiresAt: IsoDateTimeSchema,
  fileName: displayText(255),
  contentType: z.string().max(128),
  sizeBytes: z.number().int().nonnegative(),
});
export type DownloadTicket = z.infer<typeof DownloadTicketSchema>;

// ---------------------------------------------------------------------------
// Library and quota
// ---------------------------------------------------------------------------

export const ListAssetsQuerySchema = PaginationQuerySchema.extend({
  purpose: AssetPurposeSchema.optional(),
  kind: AssetKindSchema.optional(),
  status: AssetStatusSchema.optional(),
  contextId: z.uuid().optional(),
  q: z.string().trim().max(128).optional(),
});
export const AssetListSchema = paginated(AssetSchema);

export const StorageUsageSchema = z.object({
  usedBytes: z.number().int().nonnegative(),
  /** From the plan; see billing.schema.ts. */
  quotaBytes: z.number().int().positive(),
  /** Rounded percentage, so every client shows the same number in the bar. */
  usedPercent: z.number().min(0).max(100),
  /** Sparse: a purpose with nothing stored is simply absent. */
  byPurpose: z.partialRecord(AssetPurposeSchema, z.number().int().nonnegative()).prefault({}),
  /** Recomputed nightly by recomputeStorageUsage.js. */
  computedAt: IsoDateTimeSchema,
});
export type StorageUsage = z.infer<typeof StorageUsageSchema>;

// ---------------------------------------------------------------------------
// Transcoding
// ---------------------------------------------------------------------------

export const TRANSCODE_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const TranscodeStateSchema = z.enum(TRANSCODE_STATES);

export const TranscodeJobSchema = z.object({
  jobId: z.string().max(128),
  assetId: AssetIdSchema,
  state: TranscodeStateSchema,
  progressPercent: z.number().min(0).max(100).default(0),
  /** MediaConvert's own error string, trimmed. */
  error: z.string().max(500).nullable().default(null),
  startedAt: IsoDateTimeSchema.nullable().default(null),
  finishedAt: IsoDateTimeSchema.nullable().default(null),
});
export type TranscodeJob = z.infer<typeof TranscodeJobSchema>;

export const RequestTranscriptSchema = z.strictObject({
  language: z.string().max(16).default('auto'),
});

// ---------------------------------------------------------------------------
// Inferred request and response types
// ---------------------------------------------------------------------------

export type CreateUploadInput = z.infer<typeof CreateUploadSchema>;
export type CompletedPart = z.infer<typeof CompletedPartSchema>;
export type UploadStatus = z.infer<typeof UploadStatusSchema>;
export type UploadPart = z.infer<typeof UploadPartSchema>;
export type ListAssetsQuery = z.infer<typeof ListAssetsQuerySchema>;
export type CreateDownload = z.infer<typeof CreateDownloadSchema>;
export type VideoRendition = z.infer<typeof VideoRenditionSchema>;
export type CaptionTrack = z.infer<typeof CaptionTrackSchema>;