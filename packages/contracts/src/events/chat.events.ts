/**
 * Chat transport  (F6)
 *
 * Namespace: `/chat`
 *
 * The socket is the fast path, not the only path. Every mutation here has an
 * HTTP twin, and the socket send is an optimisation for a connection that is
 * already open. That symmetry is what lets the mobile app fall back to HTTP on
 * a bad network without a second code path.
 *
 * Delivery guarantees:
 *   - client → server is at-least-once, deduplicated by `clientMessageId`
 *   - server → client is best-effort; a client that missed events while
 *     disconnected calls `chat:sync` with its last known cursor rather than
 *     replaying a queue
 *   - typing is fire-and-forget and never persisted
 *
 * Fan-out crosses API tasks through the Redis adapter, so a sender on task A
 * reaches a recipient on task B without either knowing the other exists.
 */

import { z } from 'zod';
import {
  CursorSchema,
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  UserIdSchema,
} from '../zod/common.schema.js';
import {
  ChatTargetSchema,
  ChannelSchema,
  ConversationSchema,
  MessageIdSchema,
  MessageSchema,
  SendMessageSchema,
  UnreadSummarySchema,
} from '../zod/chat.schema.js';
import { PresenceStateSchema } from '../zod/profile.schema.js';

export const CHAT_NAMESPACE = '/chat' as const;

/** Typing state expires on its own; clients need not send a stop event. */
export const TYPING_TTL_MS = 5_000;

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/**
 * Subscribing is explicit. A client receives events only for the targets it has
 * joined, which keeps a member of two hundred channels from paying for all of
 * them on every keystroke somebody makes.
 */
export const SubscribeSchema = z.object({
  targets: z.array(ChatTargetSchema).min(1).max(100),
});

export const UnsubscribeSchema = z.object({
  targets: z.array(ChatTargetSchema).min(1).max(100),
});

/** Same payload as the HTTP route, deliberately. */
export const SocketSendMessageSchema = SendMessageSchema;

export const TypingSchema = z.object({
  target: ChatTargetSchema,
  /** False is optional; the TTL handles a client that simply stops sending. */
  typing: z.boolean().default(true),
});

export const SocketMarkReadSchema = z.object({
  target: ChatTargetSchema,
  messageId: MessageIdSchema,
});

/**
 * Catch-up after a reconnect. The server replays what changed since the cursor
 * rather than the client re-fetching every open thread.
 */
export const SyncSchema = z.object({
  targets: z
    .array(
      z.object({
        target: ChatTargetSchema,
        since: CursorSchema.nullable().default(null),
      }),
    )
    .max(100),
});

export const SyncResultSchema = z.object({
  messages: z.array(MessageSchema).max(500),
  /** True when too much changed to replay; the client should refetch instead. */
  truncated: z.boolean().default(false),
  unread: UnreadSummarySchema,
});

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export const MessageNewSchema = z.object({
  message: MessageSchema,
  /** Echoed so an optimistic bubble is reconciled rather than duplicated. */
  clientMessageId: IdempotencyKeySchema.nullable().default(null),
});

export const MessageUpdatedSchema = z.object({
  message: MessageSchema,
});

export const MessageDeletedSchema = z.object({
  target: ChatTargetSchema,
  messageId: MessageIdSchema,
  deletedBy: z.enum(['author', 'moderator']),
  deletedAt: IsoDateTimeSchema,
});

export const ReactionChangedSchema = z.object({
  target: ChatTargetSchema,
  messageId: MessageIdSchema,
  emoji: z.string().min(1).max(8),
  userId: UserIdSchema,
  action: z.enum(['add', 'remove']),
  count: z.number().int().nonnegative(),
});

export const TypingChangedSchema = z.object({
  target: ChatTargetSchema,
  userId: UserIdSchema,
  typing: z.boolean(),
  expiresAt: IsoDateTimeSchema,
});

export const ReadChangedSchema = z.object({
  target: ChatTargetSchema,
  userId: UserIdSchema,
  /** Everything up to here has been read by that person. */
  lastReadMessageId: MessageIdSchema,
  readAt: IsoDateTimeSchema,
});

export const UnreadChangedSchema = z.object({
  summary: UnreadSummarySchema,
  /** Per-target deltas, so a badge updates without a full recount. */
  targets: z
    .array(
      z.object({
        target: ChatTargetSchema,
        unreadCount: z.number().int().nonnegative(),
        mentioned: z.boolean().default(false),
      }),
    )
    .max(100),
});

/** A DM opened from a profile appears in the recipient's list immediately. */
export const ConversationCreatedSchema = z.object({
  conversation: ConversationSchema,
});

export const ConversationUpdatedSchema = z.object({
  conversation: ConversationSchema,
});

export const ChannelUpdatedSchema = z.object({
  channel: ChannelSchema,
});

export const PresenceChangedSchema = z.object({
  userId: UserIdSchema,
  state: PresenceStateSchema,
  roomId: z.uuid().nullable().default(null),
});

