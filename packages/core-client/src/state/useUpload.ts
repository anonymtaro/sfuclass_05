/**
 * useUpload  (F4)
 *
 * A queue, not a single upload. People drop four files into a chat composer at
 * once, and a teacher uploads a lecture recording while a document is still
 * transcoding, so the unit of state here is a list of jobs with independent
 * progress and independent failure.
 *
 * What this hook adds on top of mediaApi.upload():
 *
 *   concurrency   two files at a time by default; the parts inside each file
 *                 are already parallel, so more would just thrash the radio
 *   cancellation  per job, through an AbortController the job owns
 *   retry         a failed job keeps its source and can be started again
 *   readiness     an upload is not done when the bytes land — it still has to
 *                 be scanned and processed. Jobs stay in `processing` until
 *                 `asset.ready` arrives, which is what the caller must wait for
 *                 before referencing the asset anywhere
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type Media, MediaEvents } from '@classroom/contracts';
import type { MediaApi, UploadSource } from '../api/mediaApi.js';
import type { SignalingTransport } from '../rtc/SfuClient.js';

const { MEDIA_CLIENT_EVENTS: CLIENT, MEDIA_SERVER_EVENTS: SERVER } = MediaEvents;

export type UploadJobStatus =
  | 'queued'
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface UploadJob {
  /** Stable for the life of the job, including across retries. */
  jobId: string;
  fileName: string;
  sizeBytes: number;
  purpose: Media.AssetPurpose;
  status: UploadJobStatus;
  percent: number;
  uploadedBytes: number;
  /** Assigned once the presign returns. */
  assetId: string | null;
  asset: Media.Asset | null;
  error: ApiError | null;
}

export interface UseUploadOptions {
  api: MediaApi;
  /** The `/media` namespace connection, for asset.ready. */
  socket?: SignalingTransport;
  concurrency?: number;
  /** Called once an asset is genuinely usable. */
  onReady?(asset: { assetId: string; jobId: string }): void;
}

export interface UseUploadResult {
  jobs: UploadJob[];
  /** True while anything is uploading or processing. */
  busy: boolean;
  enqueue(
    source: UploadSource,
    options: { purpose: Media.AssetPurpose; contextId?: string },
  ): string;
  cancel(jobId: string): void;
  retry(jobId: string): void;
  /** Removes finished jobs from the list. Does not delete the assets. */
  clearCompleted(): void;
}

