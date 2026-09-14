/**
 * Media API  (F4)
 *
 * Presign, resumable multipart upload, and delivery.
 *
 * The critical detail in this file: **the part uploads do not go through
 * httpClient**. A presigned S3 URL carries its own signature, and sending an
 * `Authorization` header alongside it makes S3 reject the request. So parts are
 * sent with a bare fetch, and only the presign, completion and abort calls talk
 * to the API.
 *
 *   1. createUpload   quota checked, multipart initiated, part URLs returned
 *   2. PUT each part  directly to S3, in parallel, retried individually
 *   3. completeUpload etags submitted, object assembled
 *   4. scan + process the worker takes over; the asset is not usable yet
 *   5. asset.ready    arrives over the media socket
 *
 * Resumption is real, not decorative: `getUploadStatus()` reports which parts
 * S3 already holds, so a 2 GB file that died at 80% resumes at 80%. That is the
 * whole reason for the multipart dance on a platform where people upload
 * lecture recordings over hotel wifi.
 *
 * Progress granularity: fetch has no upload progress event, unlike XHR. What
 * this reports is per-part completion, which for a 5 MB part size is fine.
 * Byte-level progress would mean reintroducing XHR for the browser only.
 */

import { Media } from '@classroom/contracts';
import { ApiError } from '@classroom/contracts';
import type { z } from 'zod';
import type { HttpClient } from '../http/httpClient.js';

// ---------------------------------------------------------------------------
// Source abstraction
// ---------------------------------------------------------------------------

/**
 * What can be uploaded. A browser `File` satisfies this directly. React Native
 * has no sliceable file object, so apps/mobile implements `slice()` over
 * expo-file-system and returns a base64 chunk.
 */
export interface UploadSource {
  name: string;
  type: string;
  size: number;
  /** Bytes in [start, end). Returns whatever the platform's fetch can send. */
  slice(start: number, end: number): Promise<BodyInit> | BodyInit;
}

/** Wraps a browser File or Blob. */
export const fromBlob = (file: File | Blob, name?: string): UploadSource => ({
  name: name ?? (file as File).name ?? 'upload',
  type: file.type || 'application/octet-stream',
  size: file.size,
  slice: (start, end) => file.slice(start, end),
});

export interface UploadProgress {
  assetId: string;
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  partsDone: number;
  partsTotal: number;
}

export interface UploadOptions {
  purpose: z.infer<typeof Media.AssetPurposeSchema>;
  /** Course, lesson, conversation or assignment this belongs to. */
  contextId?: string;
  onProgress?(progress: UploadProgress): void;
  signal?: AbortSignal;
  /** Parallel part uploads. Three is a good default on mobile networks. */
  concurrency?: number;
  /** Attempts per part before the whole upload fails. */
  partAttempts?: number;
  /** Resume an upload started earlier instead of creating a new one. */
  resumeUploadId?: string;
}

export interface MediaApi {
  createUpload(
    input: z.infer<typeof Media.CreateUploadSchema>,
  ): Promise<z.infer<typeof Media.UploadTicketSchema>>;
  getUploadStatus(uploadId: string): Promise<z.infer<typeof Media.UploadStatusSchema>>;
  completeUpload(
    uploadId: string,
    parts: z.infer<typeof Media.CompletedPartSchema>[],
  ): Promise<z.infer<typeof Media.AssetSchema>>;
  abortUpload(uploadId: string, reason?: string): Promise<void>;

  /** Runs the whole sequence. This is what callers normally use. */
  upload(source: UploadSource, options: UploadOptions): Promise<z.infer<typeof Media.AssetSchema>>;

