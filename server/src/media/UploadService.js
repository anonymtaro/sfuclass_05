// classroom-app/server/src/media/UploadService.js
/**
 * Uploads  (F4)  [NEW]
 *
 * Presign, complete, and register. The entry point for every byte a user sends.
 *
 * The order of checks before a presign is issued is the point of this file:
 *
 *   1. is this purpose real, and is the type and size allowed        cheap
 *   2. does the tenant have the quota                                cheap
 *   3. has this exact file already been uploaded                     cheap
 *   4. only then: open a multipart upload and sign the URLs          costly
 *
 * All three cheap checks happen before a single byte moves. A 2 GB upload
 * rejected at the end because the plan is full is the worst possible version of
 * that conversation, and it is entirely avoidable.
 */

import { randomUUID, createHash } from 'node:crypto';
import { buildKey, validateUpload, purposes, multipart } from '../config/storage.config.js';
import { logger } from '../observability/logger.js';
import * as Assets from './models/Asset.js';
import * as Storage from './StorageClient.js';

const log = logger.child({ component: 'uploads' });

/** Maps a content type to the coarse kind used for layout and icons. */
export const kindFor = (contentType) => {
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType === 'application/pdf' || contentType.startsWith('text/')) return 'document';
  if (/zip|tar|rar|7z/.test(contentType)) return 'archive';
  return 'other';
};

/** Parts needed for a size. Below the threshold it is one part, not zero. */
export const partPlan = (sizeBytes) => {
  const partSize = multipart.partSizeBytes;
  const parts = Math.max(1, Math.ceil(sizeBytes / partSize));

  if (parts > multipart.maxParts) {
    throw Object.assign(new Error('this file is too large to upload'), { code: 'payload_too_large' });
  }
  return { parts, partSize };
};

// ---------------------------------------------------------------------------
// Presign
// ---------------------------------------------------------------------------

export const createUpload = async ({ ownerId, purpose, fileName, contentType, sizeBytes, checksum = null, contextId = null, metadata = {} }) => {
  // 1. Policy.
  const policy = validateUpload(purpose, { contentType, sizeBytes });
  if (!policy.ok) {
    throw Object.assign(new Error(policy.reason), { code: policy.code });
  }

  // 2. Quota. Asked before anything is created, so a refusal costs nothing.
  const { assertStorageAvailable } = await import('../capacity/StorageGuard.js');
  await assertStorageAvailable({ ownerId, sizeBytes });

  // 3. Deduplication. The same lecture uploaded twice should not be stored or
  //    charged twice, and the client gets a ready asset immediately.
  if (checksum) {
    const existing = await Assets.findByChecksum({ checksum, ownerId });
    if (existing) {
      log.info({ assetId: existing.assetId, ownerId }, 'upload deduplicated by checksum');
      return { deduplicated: true, assetId: existing.assetId, asset: existing, parts: [] };
    }
  }

  // 4. Only now does anything cost money.
  const assetId = randomUUID();
  const key = `${buildKey(purpose, { ...metadata, assetId, userId: ownerId, contextId })}/${sanitise(fileName)}`;
  const { parts, partSize } = partPlan(sizeBytes);

  const upload = await Storage.createMultipartUpload({
    bucket: 'raw',
    key,
    contentType,
    parts,
    partSize,
    checksum,
  });

  await Assets.insert({
    assetId,
    ownerId,
    purpose,
    kind: kindFor(contentType),
    status: 'uploading',
    fileName,
    contentType,
    sizeBytes,
    checksum,
    bucket: 'raw',
    objectKey: key,
    contextId,
    metadata: { ...metadata, uploadId: upload.uploadId },
    expiresAt: retentionFor(purpose),
  });

  log.info({ assetId, ownerId, purpose, sizeBytes, parts }, 'upload created');

  return {
    uploadId: upload.uploadId,
    assetId,
    parts: upload.parts,
    partSizeBytes: partSize,
    expiresAt: new Date(Date.now() + multipart.urlTtlSec * 1000).toISOString(),
    requiredHeaders: {},
  };
};