interface JobInternals {
  source: UploadSource;
  contextId?: string;
  controller: AbortController;
}

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const useUpload = (options: UseUploadOptions): UseUploadResult => {
  const { api, socket, concurrency = 2 } = options;

  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const internals = useRef(new Map<string, JobInternals>());
  const running = useRef(new Set<string>());

  const patch = useCallback((jobId: string, changes: Partial<UploadJob>) => {
    setJobs((current) => current.map((j) => (j.jobId === jobId ? { ...j, ...changes } : j)));
  }, []);

  // -------------------------------------------------------------------------
  // Readiness — the bytes landing is not the end of the story
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!socket) return;

    const onReady = (payload: MediaEvents.MediaServerPayloads['media:asset.ready']) => {
      setJobs((current) =>
        current.map((j) =>
          j.assetId === payload.assetId ? { ...j, status: 'ready', percent: 100 } : j,
        ),
      );
      const job = jobs.find((j) => j.assetId === payload.assetId);
      if (job) options.onReady?.({ assetId: payload.assetId, jobId: job.jobId });
    };

    const onFailed = (payload: { assetId: string; reason: string }) => {
      setJobs((current) =>
        current.map((j) =>
          j.assetId === payload.assetId
            ? {
                ...j,
                status: 'failed',
                error: new ApiError('asset_not_ready', { detail: payload.reason }),
              }
            : j,
        ),
      );
    };

    const onInfected = (payload: { assetId: string }) => {
      setJobs((current) =>
        current.map((j) =>
          j.assetId === payload.assetId
            ? {
                ...j,
                status: 'failed',
                error: new ApiError('asset_infected', {
                  detail: 'This file was rejected by the virus scan.',
                }),
              }
            : j,
        ),
      );
    };

    socket.on(SERVER.assetReady, onReady as (p: never) => void);
    socket.on(SERVER.transcodeFailed, onFailed as (p: never) => void);
    socket.on(SERVER.assetInfected, onInfected as (p: never) => void);

    return () => {
      socket.off(SERVER.assetReady, onReady as (p: never) => void);
      socket.off(SERVER.transcodeFailed, onFailed as (p: never) => void);
      socket.off(SERVER.assetInfected, onInfected as (p: never) => void);
    };
  }, [socket, jobs, options]);

  /** Watch only the assets this hook is responsible for. */
  useEffect(() => {
    if (!socket) return;
    const assetIds = jobs
      .filter((j) => j.assetId && (j.status === 'processing' || j.status === 'uploading'))
      .map((j) => j.assetId as string);
    if (assetIds.length === 0) return;
    void socket.emitWithAck(CLIENT.watch, { assetIds });
    return () => {
      void socket.emitWithAck(CLIENT.unwatch, { assetIds });
    };
  }, [socket, jobs]);

  // -------------------------------------------------------------------------
  // The pump
  // -------------------------------------------------------------------------

  const run = useCallback(
    async (jobId: string) => {
      const internal = internals.current.get(jobId);
      const job = jobs.find((j) => j.jobId === jobId);
      if (!internal || !job) return;

      running.current.add(jobId);
      patch(jobId, { status: 'uploading', error: null });

      try {
        const asset = await api.upload(internal.source, {
          purpose: job.purpose,
          contextId: internal.contextId,
          signal: internal.controller.signal,
          onProgress: (progress) => {
            patch(jobId, {
              percent: progress.percent,
              uploadedBytes: progress.uploadedBytes,
              assetId: progress.assetId,
            });
          },
        });

        // 'ready' comes from the socket, not from here: the object exists but
        // has not been scanned yet, and referencing it now would be wrong.
        patch(jobId, {
          assetId: asset.assetId,
          asset,
          percent: 100,
          status: asset.status === 'ready' ? 'ready' : 'processing',
        });

        if (asset.status === 'ready') {
          options.onReady?.({ assetId: asset.assetId, jobId });
        }
      } catch (cause) {
        if (internal.controller.signal.aborted) {
          patch(jobId, { status: 'cancelled' });
        } else {
          patch(jobId, {
            status: 'failed',
            error: ApiError.is(cause)
              ? cause
              : new ApiError('upload_incomplete', {
                  detail: cause instanceof Error ? cause.message : 'Upload failed',
                }),
          });
        }
      } finally {
        running.current.delete(jobId);
      }
    },
    [api, jobs, patch, options],
  );

  /** Starts queued jobs whenever a slot frees up. */
  useEffect(() => {
    const free = concurrency - running.current.size;
    if (free <= 0) return;
    const next = jobs.filter((j) => j.status === 'queued' && !running.current.has(j.jobId));
    for (const job of next.slice(0, free)) void run(job.jobId);
  }, [jobs, concurrency, run]);

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  const enqueue = useCallback<UseUploadResult['enqueue']>((source, enqueueOptions) => {
    const jobId = newId();
    internals.current.set(jobId, {
      source,
      contextId: enqueueOptions.contextId,
      controller: new AbortController(),
    });
    setJobs((current) => [
      ...current,
      {
        jobId,
        fileName: source.name,
        sizeBytes: source.size,
        purpose: enqueueOptions.purpose,
        status: 'queued',
        percent: 0,
        uploadedBytes: 0,
        assetId: null,
        asset: null,
        error: null,
      },
    ]);
    return jobId;
  }, []);

  const cancel = useCallback(
    (jobId: string) => {
      internals.current.get(jobId)?.controller.abort();
      patch(jobId, { status: 'cancelled' });
    },
    [patch],
  );

  /** A retry needs a fresh controller; the old one is permanently aborted. */
  const retry = useCallback(
    (jobId: string) => {
      const internal = internals.current.get(jobId);
      if (!internal) return;
      internals.current.set(jobId, { ...internal, controller: new AbortController() });
      patch(jobId, { status: 'queued', percent: 0, uploadedBytes: 0, error: null });
    },
    [patch],
  );

  const clearCompleted = useCallback(() => {
    setJobs((current) => {
      const keep = current.filter(
        (j) => j.status !== 'ready' && j.status !== 'cancelled' && j.status !== 'failed',
      );
      for (const job of current) {
        if (!keep.includes(job)) internals.current.delete(job.jobId);
      }
      return keep;
    });
  }, []);

  const busy = useMemo(
    () => jobs.some((j) => j.status === 'uploading' || j.status === 'processing'),
    [jobs],
  );

  return { jobs, busy, enqueue, cancel, retry, clearCompleted };
};