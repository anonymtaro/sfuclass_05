/**
 * Mutation replay  (F5)
 *
 * The outbox does this for socket sends. This does it for HTTP mutations, and
 * the difference matters: a socket send is a fire-and-forget message, while an
 * HTTP mutation changes a resource that somebody else may have changed in the
 * meantime.
 *
 * So this queue carries two things the outbox does not:
 *
 *   an idempotency key   every replayed mutation goes out with the same key it
 *                        was created with, so a request the server already
 *                        processed before the connection dropped is recognised
 *                        rather than applied twice
 *
 *   conflict handling    a replay can come back with `version_mismatch`, which
 *                        means the world moved while the device was away. That
 *                        is not a retryable error and not a silent failure: it
 *                        goes to `onConflict` for the app to resolve, because
 *                        only the app knows whether last-write-wins is
 *                        acceptable for that particular resource
 *
 * What this is deliberately not: a general offline database. It replays
 * intentions in order. Reads still come from the network or from assetCache.
 */

import { ApiError } from '@classroom/contracts';
import type { HttpClient, HttpMethod } from '../http/httpClient.js';

export type SyncItemState = 'pending' | 'inflight' | 'conflict' | 'failed';

export interface SyncItem {
  /** Also sent as the Idempotency-Key header. Stable across replays. */
  id: string;
  method: HttpMethod;
  path: string;
  body?: unknown;
  /** Grouping label for the UI: 'chat', 'progress', 'course'. */
  scope: string;
  /**
   * Items with the same collapse key supersede each other. A lesson position
   * reported forty times offline should replay once, not forty times.
   */
  collapseKey?: string;
  attempts: number;
  enqueuedAt: number;
  state: SyncItemState;
  lastError?: string;
}

export interface SyncStorage {
  read(): Promise<SyncItem[]> | SyncItem[];
  write(items: SyncItem[]): Promise<void> | void;
}

export const createMemorySyncStorage = (): SyncStorage => {
  let items: SyncItem[] = [];
  return {
    read: () => items,
    write: (next) => {
      items = next;
    },
  };
};

export interface SyncQueueOptions {
  http: HttpClient;
  storage?: SyncStorage;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Reports connectivity. Defaults to always-online. */
  isOnline?(): boolean;
  onApplied?(item: SyncItem, result: unknown): void;
  /** The resource changed underneath us. The app decides what happens next. */
  onConflict?(item: SyncItem, error: ApiError): void;
  onFailed?(item: SyncItem, error: ApiError): void;
  onChange?(items: SyncItem[]): void;
}

export interface SyncQueue {
  enqueue(input: Omit<SyncItem, 'attempts' | 'enqueuedAt' | 'state' | 'id'> & { id?: string }): Promise<string>;
  /** Replay everything pending, oldest first. Safe to call repeatedly. */
  replay(): Promise<void>;
  resolve(id: string, action: 'retry' | 'discard'): Promise<void>;
  list(scope?: string): SyncItem[];
  readonly pending: number;
  readonly conflicts: SyncItem[];
  clear(): Promise<void>;
}

const DEFAULTS = { maxAttempts: 6, baseDelayMs: 1_000, maxDelayMs: 60_000 };

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createSyncQueue = (options: SyncQueueOptions): SyncQueue => {
  const {
    http,
    storage = createMemorySyncStorage(),
    maxAttempts = DEFAULTS.maxAttempts,
    baseDelayMs = DEFAULTS.baseDelayMs,
    maxDelayMs = DEFAULTS.maxDelayMs,
    isOnline = () => true,
    onApplied,
    onConflict,
    onFailed,
    onChange,
  } = options;

  let items: SyncItem[] = [];
  let loaded = false;
  let replaying = false;

  const persist = async () => {
    await storage.write(items);
    onChange?.([...items]);
  };

  const load = async () => {
    if (loaded) return;
    items = [...(await storage.read())];
    loaded = true;
    // Anything inflight when the process died is pending again. The
    // idempotency key makes a duplicate application harmless.
    for (const item of items) if (item.state === 'inflight') item.state = 'pending';
  };

  const backoff = (attempts: number) =>
    Math.min(baseDelayMs * 2 ** Math.max(0, attempts - 1), maxDelayMs);

  const queue: SyncQueue = {
    get pending() {
      return items.filter((item) => item.state === 'pending' || item.state === 'inflight').length;
    },

    get conflicts() {
      return items.filter((item) => item.state === 'conflict');
    },

    async enqueue(input): Promise<string> {
      await load();

      const item: SyncItem = {
        id: input.id ?? newId(),
        method: input.method,
        path: input.path,
        body: input.body,
        scope: input.scope,
        collapseKey: input.collapseKey,
        attempts: 0,
        enqueuedAt: Date.now(),
        state: 'pending',
      };

      // Collapse supersedes; it does not merge. The newest intention is the
      // only one worth replaying for progress, presence or a draft.
      if (item.collapseKey) {
        items = items.filter(
          (existing) => existing.collapseKey !== item.collapseKey || existing.state === 'conflict',
        );
      }

      items.push(item);
      await persist();
      if (isOnline()) void queue.replay();
      return item.id;
    },

    async replay(): Promise<void> {
      await load();
      if (replaying || !isOnline()) return;
      replaying = true;

      try {
        for (const item of [...items]) {
          if (item.state !== 'pending') continue;
          if (!isOnline()) break;

          item.state = 'inflight';
          item.attempts += 1;
          await persist();

          try {
            const result = await http.request(item.path, {
              method: item.method,
              body: item.body,
              // The same key every time: that is what makes a replay safe.
              idempotencyKey: item.id,
              // The queue owns the retry policy; the client must not add its own.
              retry: { attempts: 1 },
            });

            items = items.filter((i) => i.id !== item.id);
            await persist();
            onApplied?.(item, result);
          } catch (cause) {
            const error = ApiError.is(cause)
              ? cause
              : new ApiError('dependency_unavailable', { detail: 'Replay failed' });
            item.lastError = error.detail ?? error.code;

            // The resource moved on. Nobody but the app can decide whether the
            // local change still makes sense.
            if (error.code === 'version_mismatch' || error.code === 'conflict') {
              item.state = 'conflict';
              await persist();
              onConflict?.(item, error);
              continue;
            }

            // A permanent rejection — deleted, forbidden, invalid — will not
            // improve with time. Park it and tell the app.
            if (!error.retryable) {
              item.state = 'failed';
              await persist();
              onFailed?.(item, error);
              continue;
            }

            if (item.attempts >= maxAttempts) {
              item.state = 'failed';
              await persist();
              onFailed?.(item, error);
              continue;
            }

            item.state = 'pending';
            await persist();
            await sleep(error.retryAfter ? error.retryAfter * 1000 : backoff(item.attempts));
          }
        }
      } finally {
        replaying = false;
      }
    },

    async resolve(id, action): Promise<void> {
      await load();
      if (action === 'discard') {
        items = items.filter((item) => item.id !== id);
        await persist();
        return;
      }
      const item = items.find((i) => i.id === id);
      if (!item) return;
      item.state = 'pending';
      item.attempts = 0;
      delete item.lastError;
      await persist();
      void queue.replay();
    },

    list: (scope) => (scope ? items.filter((item) => item.scope === scope) : [...items]),

    async clear(): Promise<void> {
      items = [];
      await persist();
    },
  };

  return queue;
};