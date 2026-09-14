/**
 * Chat API  (F6)
 *
 * The HTTP half of messaging. Every mutation here has a socket twin in
 * chat.events.ts, and that symmetry is deliberate: the socket is the fast path
 * when a connection is already open, and this is the path that still works on a
 * train. Neither is a fallback bolted onto the other — they take the same
 * payload and produce the same result.
 *
 * Two rules the whole feature rests on:
 *
 *   `openDirect()` is idempotent. It returns the existing conversation or
 *   creates one. That is why the Message button on a profile card is a single
 *   call with no "new conversation" flow to keep in sync.
 *
 *   Every send carries a client-generated `clientMessageId`. The server treats
 *   a repeat as an update to the original row, which is what makes the offline
 *   outbox safe to replay after a reconnect.
 */

import { Chat } from '@classroom/contracts';
import type { z } from 'zod';
import type { HttpClient } from '../http/httpClient.js';

type ChatTarget = z.infer<typeof Chat.ChatTargetSchema>;

/** Targets are a union; routes are flat. This is the one mapping between them. */
const targetPath = (target: ChatTarget): string => {
  switch (target.kind) {
    case 'conversation':
      return `/messaging/conversations/${encodeURIComponent(target.conversationId)}`;
    case 'channel':
      return `/messaging/channels/${encodeURIComponent(target.channelId)}`;
    case 'room':
      return `/messaging/rooms/${encodeURIComponent(target.roomId)}`;
  }
};

