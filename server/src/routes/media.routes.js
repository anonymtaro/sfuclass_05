/**
 * media.routes — presign · complete · download (F4)
 *
 * No file byte ever passes through this API. The route hands out a presigned S3 multipart
 * URL and the client uploads directly; a 2 GB submission must not occupy an API task for
 * twenty minutes. `middleware/bodyLimits.js` enforces that — raw uploads to the API are
 * rejected, not merely discouraged.
 *
 * The gate order is deliberate and is the whole security story of this file:
 *
 *   content type + size validated  →  StorageGuard checks the tenant quota
 *   →  presign into the RAW bucket  →  client uploads  →  object lands in QUARANTINE
 *   →  AntivirusScan promotes or rejects  →  asset becomes `ready`  →  attachable
 *
 * Nothing is reachable before the scan promotes it, and delivery is always a short-lived
 * signed CloudFront URL from a separate origin — never the app domain, so a malicious
 * upload cannot borrow the app's cookies or CSP.
 */

import { Router } from 'express';
import { z } from 'zod';

import * as UploadService from '../media/UploadService.js';
import * as AssetDelivery from '../media/AssetDelivery.js';
import * as DownloadService from '../media/DownloadService.js';
import * as TranscodeService from '../media/TranscodeService.js';
import * as TranscriptService from '../media/TranscriptService.js';
import * as StorageGuard from '../capacity/StorageGuard.js';
import { env } from '../config/env.js';
import { route, validate, requireAuth, tenantOf, paging, q, notFound, forbidden, badRequest } from './_helpers.js';

const router = Router();
router.use(requireAuth);

const idParam = z.object({ id: z.string().uuid() });

/** Kinds the platform knows what to do with. Everything else is a download tile. */
const ALLOWED_CONTENT_TYPES = [
  'video/mp4', 'video/quicktime', 'video/webm',
  'audio/mpeg', 'audio/mp4', 'audio/wav',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'text/plain', 'text/csv', 'text/vtt',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/* ------------------------------------------------------------------ *
 * Upload
 * ------------------------------------------------------------------ */

router.post(
  '/media/uploads',
  validate({
    body: z.object({
      filename: z.string().min(1).max(255),
      contentType: z.string().min(1).max(255),
      sizeBytes: z.number().int().min(1),
      purpose: z.enum(['lesson', 'submission', 'avatar', 'chat', 'post', 'cover']),
      contextId: z.string().uuid().nullish(), // lesson, assignment, conversation…
      checksumSha256: z.string().length(44).optional(),
    }),
  }),
  route(async (req, res) => {
    const { filename, contentType, sizeBytes, purpose, contextId } = req.body;

    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw badRequest(`Content type not allowed: ${contentType}`, { allowed: ALLOWED_CONTENT_TYPES });
    }

    const capBytes = (purpose === 'chat' ? env.CHAT_ATTACHMENT_MAX_MB : env.MAX_UPLOAD_MB) * 1024 * 1024;
    if (sizeBytes > capBytes) {
      throw badRequest('File exceeds the maximum upload size', { maxBytes: capBytes });
    }

    // Quota before presign, never after upload: refusing a finished 2 GB upload is rude
    // and it has already cost the storage.
    const quota = await StorageGuard.reserve({
      tenantId: tenantOf(req),
      bytes: sizeBytes,
      userId: req.user.id,
      purpose,
    });
    if (!quota.ok) {
      throw Object.assign(new Error('Storage quota exceeded for this plan'), {
        status: 402,
        code: 'QUOTA_EXCEEDED',
        details: { usedBytes: quota.usedBytes, limitBytes: quota.limitBytes },
        expose: true,
      });
    }

    const upload = await UploadService.createMultipart({
      tenantId: tenantOf(req),
      userId: req.user.id,
      filename,
      contentType,
      sizeBytes,
      purpose,
      contextId: contextId ?? null,
      checksumSha256: req.body.checksumSha256 ?? null,
      reservationId: quota.reservationId,
    });

    res.status(201);
    return {
      assetId: upload.assetId,
      uploadId: upload.uploadId,
      partSizeBytes: upload.partSizeBytes,
      parts: upload.parts, // [{ partNumber, url, expiresAt }]
      expiresAt: upload.expiresAt,
    };
  }),
);

/** Extra presigned parts for a resumed upload whose original URLs expired. */
router.post(
  '/media/uploads/:id/parts',
  validate({
    params: idParam,
    body: z.object({ partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100) }),
  }),
  route(async (req) =>
    UploadService.signParts({ assetId: req.params.id, userId: req.user.id, partNumbers: req.body.partNumbers }),
  ),
);

