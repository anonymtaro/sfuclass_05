// classroom-app/server/src/config/storage.config.js
/**
 * Storage policy  (F4)  [NEW]
 *
 * Buckets, key layout, size caps and content-type rules, in one place. Read by
 * media/UploadService.js, media/StorageClient.js, media/AssetDelivery.js and
 * capacity/StorageGuard.js.
 *
 * Three buckets, and the separation is a security boundary rather than
 * housekeeping:
 *
 *   raw          the presigned upload target. Nothing is ever served from here.
 *   quarantine   where an object waits for AntivirusScan. No public access, no
 *                CDN origin, no signed URLs.
 *   delivery     scanned and processed. The only bucket CloudFront can read,
 *                and only through signed URLs.
 *
 * An object that skips a stage is a bug with consequences, so the key layout
 * below encodes the stage in the prefix: a file in the wrong place is visible
 * at a glance in the console.
 */

import { env } from './env.js';

const MB = 1024 * 1024;

export const buckets = {
  raw: env.S3_BUCKET_RAW,
  quarantine: env.S3_BUCKET_QUARANTINE,
  delivery: env.S3_BUCKET_DELIVERY,
};

/** MinIO locally; empty in AWS so the SDK resolves the real endpoint. */
export const s3ClientOptions = {
  region: env.AWS_REGION,
  ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  ...(env.AWS_ACCESS_KEY_ID
    ? {
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {}),
};

// ---------------------------------------------------------------------------
// Per-purpose rules
// ---------------------------------------------------------------------------

/**
 * `maxMb` is a policy ceiling; the plan quota is checked separately and is what
 * usually stops an upload. `contentTypes` of ['*'] means anything — chat
 * attachments and assignment submissions genuinely can be anything, and the
 * quarantine scan is what makes that safe rather than a type allowlist that
 * people work around by renaming files.
 */
export const purposes = {
  'lesson-video': {
    prefix: 'courses/{courseId}/lessons/{lessonId}/video',
    maxMb: Math.min(env.MAX_UPLOAD_MB, 8_192),
    contentTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'],
    transcode: true,
    transcribe: true,
    retentionDays: null,
  },
  'lesson-document': {
    prefix: 'courses/{courseId}/lessons/{lessonId}/docs',
    maxMb: 100,
    contentTypes: ['application/pdf', 'image/png', 'image/jpeg', 'text/markdown'],
    transcode: false,
    retentionDays: null,
  },
  'course-cover': {
    prefix: 'courses/{courseId}/cover',
    maxMb: 10,
    contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
    derivatives: ['thumb-400', 'card-800'],
    retentionDays: null,
  },
  avatar: {
    prefix: 'users/{userId}/avatar',
    maxMb: 5,
    contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
    derivatives: ['avatar-64', 'avatar-256'],
    retentionDays: null,
  },
  'chat-attachment': {
    prefix: 'chat/{conversationId}/{assetId}',
    maxMb: env.CHAT_ATTACHMENT_MAX_MB,
    contentTypes: ['*'],
    transcode: false,
    /** 0 in the environment means keep forever. */
    retentionDays: env.CHAT_RETENTION_DAYS || null,
  },
  'post-attachment': {
    prefix: 'community/{spaceId}/{assetId}',
    maxMb: 100,
    contentTypes: ['*'],
    retentionDays: null,
  },
  'assignment-submission': {
    prefix: 'assignments/{assignmentId}/submissions/{userId}',
    maxMb: Math.min(env.MAX_UPLOAD_MB, 2_048),
    contentTypes: ['*'],
    /** Submissions outlive the course; a grade appeal can come months later. */
    retentionDays: null,
  },
  'assignment-brief': {
    prefix: 'assignments/{assignmentId}/brief',
    maxMb: 100,
    contentTypes: ['application/pdf', 'image/png', 'image/jpeg'],
    retentionDays: null,
  },
  recording: {
    prefix: 'recordings/{roomId}',
    maxMb: Math.min(env.MAX_UPLOAD_MB, 16_384),
    contentTypes: ['video/mp4'],
    transcode: true,
    transcribe: true,
    retentionDays: env.RECORDING_RETENTION_DAYS,
  },
};

// ---------------------------------------------------------------------------
// Multipart upload
// ---------------------------------------------------------------------------

export const multipart = {
  /**
   * S3 allows 10,000 parts. At 8 MB that covers 80 GB, comfortably above any
   * ceiling above, and 8 MB is small enough that a failed part on a phone is a
   * cheap retry rather than a restart.
   */
  partSizeBytes: 8 * MB,
  /** Below this, a single PUT is used — with the same complete() call. */
  singlePartThresholdBytes: 8 * MB,
  maxParts: 10_000,
  /** Presigned part URLs expire; a slow upload re-requests a ticket. */
  urlTtlSec: 3_600,
  /** An abandoned multipart upload is reaped by a lifecycle rule after this. */
  abandonAfterHours: 24,
};

export const delivery = {
  cdnDomain: env.CDN_DOMAIN,
  keyPairId: env.CDN_KEY_PAIR_ID,
  privateKey: env.CDN_PRIVATE_KEY,
  signedUrlTtlSec: env.CDN_SIGNED_URL_TTL_SEC,
  /** HLS manifests reference segments; both need the same signing policy. */
  hlsManifestName: 'index.m3u8',
};

export const antivirus = {
  mode: env.ANTIVIRUS_MODE,
  host: env.CLAMAV_HOST,
  port: env.CLAMAV_PORT,
  /** An unscannable file is rejected, not passed through. */
  failClosed: true,
  maxScanMb: 512,
  /** Above the scan ceiling: quarantine and flag for manual review. */
  oversizePolicy: 'manual-review',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds the object key for a purpose. Unfilled placeholders throw. */
export const buildKey = (purpose, context = {}) => {
  const rule = purposes[purpose];
  if (!rule) throw new Error(`Unknown storage purpose: ${purpose}`);

  const key = rule.prefix.replace(/\{(\w+)\}/g, (_match, name) => {
    const value = context[name];
    if (!value) throw new Error(`Missing ${name} for storage purpose ${purpose}`);
    return String(value);
  });

  return context.assetId && !rule.prefix.includes('{assetId}')
    ? `${key}/${context.assetId}`
    : key;
};

/** Cheap pre-flight, before a presign is issued. */
export const validateUpload = (purpose, { contentType, sizeBytes }) => {
  const rule = purposes[purpose];
  if (!rule) return { ok: false, code: 'unsupported_media_type', reason: 'unknown purpose' };

  const maxBytes = rule.maxMb * MB;
  if (sizeBytes > maxBytes) {
    return { ok: false, code: 'payload_too_large', reason: `exceeds ${rule.maxMb} MB` };
  }
  if (rule.contentTypes[0] !== '*' && !rule.contentTypes.includes(contentType)) {
    return { ok: false, code: 'unsupported_media_type', reason: `${contentType} is not accepted` };
  }
  return { ok: true };
};

export const storageConfig = {
  buckets,
  s3ClientOptions,
  purposes,
  multipart,
  delivery,
  antivirus,
  buildKey,
  validateUpload,
};

export default storageConfig;