/**
 * Room to SFU node resolution  (F1)
 *
 * Media does not go through the API. Before a client can join a room it has to
 * learn which SFU node holds it, because rooms are sticky to a node for their
 * whole life — the peers of one room share a mediasoup router, and a router
 * lives in one process on one machine.
 *
 *   GET /rooms/:roomId/node  →  { nodeId, wsUrl, expiresAt }
 *
 * The server answers from RoomRegistry (Redis) and creates the assignment on
 * first ask. This module adds three things around that call:
 *
 *   caching       a resolution is good for its TTL; rejoining after a reload
 *                 should not cost a round trip
 *   single-flight four components mounting at once produce one request
 *   invalidation  a draining node, a closed room or a failed connection drops
 *                 the entry so the next attempt asks again
 *
 * The last one is why this is a module rather than one line inside SfuClient.
 * deploy-sfu.yml replaces nodes while lessons are running: a draining node
 * keeps its existing rooms but accepts no new ones, and a client told to
 * reconnect must not be handed the node it just left.
 */

import { z } from 'zod';
import { ApiError } from '@classroom/contracts';
import type { HttpClient } from '../http/httpClient.js';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const SfuNodeSchema = z.object({
  nodeId: z.string().min(1).max(64),
  /** Full wss:// origin of the node, resolved through Route 53. */
  wsUrl: z.string().url(),
  /** Advisory: the assignment may be re-checked after this. */
  expiresAt: z.iso.datetime({ offset: false }),
  region: z.string().max(32).nullable().default(null),
  /** True while the node is being replaced; join elsewhere if possible. */
  draining: z.boolean().default(false),
});
export type SfuNode = z.infer<typeof SfuNodeSchema>;

export interface NodeResolver {
  /** Cached unless `force` is set. */
  resolve(roomId: string, options?: { force?: boolean; signal?: AbortSignal }): Promise<SfuNode>;
  /** Drops one room's assignment. Call after any connection failure. */
  invalidate(roomId: string): void;
  /** Drops everything. Used on sign-out and on a network change. */
  clear(): void;
  /**
   * Records a node this client must not be handed again for this room, then
   * re-resolves. Driven by the `classroom:node.draining` event.
   */
  rotate(roomId: string, avoidNodeId: string): Promise<SfuNode>;
  /** Whatever is cached, without a request. Null when nothing usable is. */
  peek(roomId: string): SfuNode | null;
}

export interface NodeResolverOptions {
  http: HttpClient;
  /** Upper bound regardless of what the server said. */
  maxCacheMs?: number;
  /** Re-resolve this long before the assignment expires. */
  refreshMarginMs?: number;
  clock?: () => number;
  onResolved?(roomId: string, node: SfuNode): void;
}

interface CacheEntry {
  node: SfuNode;
  expiresAtMs: number;
  /** Nodes this client has been told to avoid for this room. */
  avoid: Set<string>;
}

const DEFAULT_MAX_CACHE_MS = 5 * 60_000;
const DEFAULT_REFRESH_MARGIN_MS = 30_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createNodeResolver = (options: NodeResolverOptions): NodeResolver => {
  const {
    http,
    maxCacheMs = DEFAULT_MAX_CACHE_MS,
    refreshMarginMs = DEFAULT_REFRESH_MARGIN_MS,
    clock = Date.now,
    onResolved,
  } = options;

  const cache = new Map<string, CacheEntry>();
  /** One in-flight request per room, shared by every concurrent caller. */
  const inFlight = new Map<string, Promise<SfuNode>>();

  const isFresh = (entry: CacheEntry): boolean =>
    !entry.node.draining && entry.expiresAtMs - refreshMarginMs > clock();

  const fetchNode = async (
    roomId: string,
    avoid: Set<string>,
    signal?: AbortSignal,
  ): Promise<SfuNode> => {
    const node = await http.get(`/rooms/${encodeURIComponent(roomId)}/node`, {
      schema: SfuNodeSchema,
      signal,
      query: avoid.size > 0 ? { avoid: [...avoid].join(',') } : undefined,
      // The room may be being assigned right now; a brief 503 while a node is
      // chosen is normal and worth waiting out.
      retry: { attempts: 4, baseDelayMs: 400 },
    });

    // Never trust the TTL blindly: a long one would outlive a deployment.
    const serverExpiry = Date.parse(node.expiresAt);
    const expiresAtMs = Math.min(
      Number.isNaN(serverExpiry) ? clock() + maxCacheMs : serverExpiry,
      clock() + maxCacheMs,
    );

    cache.set(roomId, { node, expiresAtMs, avoid });
    onResolved?.(roomId, node);
    return node;
  };

  const resolveInternal = (
    roomId: string,
    avoid: Set<string>,
    signal?: AbortSignal,
  ): Promise<SfuNode> => {
    const existing = inFlight.get(roomId);
    if (existing) return existing;

    const promise = fetchNode(roomId, avoid, signal).finally(() => {
      inFlight.delete(roomId);
    });
    inFlight.set(roomId, promise);
    return promise;
  };

  return {
    async resolve(roomId, resolveOptions = {}): Promise<SfuNode> {
      const entry = cache.get(roomId);
      if (!resolveOptions.force && entry && isFresh(entry)) {
        return entry.node;
      }
      return resolveInternal(roomId, entry?.avoid ?? new Set<string>(), resolveOptions.signal);
    },

    invalidate(roomId): void {
      cache.delete(roomId);
      inFlight.delete(roomId);
    },

    clear(): void {
      cache.clear();
      inFlight.clear();
    },

    async rotate(roomId, avoidNodeId): Promise<SfuNode> {
      const entry = cache.get(roomId);
      const avoid = entry?.avoid ?? new Set<string>();
      avoid.add(avoidNodeId);
      cache.delete(roomId);
      inFlight.delete(roomId);

      const node = await resolveInternal(roomId, avoid);

      // The server may legitimately return the same node — the room lives
      // there and cannot be moved mid-session. Say so plainly rather than
      // looping: the caller decides whether to wait or to end the session.
      if (node.nodeId === avoidNodeId) {
        throw new ApiError('sfu_unavailable', {
          detail: 'The room is still held by the node that is shutting down.',
          retryAfter: 10,
        });
      }
      return node;
    },

    peek(roomId): SfuNode | null {
      const entry = cache.get(roomId);
      return entry && isFresh(entry) ? entry.node : null;
    },
  };
};