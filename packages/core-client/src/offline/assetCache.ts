/**
 * Offline assets  (F4, F5)
 *
 * Downloads lessons for offline use: the video, its captions, and the documents
 * attached to it.
 *
 * The design problem here is that delivery URLs are deliberately short-lived.
 * A signed CloudFront link is valid for CDN_SIGNED_URL_TTL_SEC and then it is
 * dead, so a cache that stored URLs would hold a directory of broken links.
 * This stores the *bytes* and re-requests a fresh ticket every time it needs to
 * fetch, which is why `mediaApi` is a dependency rather than a plain fetch.
 *
 * Storage is injected, because the two platforms have nothing in common here:
 *
 *   web     Cache API or IndexedDB
 *   mobile  expo-file-system, writing into the app's documents directory
 *
 * Eviction is least-recently-used, with pinned entries exempt. Pinning is the
 * user pressing "Download"; everything else is opportunistic and may be thrown
 * away when the budget is reached.
 */

import { ApiError, type Media } from '@classroom/contracts';
import type { MediaApi } from '../api/mediaApi.js';

// ---------------------------------------------------------------------------
// Storage seam
// ---------------------------------------------------------------------------

export interface CachedBlobRef {
  /** Platform-specific handle: an object URL, a file:// path, a cache key. */
  location: string;
  sizeBytes: number;
}

export interface BlobStore {
  /** Streams from `url` into storage and returns a handle to it. */
  put(key: string, url: string, onProgress?: (received: number, total: number) => void): Promise<CachedBlobRef>;
  get(key: string): Promise<CachedBlobRef | null>;
  remove(key: string): Promise<void>;
  /** Bytes currently held. Used for the budget, not for display. */
  usage(): Promise<number>;
}

export interface CacheIndexStorage {
  read(): Promise<CacheEntry[]> | CacheEntry[];
  write(entries: CacheEntry[]): Promise<void> | void;
}

export interface CacheEntry {
  assetId: string;
  /** The lesson this belongs to, so a whole lesson can be evicted together. */
  lessonId: string | null;
  kind: Media.AssetKind;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  location: string;
  /** User-requested downloads survive eviction. */
  pinned: boolean;
  cachedAt: number;
  lastAccessedAt: number;
  /** Integrity check from the asset record, when the server provided one. */
  checksum: string | null;
}

export type DownloadState = 'idle' | 'downloading' | 'cached' | 'failed';

// ---------------------------------------------------------------------------

export interface AssetCacheOptions {
  media: MediaApi;
  store: BlobStore;
  index?: CacheIndexStorage;
  /** Eviction starts above this. Default 2 GB. */
  budgetBytes?: number;
  onProgress?(assetId: string, percent: number): void;
  onChange?(entries: CacheEntry[]): void;
}

export interface AssetCache {
  /** A usable local handle, or null when the asset is not cached. */
  resolve(assetId: string): Promise<CachedBlobRef | null>;
  /** Fetches and stores. Pinned downloads are never evicted automatically. */
  download(
    asset: Pick<Media.Asset, 'assetId' | 'kind' | 'fileName' | 'contentType' | 'sizeBytes' | 'checksum'>,
    options?: { lessonId?: string; pinned?: boolean },
  ): Promise<CachedBlobRef>;
  /** Every asset of a lesson, in one call. Partial failure is reported. */
  downloadLesson(
    lessonId: string,
    assets: Media.Asset[],
  ): Promise<{ cached: string[]; failed: { assetId: string; reason: string }[] }>;
  remove(assetId: string): Promise<void>;
  removeLesson(lessonId: string): Promise<void>;
  has(assetId: string): boolean;
  state(assetId: string): DownloadState;
  list(lessonId?: string): CacheEntry[];
  usageBytes(): Promise<number>;
  /**
   * Frees space down to the budget. Called automatically before a download,
   * where `incomingBytes` is what still has to fit.
   */
  prune(incomingBytes?: number): Promise<number>;
  clear(): Promise<void>;
}

const DEFAULT_BUDGET = 2 * 1024 * 1024 * 1024;

const createMemoryIndex = (): CacheIndexStorage => {
  let entries: CacheEntry[] = [];
  return {
    read: () => entries,
    write: (next) => {
      entries = next;
    },
  };
};