export interface ChatApi {
  listConversations(
    query?: { cursor?: string; limit?: number; archived?: boolean },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Chat.ConversationListSchema>>;
  getConversation(
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Chat.ConversationSchema>>;
  /** Idempotent: the Message action on a profile card. */
  openDirect(userId: string): Promise<z.infer<typeof Chat.ConversationSchema>>;
  createGroup(
    input: z.infer<typeof Chat.CreateGroupConversationSchema>,
  ): Promise<z.infer<typeof Chat.ConversationSchema>>;
  archiveConversation(conversationId: string, archived: boolean): Promise<void>;
  muteConversation(conversationId: string, muted: boolean): Promise<void>;
  leaveConversation(conversationId: string): Promise<void>;

  listChannels(
    query?: { cursor?: string; limit?: number; scope?: 'public' | 'space' | 'course' },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Chat.ChannelListSchema>>;
  getChannel(channelId: string, signal?: AbortSignal): Promise<z.infer<typeof Chat.ChannelSchema>>;
  joinChannel(channelId: string): Promise<z.infer<typeof Chat.ChannelSchema>>;
  muteChannel(channelId: string, muted: boolean): Promise<void>;

  listMessages(
    target: ChatTarget,
    query?: z.infer<typeof Chat.ListMessagesQuerySchema>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Chat.MessageListSchema>>;
  send(input: z.infer<typeof Chat.SendMessageSchema>): Promise<z.infer<typeof Chat.MessageSchema>>;
  edit(messageId: string, body: string): Promise<z.infer<typeof Chat.MessageSchema>>;
  remove(messageId: string): Promise<void>;
  react(
    messageId: string,
    input: z.infer<typeof Chat.ReactToMessageSchema>,
  ): Promise<void>;

  markRead(target: ChatTarget, messageId: string): Promise<void>;
  getUnread(signal?: AbortSignal): Promise<z.infer<typeof Chat.UnreadSummarySchema>>;

  /** Announces intent so the composer can show a row and the quota is checked. */
  requestAttachment(
    input: z.infer<typeof Chat.RequestChatAttachmentSchema>,
  ): Promise<{ assetId: string }>;

  search(
    query: z.infer<typeof Chat.ChatSearchQuerySchema>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Chat.ChatSearchResultSchema>>;

  reportMessage(input: z.infer<typeof Chat.ReportMessageSchema>): Promise<void>;
  moderateMessage(
    messageId: string,
    input: z.infer<typeof Chat.ModerateMessageSchema>,
  ): Promise<void>;
  setSlowMode(channelId: string, slowModeSec: number): Promise<z.infer<typeof Chat.ChannelSchema>>;
}

const AttachmentTicketSchema = Chat.MessageAttachmentSchema.pick({ assetId: true });

export const createChatApi = (http: HttpClient): ChatApi => ({
  listConversations: (query = {}, signal) =>
    http.get('/messaging/conversations', {
      schema: Chat.ConversationListSchema,
      query: { cursor: query.cursor, limit: query.limit, archived: query.archived },
      signal,
    }),

  getConversation: (conversationId, signal) =>
    http.get(`/messaging/conversations/${encodeURIComponent(conversationId)}`, {
      schema: Chat.ConversationSchema,
      signal,
    }),

  /**
   * POST rather than PUT because the server may create. Safe to call twice:
   * the second call returns the same conversation, so a double-tap on a
   * profile card cannot produce two threads with the same person.
   */
  openDirect: (userId) =>
    http.post(
      '/messaging/conversations/direct',
      { userId },
      { schema: Chat.ConversationSchema, idempotencyKey: `direct:${userId}` },
    ),

  createGroup: (input) =>
    http.post('/messaging/conversations', input, { schema: Chat.ConversationSchema }),

  archiveConversation: async (conversationId, archived) => {
    await http.patch(`/messaging/conversations/${encodeURIComponent(conversationId)}`, {
      archived,
    });
  },

  muteConversation: async (conversationId, muted) => {
    await http.patch(`/messaging/conversations/${encodeURIComponent(conversationId)}`, { muted });
  },

  leaveConversation: async (conversationId) => {
    await http.delete(
      `/messaging/conversations/${encodeURIComponent(conversationId)}/participants/me`,
    );
  },

  listChannels: (query = {}, signal) =>
    http.get('/messaging/channels', {
      schema: Chat.ChannelListSchema,
      query: { cursor: query.cursor, limit: query.limit, scope: query.scope },
      signal,
    }),

  getChannel: (channelId, signal) =>
    http.get(`/messaging/channels/${encodeURIComponent(channelId)}`, {
      schema: Chat.ChannelSchema,
      signal,
    }),

  joinChannel: (channelId) =>
    http.post(`/messaging/channels/${encodeURIComponent(channelId)}/members`, undefined, {
      schema: Chat.ChannelSchema,
    }),

  muteChannel: async (channelId, muted) => {
    await http.patch(`/messaging/channels/${encodeURIComponent(channelId)}/members/me`, { muted });
  },

  /**
   * Keyset paginated. `around` loads the page containing a specific message,
   * which is what a search hit or a reply link needs — an offset would put the
   * reader somewhere near it rather than on it.
   */
  listMessages: (target, query = { limit: 25, order: 'desc' }, signal) =>
    http.get(`${targetPath(target)}/messages`, {
      schema: Chat.MessageListSchema,
      query: {
        cursor: query.cursor,
        limit: query.limit,
        order: query.order,
        around: query.around,
      },
      signal,
    }),

  /**
   * The idempotency key is the clientMessageId, not a separate value. One id
   * identifies the message everywhere: in the optimistic bubble, in the retry,
   * and in the socket echo that reconciles them.
   */
  send: (input) =>
    http.post(`${targetPath(input.target)}/messages`, input, {
      schema: Chat.MessageSchema,
      idempotencyKey: input.clientMessageId,
    }),

  edit: (messageId, body) =>
    http.patch(`/messaging/messages/${encodeURIComponent(messageId)}`, { body }, {
      schema: Chat.MessageSchema,
    }),

  remove: async (messageId) => {
    await http.delete(`/messaging/messages/${encodeURIComponent(messageId)}`);
  },

  react: async (messageId, input) => {
    await http.post(`/messaging/messages/${encodeURIComponent(messageId)}/reactions`, input, {
      retry: { attempts: 1 },
    });
  },

  markRead: async (target, messageId) => {
    await http.put(`${targetPath(target)}/read`, { messageId }, { retry: { attempts: 1 } });
  },

  getUnread: (signal) =>
    http.get('/messaging/unread', { schema: Chat.UnreadSummarySchema, signal }),

  /**
   * Checks the plan quota and the per-target limits before a byte is uploaded.
   * The actual transfer is mediaApi's job; this only reserves the intent so a
   * 2 GB upload is rejected in a hundred milliseconds rather than at the end.
   */
  requestAttachment: (input) =>
    http.post('/messaging/attachments', input, { schema: AttachmentTicketSchema }),

  search: (query, signal) =>
    http.get('/messaging/search', {
      schema: Chat.ChatSearchResultSchema,
      query: {
        q: query.q,
        cursor: query.cursor,
        limit: query.limit,
        fromUserId: query.fromUserId,
        hasAttachment: query.hasAttachment,
        before: query.before,
        after: query.after,
        // The union is flattened into one parameter the server re-expands.
        target: query.target ? JSON.stringify(query.target) : undefined,
      },
      signal,
    }),

  reportMessage: async (input) => {
    await http.post('/messaging/reports', input);
  },

  moderateMessage: async (messageId, input) => {
    await http.post(`/messaging/messages/${encodeURIComponent(messageId)}/moderate`, input);
  },

  setSlowMode: (channelId, slowModeSec) =>
    http.patch(
      `/messaging/channels/${encodeURIComponent(channelId)}`,
      { slowModeSec },
      { schema: Chat.ChannelSchema },
    ),
});