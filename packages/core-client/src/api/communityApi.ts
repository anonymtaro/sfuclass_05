/**
 * Community API  (F2)
 *
 * Spaces, threads, posts, reactions and the notification bell.
 *
 * The feed is the one call worth thinking about. It is cursor paginated and it
 * is read on almost every screen, so it takes an `AbortSignal` everywhere and
 * never assumes a component is still mounted when it resolves. Reactions are
 * the opposite: tiny, frequent, and the caller updates optimistically, so a
 * failure here has to be cheap to undo.
 */

import { Community } from '@classroom/contracts';
import type { z } from 'zod';
import type { HttpClient } from '../http/httpClient.js';

type FeedQuery = Partial<z.infer<typeof Community.FeedQuerySchema>>;
type SearchQuery = Partial<z.infer<typeof Community.CommunitySearchQuerySchema>> & { q: string };

export interface CommunityApi {
  listSpaces(
    query?: { cursor?: string; limit?: number; joined?: boolean },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Community.SpaceListSchema>>;
  getSpace(spaceId: string, signal?: AbortSignal): Promise<z.infer<typeof Community.SpaceSchema>>;
  createSpace(
    input: z.infer<typeof Community.CreateSpaceSchema>,
  ): Promise<z.infer<typeof Community.SpaceSchema>>;
  updateSpace(
    spaceId: string,
    input: z.infer<typeof Community.UpdateSpaceSchema>,
  ): Promise<z.infer<typeof Community.SpaceSchema>>;
  joinSpace(spaceId: string): Promise<z.infer<typeof Community.MembershipSchema>>;
  leaveSpace(spaceId: string): Promise<void>;
  muteSpace(spaceId: string, muted: boolean): Promise<void>;

  listMembers(
    spaceId: string,
    query?: { cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Community.MembershipListSchema>>;
  updateMembership(
    spaceId: string,
    userId: string,
    input: z.infer<typeof Community.UpdateMembershipSchema>,
  ): Promise<z.infer<typeof Community.MembershipSchema>>;

  getFeed(query?: FeedQuery, signal?: AbortSignal): Promise<z.infer<typeof Community.FeedSchema>>;
  getThread(
    threadId: string,
    query?: { cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Community.ThreadDetailSchema>>;
  createThread(
    input: z.infer<typeof Community.CreateThreadSchema>,
  ): Promise<z.infer<typeof Community.ThreadSchema>>;
  updateThread(
    threadId: string,
    input: z.infer<typeof Community.UpdateThreadSchema>,
  ): Promise<z.infer<typeof Community.ThreadSchema>>;
  deleteThread(threadId: string): Promise<void>;
  followThread(threadId: string, following: boolean): Promise<void>;

  listPosts(
    threadId: string,
    query?: { cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Community.PostListSchema>>;
  createPost(
    threadId: string,
    input: z.infer<typeof Community.CreatePostSchema>,
    idempotencyKey?: string,
  ): Promise<z.infer<typeof Community.PostSchema>>;
  updatePost(threadId: string, postId: string, body: string): Promise<z.infer<typeof Community.PostSchema>>;
  deletePost(threadId: string, postId: string): Promise<void>;
  acceptAnswer(threadId: string, postId: string): Promise<z.infer<typeof Community.ThreadSchema>>;

  react(
    target: { type: 'thread' | 'post'; id: string },
    input: z.infer<typeof Community.ReactSchema>,
  ): Promise<void>;

  moderateThread(
    threadId: string,
    input: z.infer<typeof Community.ModerateThreadSchema>,
  ): Promise<void>;
  report(input: z.infer<typeof Community.ReportContentSchema>): Promise<void>;

  search(
    query: SearchQuery,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Community.CommunitySearchResultSchema>>;

  listNotifications(
    query?: { cursor?: string; limit?: number; unreadOnly?: boolean },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Community.NotificationListSchema>>;
  getUnreadCount(signal?: AbortSignal): Promise<z.infer<typeof Community.NotificationCountSchema>>;
  markNotificationsRead(notificationIds?: string[]): Promise<void>;
}

export const createCommunityApi = (http: HttpClient): CommunityApi => ({
  listSpaces: (query = {}, signal) =>
    http.get('/community/spaces', {
      schema: Community.SpaceListSchema,
      query: { cursor: query.cursor, limit: query.limit, joined: query.joined },
      signal,
    }),

  getSpace: (spaceId, signal) =>
    http.get(`/community/spaces/${encodeURIComponent(spaceId)}`, {
      schema: Community.SpaceSchema,
      signal,
    }),

  createSpace: (input) =>
    http.post('/community/spaces', input, { schema: Community.SpaceSchema }),

  updateSpace: (spaceId, input) =>
    http.patch(`/community/spaces/${encodeURIComponent(spaceId)}`, input, {
      schema: Community.SpaceSchema,
    }),

  joinSpace: (spaceId) =>
    http.post(`/community/spaces/${encodeURIComponent(spaceId)}/members`, undefined, {
      schema: Community.MembershipSchema,
    }),

  leaveSpace: async (spaceId) => {
    await http.delete(`/community/spaces/${encodeURIComponent(spaceId)}/members/me`);
  },

  muteSpace: async (spaceId, muted) => {
    await http.patch(`/community/spaces/${encodeURIComponent(spaceId)}/members/me`, { muted });
  },

  listMembers: (spaceId, query = {}, signal) =>
    http.get(`/community/spaces/${encodeURIComponent(spaceId)}/members`, {
      schema: Community.MembershipListSchema,
      query: { cursor: query.cursor, limit: query.limit },
      signal,
    }),

  updateMembership: (spaceId, userId, input) =>
    http.patch(
      `/community/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(userId)}`,
      input,
      { schema: Community.MembershipSchema },
    ),

  /** Without a spaceId this is the cross-space feed of what the viewer follows. */
  getFeed: (query = {}, signal) =>
    http.get('/community/feed', {
      schema: Community.FeedSchema,
      query: {
        cursor: query.cursor,
        limit: query.limit,
        spaceId: query.spaceId,
        sort: query.sort,
        kind: query.kind,
        tag: query.tag,
        authorId: query.authorId,
        following: query.following,
      },
      signal,
    }),

  getThread: (threadId, query = {}, signal) =>
    http.get(`/community/threads/${encodeURIComponent(threadId)}`, {
      schema: Community.ThreadDetailSchema,
      query: { cursor: query.cursor, limit: query.limit },
      signal,
    }),

  createThread: (input) =>
    http.post('/community/threads', input, { schema: Community.ThreadSchema }),

  updateThread: (threadId, input) =>
    http.patch(`/community/threads/${encodeURIComponent(threadId)}`, input, {
      schema: Community.ThreadSchema,
    }),

  deleteThread: async (threadId) => {
    await http.delete(`/community/threads/${encodeURIComponent(threadId)}`);
  },

  followThread: async (threadId, following) => {
    await http.put(`/community/threads/${encodeURIComponent(threadId)}/follow`, { following });
  },

  listPosts: (threadId, query = {}, signal) =>
    http.get(`/community/threads/${encodeURIComponent(threadId)}/posts`, {
      schema: Community.PostListSchema,
      query: { cursor: query.cursor, limit: query.limit },
      signal,
    }),

  /**
   * Takes an idempotency key so a retry after a dropped connection updates the
   * original reply instead of posting it twice — the failure mode people
   * notice most in a forum.
   */
  createPost: (threadId, input, idempotencyKey) =>
    http.post(`/community/threads/${encodeURIComponent(threadId)}/posts`, input, {
      schema: Community.PostSchema,
      idempotencyKey,
    }),

  updatePost: (threadId, postId, body) =>
    http.patch(
      `/community/threads/${encodeURIComponent(threadId)}/posts/${encodeURIComponent(postId)}`,
      { body },
      { schema: Community.PostSchema },
    ),

  deletePost: async (threadId, postId) => {
    await http.delete(
      `/community/threads/${encodeURIComponent(threadId)}/posts/${encodeURIComponent(postId)}`,
    );
  },

  acceptAnswer: (threadId, postId) =>
    http.post(
      `/community/threads/${encodeURIComponent(threadId)}/accept`,
      { postId },
      { schema: Community.ThreadSchema },
    ),

  /** One route for both targets; the caller updates optimistically. */
  react: async (target, input) => {
    const base =
      target.type === 'thread'
        ? `/community/threads/${encodeURIComponent(target.id)}`
        : `/community/posts/${encodeURIComponent(target.id)}`;
    await http.post(`${base}/reactions`, input, { retry: { attempts: 1 } });
  },

  moderateThread: async (threadId, input) => {
    await http.post(`/community/threads/${encodeURIComponent(threadId)}/moderate`, input);
  },

  report: async (input) => {
    await http.post('/community/reports', input);
  },

  search: (query, signal) =>
    http.get('/community/search', {
      schema: Community.CommunitySearchResultSchema,
      query: {
        q: query.q,
        cursor: query.cursor,
        limit: query.limit,
        spaceId: query.spaceId,
        kind: query.kind,
      },
      signal,
    }),

  listNotifications: (query = {}, signal) =>
    http.get('/community/notifications', {
      schema: Community.NotificationListSchema,
      query: { cursor: query.cursor, limit: query.limit, unreadOnly: query.unreadOnly },
      signal,
    }),

  getUnreadCount: (signal) =>
    http.get('/community/notifications/count', {
      schema: Community.NotificationCountSchema,
      signal,
    }),

  /** No ids means mark everything read. */
  markNotificationsRead: async (notificationIds) => {
    await http.post('/community/notifications/read', { notificationIds });
  },
});