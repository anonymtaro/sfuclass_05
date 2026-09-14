/**
 * useCommunity  (F2)
 *
 * The feed and one thread, plus the notification bell.
 *
 * Community traffic is quiet compared to chat, and its content is durable, so
 * the socket here carries notifications about changes rather than the changes
 * themselves. A `post.created` event bumps a counter and marks the thread
 * unread; the body is fetched when someone actually opens it. That keeps a
 * hundred idle tabs from each holding a full copy of every thread.
 *
 * Posting is optimistic with an idempotency key, for the same reason chat is:
 * a reply lost to a dropped connection is the failure people remember, and a
 * reply posted twice is the one they complain about.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, CommunityEvents, type Community } from '@classroom/contracts';
import type { CommunityApi } from '../api/communityApi.js';
import type { SignalingTransport } from '../rtc/SfuClient.js';

const { COMMUNITY_CLIENT_EVENTS: CLIENT, COMMUNITY_SERVER_EVENTS: SERVER } = CommunityEvents;

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export interface UseCommunityOptions {
  api: CommunityApi;
  socket?: SignalingTransport;
  /** Omit for the cross-space feed of everything the viewer follows. */
  spaceId?: string;
  sort?: Community.FeedSort;
  pageSize?: number;
}

export interface UseCommunityResult {
  threads: Community.Thread[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: ApiError | null;
  /** Unread notification count for the bell. */
  unreadNotifications: number;

  loadMore(): Promise<void>;
  refresh(): Promise<void>;
  createThread(input: Community.CreateThread): Promise<Community.Thread>;
  reactToThread(threadId: string, emoji: string, action?: 'add' | 'remove'): Promise<void>;
  follow(threadId: string, following: boolean): Promise<void>;
  markNotificationsRead(): Promise<void>;
}

export const useCommunity = (options: UseCommunityOptions): UseCommunityResult => {
  const { api, socket, spaceId, sort = 'active', pageSize = 20 } = options;

  const [threads, setThreads] = useState<Community.Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [unreadNotifications, setUnread] = useState(0);

  const cursorRef = useRef<string | null>(null);

  // -------------------------------------------------------------------------
  // Feed
  // -------------------------------------------------------------------------

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      cursorRef.current = null;
      try {
        const page = await api.getFeed(
          { spaceId: spaceId as Community.SpaceId | undefined, sort, limit: pageSize },
          signal,
        );
        setThreads(page.items);
        cursorRef.current = page.nextCursor;
        setHasMore(page.hasMore);
        setError(null);
      } catch (cause) {
        if (!signal?.aborted) setError(ApiError.is(cause) ? cause : null);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [api, spaceId, sort, pageSize],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursorRef.current || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.getFeed({
        spaceId: spaceId as Community.SpaceId | undefined,
        sort,
        limit: pageSize,
        cursor: cursorRef.current,
      });
      // Guard against a thread arriving twice when it is bumped between pages.
      setThreads((current) => {
        const seen = new Set(current.map((t) => t.threadId));
        return [...current, ...page.items.filter((t) => !seen.has(t.threadId))];
      });
      cursorRef.current = page.nextCursor;
      setHasMore(page.hasMore);
    } catch (cause) {
      setError(ApiError.is(cause) ? cause : null);
    } finally {
      setLoadingMore(false);
    }
  }, [api, spaceId, sort, pageSize, loadingMore]);

  // -------------------------------------------------------------------------
  // Notifications and live updates
  // -------------------------------------------------------------------------

  useEffect(() => {
    void api
      .getUnreadCount()
      .then((result) => setUnread(result.unread))
      .catch(() => undefined);
  }, [api]);

  useEffect(() => {
    if (!socket) return;
    if (spaceId) void socket.emitWithAck(CLIENT.watchSpaces, { spaceIds: [spaceId] });

    const onPost = (payload: CommunityEvents.CommunityServerPayloads['community:post.created']) => {
      setThreads((current) =>
        current.map((t) =>
          t.threadId === payload.threadId
            ? {
                ...t,
                postCount: payload.postCount,
                lastPostAt: payload.createdAt,
                lastPostBy: payload.author,
                unread: true,
              }
            : t,
        ),
      );
    };

    const onThread = (
      payload: CommunityEvents.CommunityServerPayloads['community:thread.created'],
    ) => {
      // Only refetch when the new thread belongs to the feed being shown; a
      // cross-space feed would otherwise refetch on every tenant-wide post.
      if (spaceId && payload.spaceId !== spaceId) return;
      void load();
    };

    const onNotification = (
      payload: CommunityEvents.CommunityServerPayloads['community:notification'],
    ) => setUnread(payload.unread);

    const onRemoved = (
      payload: CommunityEvents.CommunityServerPayloads['community:content.removed'],
    ) => {
      if (payload.targetType !== 'thread') return;
      setThreads((current) => current.filter((t) => t.threadId !== payload.targetId));
    };

    socket.on(SERVER.postCreated, onPost as (p: never) => void);
    socket.on(SERVER.threadCreated, onThread as (p: never) => void);
    socket.on(SERVER.notification, onNotification as (p: never) => void);
    socket.on(SERVER.contentRemoved, onRemoved as (p: never) => void);

    return () => {
      socket.off(SERVER.postCreated, onPost as (p: never) => void);
      socket.off(SERVER.threadCreated, onThread as (p: never) => void);
      socket.off(SERVER.notification, onNotification as (p: never) => void);
      socket.off(SERVER.contentRemoved, onRemoved as (p: never) => void);
      if (spaceId) void socket.emitWithAck(CLIENT.unwatchSpaces, { spaceIds: [spaceId] });
    };
  }, [socket, spaceId, load]);

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  const reactToThread = useCallback(
    async (threadId: string, emoji: string, action: 'add' | 'remove' = 'add') => {
      // Optimistic, and cheap to undo — a reaction chip is not worth a spinner.
      const before = threads;
      setThreads((current) =>
        current.map((t) => {
          if (t.threadId !== threadId) return t;
          const others = t.reactions.filter((r) => r.emoji !== emoji);
          const existing = t.reactions.find((r) => r.emoji === emoji);
          const count = (existing?.count ?? 0) + (action === 'add' ? 1 : -1);
          return {
            ...t,
            reactions:
              count > 0
                ? [...others, { emoji, count, reacted: action === 'add' }]
                : others,
          };
        }),
      );

      try {
        await api.react({ type: 'thread', id: threadId }, { emoji, action });
      } catch {
        setThreads(before);
      }
    },
    [api, threads],
  );

  return {
    threads,
    loading,
    loadingMore,
    hasMore,
    error,
    unreadNotifications,

    loadMore,
    refresh: () => load(),

    createThread: async (input) => {
      const thread = await api.createThread(input);
      setThreads((current) => [thread, ...current]);
      return thread;
    },

    reactToThread,

    follow: async (threadId, following) => {
      setThreads((current) =>
        current.map((t) => (t.threadId === threadId ? { ...t, following } : t)),
      );
      await api.followThread(threadId, following);
    },

    markNotificationsRead: async () => {
      setUnread(0);
      await api.markNotificationsRead();
    },
  };
};