/**
 * An attachment finished scanning and transcoding. The bubble is already on
 * screen with a spinner; this fills in the download and preview URLs.
 */
export const AttachmentReadySchema = z.object({
  target: ChatTargetSchema,
  messageId: MessageIdSchema,
  assetId: z.uuid(),
  status: z.enum(['ready', 'failed', 'infected']),
  downloadUrl: z.string().url().nullable().default(null),
  previewUrl: z.string().url().nullable().default(null),
});

/**
 * Slow mode, a mute or a rate limit. Carried as an event rather than only as an
 * error, because it can start applying while the composer is already open.
 */
export const ThrottledSchema = z.object({
  target: ChatTargetSchema,
  reason: z.enum(['slow_mode_active', 'rate_limited', 'muted']),
  retryAfterSec: z.number().int().nonnegative(),
  until: IsoDateTimeSchema.nullable().default(null),
});

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

export const CHAT_CLIENT_EVENTS = {
  subscribe: 'chat:subscribe',
  unsubscribe: 'chat:unsubscribe',
  send: 'chat:message.send',
  edit: 'chat:message.edit',
  delete: 'chat:message.delete',
  react: 'chat:message.react',
  typing: 'chat:typing',
  markRead: 'chat:read',
  sync: 'chat:sync',
} as const;

export const CHAT_SERVER_EVENTS = {
  messageNew: 'chat:message.new',
  messageUpdated: 'chat:message.updated',
  messageDeleted: 'chat:message.deleted',
  reactionChanged: 'chat:message.reaction',
  typingChanged: 'chat:typing.changed',
  readChanged: 'chat:read.changed',
  unreadChanged: 'chat:unread.changed',
  conversationCreated: 'chat:conversation.created',
  conversationUpdated: 'chat:conversation.updated',
  channelUpdated: 'chat:channel.updated',
  presenceChanged: 'chat:presence.changed',
  attachmentReady: 'chat:attachment.ready',
  throttled: 'chat:throttled',
} as const;

export type ChatClientEvent = (typeof CHAT_CLIENT_EVENTS)[keyof typeof CHAT_CLIENT_EVENTS];
export type ChatServerEvent = (typeof CHAT_SERVER_EVENTS)[keyof typeof CHAT_SERVER_EVENTS];

// ---------------------------------------------------------------------------
// Payload maps
// ---------------------------------------------------------------------------

export type ChatClientPayloads = {
  [CHAT_CLIENT_EVENTS.subscribe]: z.infer<typeof SubscribeSchema>;
  [CHAT_CLIENT_EVENTS.unsubscribe]: z.infer<typeof UnsubscribeSchema>;
  [CHAT_CLIENT_EVENTS.send]: z.infer<typeof SocketSendMessageSchema>;
  [CHAT_CLIENT_EVENTS.edit]: { messageId: string; body: string };
  [CHAT_CLIENT_EVENTS.delete]: { messageId: string };
  [CHAT_CLIENT_EVENTS.react]: { messageId: string; emoji: string; action: 'add' | 'remove' };
  [CHAT_CLIENT_EVENTS.typing]: z.infer<typeof TypingSchema>;
  [CHAT_CLIENT_EVENTS.markRead]: z.infer<typeof SocketMarkReadSchema>;
  [CHAT_CLIENT_EVENTS.sync]: z.infer<typeof SyncSchema>;
};

export type ChatServerPayloads = {
  [CHAT_SERVER_EVENTS.messageNew]: z.infer<typeof MessageNewSchema>;
  [CHAT_SERVER_EVENTS.messageUpdated]: z.infer<typeof MessageUpdatedSchema>;
  [CHAT_SERVER_EVENTS.messageDeleted]: z.infer<typeof MessageDeletedSchema>;
  [CHAT_SERVER_EVENTS.reactionChanged]: z.infer<typeof ReactionChangedSchema>;
  [CHAT_SERVER_EVENTS.typingChanged]: z.infer<typeof TypingChangedSchema>;
  [CHAT_SERVER_EVENTS.readChanged]: z.infer<typeof ReadChangedSchema>;
  [CHAT_SERVER_EVENTS.unreadChanged]: z.infer<typeof UnreadChangedSchema>;
  [CHAT_SERVER_EVENTS.conversationCreated]: z.infer<typeof ConversationCreatedSchema>;
  [CHAT_SERVER_EVENTS.conversationUpdated]: z.infer<typeof ConversationUpdatedSchema>;
  [CHAT_SERVER_EVENTS.channelUpdated]: z.infer<typeof ChannelUpdatedSchema>;
  [CHAT_SERVER_EVENTS.presenceChanged]: z.infer<typeof PresenceChangedSchema>;
  [CHAT_SERVER_EVENTS.attachmentReady]: z.infer<typeof AttachmentReadySchema>;
  [CHAT_SERVER_EVENTS.throttled]: z.infer<typeof ThrottledSchema>;
};