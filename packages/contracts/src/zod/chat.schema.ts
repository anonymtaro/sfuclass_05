/**
 * Messaging  (F6)
 *
 * One message table serves three surfaces, distinguished only by what the
 * message is addressed to:
 *
 *   direct       a Conversation, which is a participant set. A 1:1 chat and a
 *                small group chat are the same object with a different size.
 *   channel      a Channel, which is a scope: the tenant-wide public lobby, a
 *                space channel or a course channel. Everyone in scope reads and
 *                writes; history is visible from before they joined.
 *   room         the live chat panel of a classroom, persisted so a lesson can
 *                be read back afterwards.
 *
 * Delivery is at-least-once. Every send carries a client-generated
 * `clientMessageId`; the server treats a repeat as an update to the original
 * row, which is what makes the offline outbox safe to replay after a reconnect.
 *
 * Attachments are ordinary media assets. They inherit the quota check, the
 * quarantine scan and signed delivery from media/ rather than getting a second,
 * weaker upload path.
 */

import { z } from 'zod';
import {
  ActorRefSchema,
  CursorSchema,
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  MemberRoleSchema,
  PaginationQuerySchema,
  TimestampsSchema,
  UserIdSchema,
  displayText,
  entityId,
  paginated,
  richText,
} from './common.schema.ts';
import { AssetIdSchema, AssetSchema } from './media.schema.ts';
import { ReportReasonSchema } from './profile.schema.ts';

// ---------------------------------------------------------------------------
// Limits — must match the CHAT_* variables in .env.example. config/env.js
// validates the runtime values against these constants at boot.
// ---------------------------------------------------------------------------

export const CHAT_MESSAGE_MAX_LENGTH = 4000;
export const CHAT_ATTACHMENTS_PER_MESSAGE = 10;
export const CHAT_GROUP_MAX_PARTICIPANTS = 50;
export const CHAT_EDIT_WINDOW_MINUTES = 15;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const ChannelIdSchema = entityId('ChannelId');
export const ConversationIdSchema = entityId('ConversationId');
export const MessageIdSchema = entityId('MessageId');

export type ChannelId = z.infer<typeof ChannelIdSchema>;
export type ConversationId = z.infer<typeof ConversationIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;

/**
 * Where a message lives. One discriminated union instead of three nullable
 * foreign keys, so an invalid combination cannot be represented.
 */
export const ChatTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation'), conversationId: ConversationIdSchema }),
  z.object({ kind: z.literal('channel'), channelId: ChannelIdSchema }),
  z.object({ kind: z.literal('room'), roomId: z.uuid() }),
]);
export type ChatTarget = z.infer<typeof ChatTargetSchema>;

// ---------------------------------------------------------------------------
// Channels — the public side
// ---------------------------------------------------------------------------

export const CHANNEL_SCOPES = ['public', 'space', 'course'] as const;
export const ChannelScopeSchema = z.enum(CHANNEL_SCOPES);
export type ChannelScope = z.infer<typeof ChannelScopeSchema>;

export const ChannelSchema = z
  .object({
    channelId: ChannelIdSchema,
    scope: ChannelScopeSchema,
    /** Null for the tenant-wide lobby; a Space or Course id otherwise. */
    scopeRefId: z.uuid().nullable().default(null),
    name: displayText(60),
    topic: richText(280).nullable().default(null),
    /** Read-only channels: announcements a moderator posts to. */
    readOnly: z.boolean().default(false),
    /** Seconds between posts per member. 0 disables slow mode. */
    slowModeSec: z.number().int().min(0).max(21_600).default(0),
    memberCount: z.number().int().nonnegative(),
    /** Viewer-specific, so the list can render badges without a second call. */
    unreadCount: z.number().int().nonnegative().default(0),
    lastMessageAt: IsoDateTimeSchema.nullable().default(null),
    muted: z.boolean().default(false),
  })
  .merge(TimestampsSchema);
export type Channel = z.infer<typeof ChannelSchema>;

// ---------------------------------------------------------------------------
// Conversations — the private side
// ---------------------------------------------------------------------------