// ---------------------------------------------------------------------------
// One thread
// ---------------------------------------------------------------------------

export interface UseThreadOptions {
  api: CommunityApi;
  socket?: SignalingTransport;
  threadId: string;
  pageSize?: number;
}

export type PostView = Community.Post & { delivery: 'sending' | 'sent' | 'failed' };

export interface UseThreadResult {
  thread: Community.Thread | null;
  posts: PostView[];
  loading: boolean;
  hasMore: boolean;
  error: ApiError | null;
  loadMore(): Promise<void>;
  reply(input: Community.CreatePost): Promise<void>;
  retry(postId: string): Promise<void>;
}

export const useThread = (options: UseThreadOptions): UseThreadResult => {
  const { api, socket, threadId, pageSize = 25 } = options;

  const [thread, setThread] = useState<Community.Thread | null>(null);
  const [posts, setPosts] = useState<PostView[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const cursorRef = useRef<string | null>(null);
  const pendingRef = useRef(new Map<string, Community.CreatePost>());

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    void api
      .getThread(threadId, { limit: pageSize }, controller.signal)
      .then((detail) => {
        setThread(detail);
        setPosts(detail.posts.items.map((p) => ({ ...p, delivery: 'sent' as const })));
        cursorRef.current = detail.posts.nextCursor;
        setHasMore(detail.posts.hasMore);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(ApiError.is(cause) ? cause : null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [api, threadId, pageSize]);

  useEffect(() => {
    if (!socket) return;
    void socket.emitWithAck(CLIENT.watchThread, { threadId });
    return () => {
      void socket.emitWithAck(CLIENT.unwatchThread, { threadId });
    };
  }, [socket, threadId]);

  const deliver = useCallback(
    async (tempId: string, input: Community.CreatePost) => {
      try {
        const saved = await api.createPost(threadId, input, tempId);
        setPosts((current) =>
          current.map((p) => (p.postId === tempId ? { ...saved, delivery: 'sent' as const } : p)),
        );
        pendingRef.current.delete(tempId);
      } catch (cause) {
        setPosts((current) =>
          current.map((p) => (p.postId === tempId ? { ...p, delivery: 'failed' as const } : p)),
        );
        if (ApiError.is(cause)) setError(cause);
      }
    },
    [api, threadId],
  );

  return {
    thread,
    posts,
    loading,
    hasMore,
    error,

    loadMore: async () => {
      if (!cursorRef.current) return;
      const page = await api.listPosts(threadId, { cursor: cursorRef.current, limit: pageSize });
      setPosts((current) => [
        ...current,
        ...page.items.map((p) => ({ ...p, delivery: 'sent' as const })),
      ]);
      cursorRef.current = page.nextCursor;
      setHasMore(page.hasMore);
    },

    reply: async (input) => {
      const tempId = newId();
      pendingRef.current.set(tempId, input);
      setPosts((current) => [
        ...current,
        {
          postId: tempId as Community.PostId,
          threadId: threadId as Community.ThreadId,
          author: null,
          body: input.body,
          attachments: [],
          mentions: input.mentions ?? [],
          reactions: [],
          replyToPostId: (input.replyToPostId ?? null) as Community.PostId | null,
          acceptedAnswer: false,
          editedAt: null,
          deletedAt: null,
          createdAt: new Date().toISOString(),
          delivery: 'sending',
        },
      ]);
      await deliver(tempId, input);
    },

    /** The same key is reused, so a retry updates rather than duplicates. */
    retry: async (postId) => {
      const input = pendingRef.current.get(postId);
      if (!input) return;
      setPosts((current) =>
        current.map((p) => (p.postId === postId ? { ...p, delivery: 'sending' as const } : p)),
      );
      await deliver(postId, input);
    },
  };
};