/** Which parts already landed, so a resumed upload skips them. */
export const getUploadStatus = async ({ assetId, ownerId }) => {
  const asset = await Assets.findById(assetId);
  if (!asset || asset.ownerId !== ownerId) {
    throw Object.assign(new Error('upload not found'), { code: 'not_found' });
  }

  const uploadId = asset.metadata?.uploadId;
  const received = uploadId
    ? await Storage.listUploadedParts({ bucket: asset.bucket, key: asset.objectKey, uploadId })
    : [];

  return {
    uploadId,
    assetId,
    receivedParts: received,
    expiresAt: new Date(Date.now() + multipart.urlTtlSec * 1000).toISOString(),
  };
};

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

/**
 * The bytes have landed. This does not make the asset usable — it hands it to
 * the scanner, and `ready` comes later over the media socket.
 */
export const completeUpload = async ({ assetId, ownerId, parts }) => {
  const asset = await Assets.findById(assetId);
  if (!asset || asset.ownerId !== ownerId) {
    throw Object.assign(new Error('upload not found'), { code: 'not_found' });
  }
  if (asset.status !== 'uploading') {
    // Already completed. Returning it is friendlier than an error for a client
    // that retried a request whose response it never saw.
    return asset;
  }

  await Storage.completeMultipartUpload({
    bucket: asset.bucket,
    key: asset.objectKey,
    uploadId: asset.metadata.uploadId,
    parts,
  });

  // What S3 actually holds, not what the client claimed. A size that disagrees
  // with the reservation means the quota check was made against a lie.
  const head = await Storage.headObject({ bucket: asset.bucket, key: asset.objectKey });
  if (!head) {
    await Assets.setStatus({ assetId, from: 'uploading', to: 'failed', error: 'the object is missing after completion' });
    throw Object.assign(new Error('the upload did not complete'), { code: 'upload_incomplete' });
  }

  if (Math.abs(head.sizeBytes - asset.sizeBytes) > 1024) {
    log.warn(
      { assetId, declared: asset.sizeBytes, actual: head.sizeBytes },
      'uploaded size differs from the declared size',
    );
  }

  const updated = await Assets.setStatus({
    assetId,
    from: 'uploading',
    to: 'scanning',
    patch: { sizeBytes: head.sizeBytes },
  });

  // Scanning happens on the worker: it is slow, and it must not hold an API
  // request open.
  const { enqueueScan } = await import('../queues/queues.js');
  await enqueueScan({ assetId }).catch((cause) =>
    log.error({ err: cause, assetId }, 'scan not queued; reconcile will find it'),
  );

  log.info({ assetId, sizeBytes: head.sizeBytes }, 'upload completed, queued for scanning');
  return updated ?? asset;
};

export const abortUpload = async ({ assetId, ownerId, reason = null }) => {
  const asset = await Assets.findById(assetId);
  if (!asset || asset.ownerId !== ownerId) return false;

  if (asset.metadata?.uploadId) {
    await Storage.abortMultipartUpload({
      bucket: asset.bucket,
      key: asset.objectKey,
      uploadId: asset.metadata.uploadId,
    });
  }

  await Assets.softDelete(assetId);
  log.info({ assetId, reason }, 'upload aborted');
  return true;
};

// ---------------------------------------------------------------------------
// Server-side registration
// ---------------------------------------------------------------------------

/**
 * Registers an object this platform produced rather than a user uploaded:
 * a recording, a transcoded rendition. Called by recordingPipeline.js.
 *
 * These skip the quarantine scan, and deliberately so — the bytes came from
 * our own ffmpeg process, not from the internet.
 */