export const ParticipantSchema = z.object({
  userId: UserIdSchema,
  profile: ActorRefSchema,
  role: MemberRoleSchema.default('member'),
  joinedAt: IsoDateTimeSchema,
  /** Drives the unread counter and the read receipt sent to other members. */
  lastReadAt: IsoDateTimeSchema.nullable().default(null),
  muted: z.boolean().default(false),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const ConversationSchema = z
  .object({
    conversationId: ConversationIdSchema,
    /** 'direct' has exactly two participants and no title. */
    kind: z.enum(['direct', 'group']),
    title: displayText(80).nullable().default(null),
    participants: z.array(ParticipantSchema).min(2).max(CHAT_GROUP_MAX_PARTICIPANTS),
    createdBy: UserIdSchema,
    lastMessage: z.lazy(() => MessageSchema).nullable().default(null),
    lastMessageAt: IsoDateTimeSchema.nullable().default(null),
    unreadCount: z.number().int().nonnegative().default(0),
    muted: z.boolean().default(false),
    archived: z.boolean().default(false),
  })
  .merge(TimestampsSchema);
export type Conversation = z.infer<typeof ConversationSchema>;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * A resolved mention. Stored alongside the body so the rendered text does not
 * have to be re-parsed, and so a renamed user still resolves correctly.
 */
export const MentionSchema = z.object({
  userId: UserIdSchema,
  /** Character offsets into `body`. */
  start: z.number().int().nonnegative(),
  length: z.number().int().positive(),
});

export const MessageAttachmentSchema = z.object({
  assetId: AssetIdSchema,
  /** Denormalised so a message renders without a second round trip. */
  fileName: displayText(255),
  contentType: z.string().max(128),
  sizeBytes: z.number().int().nonnegative(),
  /** Populated once the asset is ready; null while it scans or transcodes. */
  downloadUrl: z.string().url().nullable().default(null),
  previewUrl: z.string().url().nullable().default(null),
  status: AssetSchema.shape.status,
});
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

export const MESSAGE_KINDS = ['text', 'system', 'call'] as const;
export const MessageKindSchema = z.enum(MESSAGE_KINDS);

export const ReactionSummarySchema = z.object({
  /** A single unicode emoji. Custom emoji are deliberately out of scope. */
  emoji: z.string().min(1).max(8),
  count: z.number().int().positive(),
  /** Whether the viewer is one of them, so the chip renders active. */
  reacted: z.boolean().default(false),
});

export const MessageSchema = z
  .object({
    messageId: MessageIdSchema,
    target: ChatTargetSchema,
    kind: MessageKindSchema.default('text'),
    author: ActorRefSchema.nullable(), // null for system messages
    body: richText(CHAT_MESSAGE_MAX_LENGTH),
    mentions: z.array(MentionSchema).max(50).default([]),
    attachments: z.array(MessageAttachmentSchema).max(CHAT_ATTACHMENTS_PER_MESSAGE).default([]),
    replyToId: MessageIdSchema.nullable().default(null),
    reactions: z.array(ReactionSummarySchema).max(20).default([]),

    /** Echoed back so an optimistic bubble can be reconciled, not duplicated. */
    clientMessageId: IdempotencyKeySchema.nullable().default(null),

    editedAt: IsoDateTimeSchema.nullable().default(null),
    /**
     * Soft deletion. The row survives for the audit trail; body and attachments
     * are cleared and clients render a tombstone.
     */
    deletedAt: IsoDateTimeSchema.nullable().default(null),
    deletedBy: z.enum(['author', 'moderator']).nullable().default(null),

    createdAt: IsoDateTimeSchema,
  })
  .describe('One message, in a conversation, a channel or a live room.');
export type Message = z.infer<typeof MessageSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * The Message action on a profile card. Idempotent by design: it returns the
 * existing conversation or creates one, so there is no separate "new message"
 * flow that could drift out of sync.
 */
export const OpenDirectConversationSchema = z.strictObject({
  userId: UserIdSchema,
});

export const CreateGroupConversationSchema = z.strictObject({
  participantIds: z.array(UserIdSchema).min(2).max(CHAT_GROUP_MAX_PARTICIPANTS - 1),
  title: displayText(80).optional(),
});

export const SendMessageSchema = z
  .strictObject({
    target: ChatTargetSchema,
    body: richText(CHAT_MESSAGE_MAX_LENGTH).default(''),
    /** Assets must already be `ready`; the server rejects anything else. */
    attachmentIds: z.array(AssetIdSchema).max(CHAT_ATTACHMENTS_PER_MESSAGE).default([]),
    replyToId: MessageIdSchema.optional(),
    mentions: z.array(MentionSchema).max(50).default([]),
    clientMessageId: IdempotencyKeySchema,
  })
  .refine((v) => v.body.trim().length > 0 || v.attachmentIds.length > 0, {
    error: 'a message needs text or at least one attachment',
    path: ['body'],
  });
export type SendMessage = z.infer<typeof SendMessageSchema>;

export const EditMessageSchema = z.strictObject({
  body: richText(CHAT_MESSAGE_MAX_LENGTH).min(1),
});

export const ReactToMessageSchema = z.strictObject({
  emoji: z.string().min(1).max(8),
  /** Absent means toggle; explicit values make a retry idempotent. */
  action: z.enum(['add', 'remove']).default('add'),
});

/**
 * History. Keyset paginated on (createdAt, messageId), which is why the id is a
 * UUIDv7 — the sort key is already in the identifier.
 */
export const ListMessagesQuerySchema = PaginationQuerySchema.extend({
  /** Loads the page around a message, for jumping to a search hit or a reply. */
  around: CursorSchema.optional(),
});

export const MessageListSchema = paginated(MessageSchema);
export const ConversationListSchema = paginated(ConversationSchema);
export const ChannelListSchema = paginated(ChannelSchema);

export const MarkReadSchema = z.strictObject({
  /** Everything up to and including this message counts as read. */
  messageId: MessageIdSchema,
});

export const UnreadSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  conversations: z.number().int().nonnegative(),
  channels: z.number().int().nonnegative(),
  mentions: z.number().int().nonnegative(),
});
export type UnreadSummary = z.infer<typeof UnreadSummarySchema>;

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Upload flow, for reference:
 *   1. POST /media/uploads          presign, quota checked first
 *   2. client PUTs the parts to S3  never through the API
 *   3. POST /media/uploads/:id/complete
 *   4. asset becomes `ready` after the quarantine scan
 *   5. sendMessage with the assetId
 *
 * This request only announces intent, so the composer can show a progress row
 * before the upload starts and so the quota is checked before a 2 GB transfer.
 */
