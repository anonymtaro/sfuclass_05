// classroom-app/server/src/middleware/bodyLimits.js
/**
 * Body parsing and limits  (F7)  [NEW]
 *
 * Two jobs:
 *
 *   1. Keep JSON bodies small. BODY_LIMIT_KB defaults to 256 KB, which is
 *      generous for the largest thing this API accepts — a lesson document —
 *      and small enough that a request cannot occupy a worker for long.
 *
 *   2. Refuse file uploads outright. Files go directly to S3 through a
 *      presigned URL; the API only issues the ticket. A multipart request here
 *      means a client is doing it the slow way, and accepting it would put a
 *      two-gigabyte transfer through a request handler that is supposed to
 *      answer in milliseconds.
 *
 * Webhook routes are parsed as raw bytes and must be mounted before the JSON
 * parser, because a signature is computed over the exact bytes sent. Parsing to
 * JSON and re-serialising changes them, and the signature check then fails for
 * reasons that take a day to find.
 */

import express from 'express';
import { ApiError } from '@classroom/contracts';
import { bodyLimits as limits } from '../config/security.config.js';

/**
 * Raw parsers for signature-verified webhooks. Mount before `jsonBody()`.
 * Returns [path, middleware] pairs so app.js stays declarative.
 */
export const rawWebhookParsers = () =>
  limits.rawWebhookPaths.map((path) => [
    path,
    express.raw({ type: '*/*', limit: limits.rawLimit }),
  ]);

/** Rejects multipart before a single byte of it is buffered. */
export const rejectFileUploads = () => (req, res, next) => {
  const contentType = req.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/')) return next();

  req.log?.warn({ path: req.path, contentType }, 'multipart upload rejected');

  next(
    new ApiError('unsupported_media_type', {
      title: 'Upload directly to storage',
      detail:
        'Files are not accepted here. Request an upload ticket from /media/uploads and send the parts to the returned URLs.',
      traceId: req.traceId ?? '',
    }),
  );
};

export const jsonBody = () => express.json({ limit: limits.json, strict: true });

export const urlencodedBody = () =>
  express.urlencoded({ extended: false, limit: limits.urlencoded });

/**
 * Everything in order, for app.js. Raw webhook parsers are returned separately
 * because they are path-scoped and the rest are not.
 */
export const bodyParsers = () => [rejectFileUploads(), jsonBody(), urlencodedBody()];

export default bodyParsers;