router.post(
  '/media/uploads/:id/complete',
  validate({
    params: idParam,
    body: z.object({
      parts: z.array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) })).min(1).max(10_000),
    }),
  }),
  route(async (req) => {
    const asset = await UploadService.completeMultipart({
      assetId: req.params.id,
      userId: req.user.id,
      parts: req.body.parts,
    });

    // The asset is `processing`, not `ready`: it is still in quarantine until the scan
    // finishes, and transcoding may follow. The client polls or waits for asset.ready.
    return { asset, status: asset.status };
  }),
);

router.delete(
  '/media/uploads/:id',
  validate({ params: idParam }),
  route(async (req) => {
    await UploadService.abort({ assetId: req.params.id, userId: req.user.id });
    return null;
  }),
);

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */

router.get(
  '/media/assets',
  validate({
    query: z.object({
      purpose: z.string().optional(),
      contextId: z.string().uuid().optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  route(async (req) =>
    UploadService.listAssets({
      tenantId: tenantOf(req),
      userId: req.user.id,
      purpose: q(req).purpose,
      contextId: q(req).contextId,
      ...paging(req),
    }),
  ),
);

router.get(
  '/media/assets/:id',
  validate({ params: idParam }),
  route(async (req) => {
    const asset = await AssetDelivery.getIfPermitted(req.params.id, req.user.id);
    if (!asset) throw notFound('No such asset');
    return asset;
  }),
);

/**
 * Playback manifest for a transcoded video: the HLS ladder plus captions, behind signed
 * cookies or a signed URL depending on the player.
 */
router.get(
  '/media/assets/:id/playback',
  validate({ params: idParam }),
  route(async (req) => {
    const asset = await AssetDelivery.getIfPermitted(req.params.id, req.user.id);
    if (!asset) throw notFound('No such asset');
    if (asset.status !== 'ready') {
      throw Object.assign(new Error('Asset is still processing'), {
        status: 409,
        code: 'ASSET_NOT_READY',
        details: { status: asset.status },
        expose: true,
      });
    }
    return AssetDelivery.playbackManifest(asset, { ttlSeconds: 3600 });
  }),
);

/**
 * Download. Answers with a redirect to a short-lived signed CloudFront URL and writes an
 * audit record — who downloaded what, when. The audit is the reason this is a route rather
 * than a URL the client can mint for itself.
 */
router.get(
  '/media/assets/:id/download',
  validate({ params: idParam, query: z.object({ disposition: z.enum(['inline', 'attachment']).optional() }) }),
  route(async (req, res) => {
    const result = await DownloadService.authorise({
      assetId: req.params.id,
      userId: req.user.id,
      tenantId: tenantOf(req),
      ip: req.ip,
      userAgent: req.get('user-agent') ?? null,
      disposition: q(req).disposition ?? 'attachment',
    });
    if (!result.allowed) throw forbidden(result.reason ?? 'Not allowed to download this asset');

    res.set('Cache-Control', 'no-store');
    res.redirect(302, result.url);
  }),
);

router.delete(
  '/media/assets/:id',
  validate({ params: idParam }),
  route(async (req) => {
    await UploadService.softDelete({ assetId: req.params.id, actorId: req.user.id });
    return null;
  }),
);

/* ------------------------------------------------------------------ *
 * Processing and quota
 * ------------------------------------------------------------------ */

router.post(
  '/media/assets/:id/transcode',
  validate({ params: idParam, body: z.object({ ladder: z.enum(['standard', 'high']).default('standard') }).default({}) }),
  route(async (req, res) => {
    res.status(202);
    return TranscodeService.enqueue({ assetId: req.params.id, actorId: req.user.id, ladder: req.body.ladder });
  }),
);

router.post(
  '/media/assets/:id/captions',
  validate({ params: idParam, body: z.object({ language: z.string().min(2).max(10).default('en') }).default({}) }),
  route(async (req, res) => {
    res.status(202);
    return TranscriptService.enqueue({ assetId: req.params.id, language: req.body.language, actorId: req.user.id });
  }),
);

/** Drives StorageQuotaBar.jsx. The recorded figure, not a recount — the drift job repairs it. */
router.get(
  '/media/quota',
  route(async (req) => StorageGuard.usage(tenantOf(req))),
);

export default router;