export const registerAsset = async ({ assetId, purpose, kind, status = 'processing', fileName, contentType, sizeBytes, objectKey, ownerId, metadata = {}, expiresAt = null }) => {
  const asset = await Assets.insert({
    assetId,
    ownerId,
    purpose,
    kind,
    status,
    fileName,
    contentType,
    sizeBytes,
    bucket: 'raw',
    objectKey,
    metadata,
    expiresAt: expiresAt ?? retentionFor(purpose),
  });

  log.info({ assetId: asset.assetId, purpose }, 'asset registered');
  return asset;
};

/**
 * Stores a generated file and makes it immediately available: certificates,
 * exports. Straight into delivery, because we made it.
 */
export const storeGeneratedAsset = async ({ purpose, kind, fileName, contentType, body, ownerId, metadata = {} }) => {
  const assetId = randomUUID();
  const key = `${buildKey(purpose, { ...metadata, assetId, userId: ownerId })}/${sanitise(fileName)}`;

  await Storage.putObject({ bucket: 'delivery', key, body, contentType, metadata: { assetId } });

  const asset = await Assets.insert({
    assetId,
    ownerId,
    purpose,
    kind,
    status: 'ready',
    fileName,
    contentType,
    sizeBytes: body.length ?? body.byteLength ?? 0,
    checksum: createHash('sha256').update(body).digest('hex'),
    bucket: 'delivery',
    objectKey: key,
    metadata,
  });

  return asset;
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Ownership-checked lookup. Used by every attach path — chat, community
 * posts, assignment submissions — so a guessed asset id cannot be attached to
 * somebody else's message.
 */
export const getAssetsForOwner = ({ assetIds, userId }) =>
  Assets.findForOwner({ assetIds, userId });

export const getAsset = async ({ assetId, viewerId }) => {
  const asset = await Assets.findById(assetId);
  if (!asset) throw Object.assign(new Error('asset not found'), { code: 'not_found' });

  const { AssetDelivery } = await import('./AssetDelivery.js').then((module) => ({ AssetDelivery: module }));
  return AssetDelivery.decorate({ asset, viewerId });
};

export const listAssets = (query) => Assets.list(query);

export const deleteAsset = async ({ assetId, actorId }) => {
  const asset = await Assets.findById(assetId);
  if (!asset) return false;

  if (asset.ownerId !== actorId) {
    throw Object.assign(new Error('you can only delete your own files'), { code: 'forbidden' });
  }

  // Soft delete now, bytes later: something may still be rendering a reference
  // to it, and a grace period makes an accidental delete recoverable.
  await Assets.softDelete(assetId);

  const { recomputeUsage } = await import('../capacity/StorageGuard.js');
  await recomputeUsage(asset.ownerId).catch(() => undefined);

  log.info({ assetId, actorId }, 'asset deleted');
  return true;
};

export const storageUsage = async (ownerId) => {
  const { usedBytes, byPurpose } = await Assets.usageFor(ownerId);
  const { quotaBytesFor } = await import('../capacity/StorageGuard.js');
  const quotaBytes = await quotaBytesFor(ownerId);

  return {
    usedBytes,
    quotaBytes,
    usedPercent: quotaBytes === 0 ? 0 : Math.min(100, Math.round((usedBytes / quotaBytes) * 100)),
    byPurpose,
    computedAt: new Date().toISOString(),
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Object keys are not file names. Path separators, control characters and
 * leading dots all cause trouble somewhere between S3, a CDN and a browser's
 * download dialog; the original name is kept on the row for display.
 */
export const sanitise = (fileName) =>
  fileName
    .replace(/[/\\]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/^\.+/, '')
    .slice(-120) || 'file';

const retentionFor = (purpose) => {
  const days = purposes[purpose]?.retentionDays;
  return days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
};

export default {
  createUpload, completeUpload, abortUpload, getUploadStatus, registerAsset,
  storeGeneratedAsset, getAssetsForOwner, getAsset, listAssets, deleteAsset, storageUsage,
};