export const createAssetCache = (options: AssetCacheOptions): AssetCache => {
  const {
    media,
    store,
    index = createMemoryIndex(),
    budgetBytes = DEFAULT_BUDGET,
    onProgress,
    onChange,
  } = options;

  let entries: CacheEntry[] = [];
  let loaded = false;
  const inFlight = new Map<string, Promise<CachedBlobRef>>();
  const failed = new Set<string>();

  const persist = async () => {
    await index.write(entries);
    onChange?.([...entries]);
  };

  const load = async () => {
    if (loaded) return;
    entries = [...(await index.read())];
    loaded = true;
  };

  const cache: AssetCache = {
    async resolve(assetId): Promise<CachedBlobRef | null> {
      await load();
      const entry = entries.find((e) => e.assetId === assetId);
      if (!entry) return null;

      // The index may outlive the bytes: a browser can evict its own cache
      // storage under pressure, and a user can clear app data.
      const ref = await store.get(assetId);
      if (!ref) {
        entries = entries.filter((e) => e.assetId !== assetId);
        await persist();
        return null;
      }

      entry.lastAccessedAt = Date.now();
      await persist();
      return ref;
    },

    async download(asset, downloadOptions = {}): Promise<CachedBlobRef> {
      await load();

      const existing = await cache.resolve(asset.assetId);
      if (existing) {
        // Already here; honour a pin upgrade without re-fetching.
        if (downloadOptions.pinned) {
          const entry = entries.find((e) => e.assetId === asset.assetId);
          if (entry) {
            entry.pinned = true;
            await persist();
          }
        }
        return existing;
      }

      // Two components asking for the same lesson must not download it twice.
      const running = inFlight.get(asset.assetId);
      if (running) return running;

      const task = (async () => {
        // Make room first: failing mid-download leaves a partial file that the
        // store then has to clean up.
        if (asset.sizeBytes > 0) await cache.prune(asset.sizeBytes);

        // A fresh ticket every time. Stored URLs would be expired by the time
        // anyone opened the downloads screen.
        const ticket = await media.createDownload(asset.assetId, 'attachment');

        const ref = await store.put(asset.assetId, ticket.url, (received, total) => {
          if (total > 0) onProgress?.(asset.assetId, Math.round((received / total) * 100));
        });

        entries.push({
          assetId: asset.assetId,
          lessonId: downloadOptions.lessonId ?? null,
          kind: asset.kind,
          fileName: asset.fileName,
          contentType: asset.contentType,
          sizeBytes: ref.sizeBytes || asset.sizeBytes,
          location: ref.location,
          pinned: downloadOptions.pinned ?? false,
          cachedAt: Date.now(),
          lastAccessedAt: Date.now(),
          checksum: asset.checksum ?? null,
        });

        failed.delete(asset.assetId);
        await persist();
        return ref;
      })();

      inFlight.set(asset.assetId, task);
      try {
        return await task;
      } catch (cause) {
        failed.add(asset.assetId);
        await store.remove(asset.assetId).catch(() => undefined);
        throw ApiError.is(cause)
          ? cause
          : new ApiError('dependency_unavailable', {
              detail: `Could not download ${asset.fileName}.`,
              cause,
            });
      } finally {
        inFlight.delete(asset.assetId);
      }
    },

    /**
     * Sequential, not parallel. A lesson is a video plus small files, and
     * saturating a phone's connection with four simultaneous downloads makes
     * all of them slower and the progress bar meaningless.
     */
    async downloadLesson(lessonId, assets) {
      const cached: string[] = [];
      const failures: { assetId: string; reason: string }[] = [];

      for (const asset of assets) {
        if (asset.status !== 'ready') {
          failures.push({ assetId: asset.assetId, reason: 'not ready yet' });
          continue;
        }
        try {
          await cache.download(asset, { lessonId, pinned: true });
          cached.push(asset.assetId);
        } catch (cause) {
          failures.push({
            assetId: asset.assetId,
            reason: cause instanceof Error ? cause.message : 'download failed',
          });
        }
      }

      return { cached, failed: failures };
    },

    async remove(assetId): Promise<void> {
      await load();
      await store.remove(assetId).catch(() => undefined);
      entries = entries.filter((e) => e.assetId !== assetId);
      await persist();
    },

    async removeLesson(lessonId): Promise<void> {
      await load();
      for (const entry of entries.filter((e) => e.lessonId === lessonId)) {
        await store.remove(entry.assetId).catch(() => undefined);
      }
      entries = entries.filter((e) => e.lessonId !== lessonId);
      await persist();
    },

    has: (assetId) => entries.some((e) => e.assetId === assetId),

    state(assetId): DownloadState {
      if (inFlight.has(assetId)) return 'downloading';
      if (entries.some((e) => e.assetId === assetId)) return 'cached';
      if (failed.has(assetId)) return 'failed';
      return 'idle';
    },

    list: (lessonId) =>
      lessonId ? entries.filter((e) => e.lessonId === lessonId) : [...entries],

    usageBytes: () => store.usage(),

    /**
     * Evicts least-recently-used unpinned entries until the incoming asset
     * fits. Pinned entries are never touched: the user asked for those, and
     * silently deleting a downloaded lecture the night before an exam is the
     * kind of thing people do not forgive.
     */
    async prune(incomingBytes = 0): Promise<number> {
      await load();
      let usage = await store.usage();
      if (usage + incomingBytes <= budgetBytes) return 0;

      const candidates = entries
        .filter((entry) => !entry.pinned)
        .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

      let freed = 0;
      for (const entry of candidates) {
        if (usage + incomingBytes <= budgetBytes) break;
        await store.remove(entry.assetId).catch(() => undefined);
        entries = entries.filter((e) => e.assetId !== entry.assetId);
        usage -= entry.sizeBytes;
        freed += entry.sizeBytes;
      }

      await persist();
      return freed;
    },

    async clear(): Promise<void> {
      await load();
      for (const entry of entries) await store.remove(entry.assetId).catch(() => undefined);
      entries = [];
      failed.clear();
      await persist();
    },
  };

  return cache;
};