  getAsset(assetId: string, signal?: AbortSignal): Promise<z.infer<typeof Media.AssetSchema>>;
  listAssets(
    query?: Partial<z.infer<typeof Media.ListAssetsQuerySchema>>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Media.AssetListSchema>>;
  deleteAsset(assetId: string): Promise<void>;

  /** Short-lived signed URL. Never cache it past `expiresAt`. */
  createDownload(
    assetId: string,
    disposition?: 'inline' | 'attachment',
  ): Promise<z.infer<typeof Media.DownloadTicketSchema>>;

  getStorageUsage(signal?: AbortSignal): Promise<z.infer<typeof Media.StorageUsageSchema>>;
  requestTranscript(assetId: string, language?: string): Promise<void>;
  /** Polling fallback for clients without the media socket open. */
  getTranscodeJob(assetId: string): Promise<z.infer<typeof Media.TranscodeJobSchema>>;
}

// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createMediaApi = (
  http: HttpClient,
  /** Bare fetch for S3. Must not be the authenticated client. */
  rawFetch: typeof fetch = globalThis.fetch?.bind(globalThis),
): MediaApi => {
  const api: MediaApi = {
    createUpload: (input) =>
      http.post('/media/uploads', input, { schema: Media.UploadTicketSchema }),

    getUploadStatus: (uploadId) =>
      http.get(`/media/uploads/${encodeURIComponent(uploadId)}`, {
        schema: Media.UploadStatusSchema,
      }),

    completeUpload: (uploadId, parts) =>
      http.post(`/media/uploads/${encodeURIComponent(uploadId)}/complete`, { parts }, {
        schema: Media.AssetSchema,
        // Assembling a large object can take a while on S3's side.
        timeoutMs: 60_000,
      }),

    abortUpload: async (uploadId, reason) => {
      await http.post(`/media/uploads/${encodeURIComponent(uploadId)}/abort`, { reason });
    },

    async upload(source, options) {
      const {
        purpose,
        contextId,
        onProgress,
        signal,
        concurrency = 3,
        partAttempts = 4,
      } = options;

      const ticket = await api.createUpload({
        purpose,
        fileName: source.name,
        contentType: source.type || 'application/octet-stream',
        sizeBytes: source.size,
        contextId,
      });

      // Resuming: ask S3 which parts already landed and skip them.
      const alreadyDone = new Set<number>();
      if (options.resumeUploadId) {
        const status = await api.getUploadStatus(options.resumeUploadId);
        for (const part of status.receivedParts) alreadyDone.add(part);
      }

      const completed: z.infer<typeof Media.CompletedPartSchema>[] = [];
      const pending = ticket.parts.filter((part) => !alreadyDone.has(part.partNumber));
      let uploadedBytes = ticket.parts
        .filter((part) => alreadyDone.has(part.partNumber))
        .reduce((sum, part) => sum + part.size, 0);

      const report = () => {
        onProgress?.({
          assetId: ticket.assetId,
          uploadedBytes,
          totalBytes: source.size,
          percent: source.size === 0 ? 100 : Math.round((uploadedBytes / source.size) * 100),
          partsDone: completed.length + alreadyDone.size,
          partsTotal: ticket.parts.length,
        });
      };
      report();

      const uploadPart = async (part: (typeof ticket.parts)[number]): Promise<void> => {
        const body = await source.slice(part.offset, part.offset + part.size);

        for (let attempt = 1; attempt <= partAttempts; attempt += 1) {
          signal?.throwIfAborted?.();
          try {
            // No auth header, no cookies: the signature is the credential, and
            // anything extra invalidates it.
            const response = await rawFetch(part.url, {
              method: 'PUT',
              body,
              headers: ticket.requiredHeaders,
              signal,
            });

            if (!response.ok) {
              // 4xx from S3 usually means the URL expired; retrying the same
              // URL will not help, so fail fast and let the caller re-presign.
              if (response.status < 500 && response.status !== 429) {
                throw new ApiError('upload_incomplete', {
                  detail: `Part ${part.partNumber} was rejected (${response.status}).`,
                });
              }
              throw new Error(`S3 responded ${response.status}`);
            }

            const etag = response.headers.get('etag');
            if (!etag) {
              throw new ApiError('upload_incomplete', {
                detail: 'S3 did not return an ETag; the bucket CORS policy may not expose it.',
              });
            }

            completed.push({ partNumber: part.partNumber, etag: etag.replaceAll('"', '') });
            uploadedBytes += part.size;
            report();
            return;
          } catch (cause) {
            if (ApiError.is(cause)) throw cause;
            if (signal?.aborted) throw cause;
            if (attempt === partAttempts) {
              throw new ApiError('upload_incomplete', {
                detail: `Part ${part.partNumber} failed after ${partAttempts} attempts.`,
                cause,
              });
            }
            await sleep(Math.min(500 * 2 ** (attempt - 1), 8_000));
          }
        }
      };

      // A small worker pool rather than Promise.all over every part: a hundred
      // simultaneous PUTs is how a phone runs out of sockets.
      const queue = [...pending];
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let part = queue.shift(); part; part = queue.shift()) {
          await uploadPart(part);
        }
      });

      try {
        await Promise.all(workers);
      } catch (cause) {
        // Leaving a multipart upload open costs storage until the lifecycle
        // rule reaps it, so tell the server it is dead.
        await api.abortUpload(ticket.uploadId, 'client failure').catch(() => undefined);
        throw cause;
      }

      completed.sort((a, b) => a.partNumber - b.partNumber);
      return api.completeUpload(ticket.uploadId, completed);
    },

    getAsset: (assetId, signal) =>
      http.get(`/media/assets/${encodeURIComponent(assetId)}`, {
        schema: Media.AssetSchema,
        signal,
      }),

    listAssets: (query = {}, signal) =>
      http.get('/media/assets', {
        schema: Media.AssetListSchema,
        query: {
          cursor: query.cursor,
          limit: query.limit,
          purpose: query.purpose,
          kind: query.kind,
          status: query.status,
          contextId: query.contextId,
          q: query.q,
        },
        signal,
      }),

    deleteAsset: async (assetId) => {
      await http.delete(`/media/assets/${encodeURIComponent(assetId)}`);
    },

    createDownload: (assetId, disposition = 'attachment') =>
      http.post(
        `/media/assets/${encodeURIComponent(assetId)}/download`,
        { disposition },
        { schema: Media.DownloadTicketSchema },
      ),

    getStorageUsage: (signal) =>
      http.get('/media/storage', { schema: Media.StorageUsageSchema, signal }),

    requestTranscript: async (assetId, language = 'auto') => {
      await http.post(`/media/assets/${encodeURIComponent(assetId)}/transcript`, { language });
    },

    getTranscodeJob: (assetId) =>
      http.get(`/media/assets/${encodeURIComponent(assetId)}/transcode`, {
        schema: Media.TranscodeJobSchema,
      }),
  };

  return api;
};