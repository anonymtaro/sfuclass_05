/**
 * Outbox  (F6)
 *
 * At-least-once delivery for socket sends.
 *
 * The socket is the fast path for chat, and the fast path is the one that
 * breaks in a lift. A message handed to `enqueue()` is durable from that moment:
 * it survives a disconnect, a reload and — with persistent storage — the app
 * being killed. It is delivered when the connection returns, in the order it
 * was written.
 *
 * At-least-once, not exactly-once. The queue may send the same item twice; the
 * `dedupeKey` is what makes that harmless. For chat that key is the
 * `clientMessageId`, so a repeat updates the original row rather than creating
 * a second message. Anything enqueued without a meaningful dedupe key must be
 * idempotent on the server by construction.
 *
 * Enqueuing the same key twice replaces the pending item instead of adding one.
 * That is what makes "edit and resend" and "retry" free, and it is why a user
 * hammering send does not produce a queue of five identical messages.
 */

import { ApiError, type SocketAck } from '@classroom/contracts';
import type { SignalingTransport } from '../rtc/SfuClient.js';

export type OutboxItemState = 'pending' | 'inflight' | 'failed';

export interface OutboxItem {
  /** Deduplication identity. Same key means same logical send. */
  dedupeKey: string;
  event: string;
  payload: unknown;
  attempts: number;
  enqueuedAt: number;
  lastError?: string;
  state: OutboxItemState;
}

/** Minimal storage seam: localStorage, AsyncStorage and a Map all satisfy it. */
export interface OutboxStorage {
  read(): Promise<OutboxItem[]> | OutboxItem[];
  write(items: OutboxItem[]): Promise<void> | void;
}

export const createMemoryOutboxStorage = (): OutboxStorage => {
  let items: OutboxItem[] = [];
  return {
    read: () => items,
    write: (next) => {
      items = next;
    },
  };
};

export interface OutboxOptions {
  transport: SignalingTransport;
  storage?: OutboxStorage;
  /** Attempts before an item is parked as failed. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Items older than this are dropped unsent. 0 keeps them forever. */
  maxAgeMs?: number;
  onDelivered?(item: OutboxItem, ack: SocketAck<unknown>): void;
  onFailed?(item: OutboxItem, error: ApiError): void;
  onChange?(items: OutboxItem[]): void;
}

export interface OutboxQueue {
  /** Returns the dedupe key. Sends immediately when connected. */
  enqueue(event: string, payload: unknown, dedupeKey: string): Promise<string>;
  /** Drain what is pending. Called on reconnect and after each enqueue. */
  flush(): Promise<void>;
  /** Move a parked item back to pending. */
  retry(dedupeKey: string): Promise<void>;
  remove(dedupeKey: string): Promise<void>;
  list(): OutboxItem[];
  /** Number of items not yet delivered — drives the "sending…" indicator. */
  readonly size: number;
  clear(): Promise<void>;
}

const DEFAULTS = { maxAttempts: 8, baseDelayMs: 500, maxDelayMs: 30_000, maxAgeMs: 86_400_000 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createOutboxQueue = (options: OutboxOptions): OutboxQueue => {
  const {
    transport,
    storage = createMemoryOutboxStorage(),
    maxAttempts = DEFAULTS.maxAttempts,
    baseDelayMs = DEFAULTS.baseDelayMs,
    maxDelayMs = DEFAULTS.maxDelayMs,
    maxAgeMs = DEFAULTS.maxAgeMs,
    onDelivered,
    onFailed,
    onChange,
  } = options;

  let items: OutboxItem[] = [];
  let loaded = false;
  /** One drain at a time; otherwise order stops meaning anything. */
  let draining = false;

  const persist = async () => {
    await storage.write(items);
    onChange?.([...items]);
  };

  const load = async () => {
    if (loaded) return;
    items = [...(await storage.read())];
    loaded = true;
    // Anything left inflight from a previous run never got its ack. It is
    // pending again — that is exactly what at-least-once means.
    for (const item of items) if (item.state === 'inflight') item.state = 'pending';
  };

  const backoff = (attempts: number): number =>
    Math.min(baseDelayMs * 2 ** Math.max(0, attempts - 1), maxDelayMs);

  const queue: OutboxQueue = {
    get size() {
      return items.filter((item) => item.state !== 'failed').length;
    },

    async enqueue(event, payload, dedupeKey): Promise<string> {
      await load();

      const existing = items.findIndex((item) => item.dedupeKey === dedupeKey);
      const item: OutboxItem = {
        dedupeKey,
        event,
        payload,
        attempts: 0,
        enqueuedAt: Date.now(),
        state: 'pending',
      };

      // Replace rather than append: the newest intent for a key wins, and a
      // duplicate press cannot grow the queue.
      if (existing >= 0) items[existing] = item;
      else items.push(item);

      await persist();
      void queue.flush();
      return dedupeKey;
    },

    async flush(): Promise<void> {
      await load();
      if (draining || !transport.connected) return;
      draining = true;

      try {
        // Strictly in order. A message that arrives before the one it replies
        // to is worse than a message that arrives late.
        for (const item of [...items]) {
          if (item.state === 'failed') continue;
          if (!transport.connected) break;

          if (maxAgeMs > 0 && Date.now() - item.enqueuedAt > maxAgeMs) {
            items = items.filter((i) => i.dedupeKey !== item.dedupeKey);
            onFailed?.(
              item,
              new ApiError('internal_error', { detail: 'Queued too long; discarded.' }),
            );
            continue;
          }

          item.state = 'inflight';
          item.attempts += 1;
          await persist();

          const ack = await transport.emitWithAck(item.event, item.payload);

          if (ack.ok) {
            items = items.filter((i) => i.dedupeKey !== item.dedupeKey);
            await persist();
            onDelivered?.(item, ack);
            continue;
          }

          const error = ApiError.fromResponse(ack.error);
          item.lastError = error.detail ?? error.code;

          // A rejection the server will repeat — blocked, too long, no longer
          // permitted — is not worth eight attempts. Park it immediately.
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
      } finally {
        draining = false;
      }
    },

    async retry(dedupeKey): Promise<void> {
      await load();
      const item = items.find((i) => i.dedupeKey === dedupeKey);
      if (!item) return;
      item.state = 'pending';
      item.attempts = 0;
      delete item.lastError;
      await persist();
      void queue.flush();
    },

    async remove(dedupeKey): Promise<void> {
      await load();
      items = items.filter((item) => item.dedupeKey !== dedupeKey);
      await persist();
    },

    list: () => [...items],

    async clear(): Promise<void> {
      items = [];
      await persist();
    },
  };

  // Reconnecting is the moment the queue exists for.
  if ('onResume' in transport) {
    (transport as { onResume(listener: () => void): () => void }).onResume(() => {
      void queue.flush();
    });
  }

  return queue;
};