export const RequestChatAttachmentSchema = z.strictObject({
  target: ChatTargetSchema,
  fileName: displayText(255),
  contentType: z.string().max(128),
  sizeBytes: z.number().int().positive(),
});

export const ChatSearchQuerySchema = PaginationQuerySchema.extend({
  q: z.string().trim().min(2).max(256),
  /** Restricts the search to one conversation or channel. */
  target: ChatTargetSchema.optional(),
  fromUserId: UserIdSchema.optional(),
  hasAttachment: z.boolean().optional(),
  before: IsoDateTimeSchema.optional(),
  after: IsoDateTimeSchema.optional(),
});

export const ChatSearchHitSchema = z.object({
  message: MessageSchema,
  /** Server-highlighted excerpt; already escaped, marked with <em>. */
  highlight: z.string().max(1000),
});
export const ChatSearchResultSchema = paginated(ChatSearchHitSchema);

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

export const ReportMessageSchema = z.strictObject({
  messageId: MessageIdSchema,
  reason: ReportReasonSchema,
  detail: richText(2000).optional(),
});

export const ModerateMessageSchema = z.strictObject({
  action: z.enum(['delete', 'restore']),
  reason: richText(500).optional(),
});

export const SetSlowModeSchema = z.strictObject({
  slowModeSec: z.number().int().min(0).max(21_600),
});

export const MuteTargetSchema = z.strictObject({
  /** Null mutes indefinitely. */
  until: IsoDateTimeSchema.nullable().default(null),
});

// ---------------------------------------------------------------------------
// Inferred request types
// ---------------------------------------------------------------------------

export type OpenDirectConversation = z.infer<typeof OpenDirectConversationSchema>;
export type CreateGroupConversation = z.infer<typeof CreateGroupConversationSchema>;
export type EditMessage = z.infer<typeof EditMessageSchema>;
export type ReactToMessage = z.infer<typeof ReactToMessageSchema>;
export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;
export type RequestChatAttachment = z.infer<typeof RequestChatAttachmentSchema>;
export type ChatSearchQuery = z.infer<typeof ChatSearchQuerySchema>;
export type ReportMessage = z.infer<typeof ReportMessageSchema>;
export type ModerateMessage = z.infer<typeof ModerateMessageSchema>;
export type ReactionSummary = z.infer<typeof ReactionSummarySchema>;
export type Mention = z.infer<typeof MentionSchema>;