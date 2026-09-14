/**
 * Community  (F2)
 *
 *   Space → Thread → Post
 *
 * A space is either bound to a course (auto-provisioned when the course is
 * published) or standalone. Threads are the unit people follow; posts are
 * replies, one level deep. Deeper nesting was left out on purpose — it makes
 * threads unreadable on a phone and it makes the feed query expensive.
 *
 * The distinction from messaging (F6) is worth stating once, because the two
 * are easy to blur: community content is durable, searchable, moderated and
 * addressed to a topic. Chat is addressed to people and optimised for speed.
 * A thread reply is not a chat message, and neither schema borrows the other's
 * shape.
 */

import { z } from 'zod';
import {
  ActorRefSchema,
  IsoDateTimeSchema,
  MemberRoleSchema,
  PaginationQuerySchema,
  SlugSchema,
  TimestampsSchema,
  UserIdSchema,
  VisibilitySchema,
  displayText,
  entityId,
  paginated,
  richText,
} from './common.schema.js';
import { AssetIdSchema, AssetRefSchema } from './media.schema.js';
import { ReportReasonSchema } from './profile.schema.js';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const SpaceIdSchema = entityId('SpaceId');
export const ThreadIdSchema = entityId('ThreadId');
export const PostIdSchema = entityId('PostId');

export type SpaceId = z.infer<typeof SpaceIdSchema>;
export type ThreadId = z.infer<typeof ThreadIdSchema>;
export type PostId = z.infer<typeof PostIdSchema>;

export const POST_MAX_LENGTH = 20_000;

// ---------------------------------------------------------------------------
// Space
// ---------------------------------------------------------------------------

export const SpaceSchema = z
  .object({
    spaceId: SpaceIdSchema,
    slug: SlugSchema,
    name: displayText(80),
    description: richText(2000).nullable().default(null),
    visibility: VisibilitySchema.default('members'),
    /** Set when the space belongs to a course; null for a standalone space. */
    courseId: z.uuid().nullable().default(null),
    coverAssetId: AssetIdSchema.nullable().default(null),
    coverUrl: z.string().url().nullable().default(null),

    memberCount: z.number().int().nonnegative().default(0),
    threadCount: z.number().int().nonnegative().default(0),
    onlineCount: z.number().int().nonnegative().default(0),

    /** Viewer-specific state, so a list renders without a second request. */
    viewerRole: MemberRoleSchema.nullable().default(null),
    joined: z.boolean().default(false),
    muted: z.boolean().default(false),
    unreadCount: z.number().int().nonnegative().default(0),

    /** Only moderators and owners may open a thread. */
    postingRestricted: z.boolean().default(false),
    archived: z.boolean().default(false),
  })
  .merge(TimestampsSchema);
export type Space = z.infer<typeof SpaceSchema>;

export const MembershipSchema = z
  .object({
    spaceId: SpaceIdSchema,
    userId: UserIdSchema,
    profile: ActorRefSchema,
    role: MemberRoleSchema.default('member'),
    joinedAt: IsoDateTimeSchema,
    mutedUntil: IsoDateTimeSchema.nullable().default(null),
    /** Suspended members keep their history but cannot post. */
    suspended: z.boolean().default(false),
  })
  .describe('One person\u2019s membership of one space.');
export type Membership = z.infer<typeof MembershipSchema>;

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export const ReactionSchema = z.object({
  emoji: z.string().min(1).max(8),
  count: z.number().int().positive(),
  reacted: z.boolean().default(false),
});
export type Reaction = z.infer<typeof ReactionSchema>;

// ---------------------------------------------------------------------------
// Threads and posts
// ---------------------------------------------------------------------------

export const THREAD_KINDS = ['discussion', 'question', 'announcement'] as const;
export const ThreadKindSchema = z.enum(THREAD_KINDS);
export type ThreadKind = z.infer<typeof ThreadKindSchema>;

export const AttachmentRefSchema = AssetRefSchema.extend({
  /** Signed and short-lived; present only on a single-item fetch. */
  url: z.string().url().nullable().default(null),
});

export const PostSchema = z
  .object({
    postId: PostIdSchema,
    threadId: ThreadIdSchema,
    author: ActorRefSchema.nullable(),
    body: richText(POST_MAX_LENGTH),
    attachments: z.array(AttachmentRefSchema).max(10).default([]),
    mentions: z.array(UserIdSchema).max(50).default([]),
    reactions: z.array(ReactionSchema).max(20).default([]),
    /** One level of nesting only: a reply to a reply still belongs to the thread. */
    replyToPostId: PostIdSchema.nullable().default(null),
    /** The author of a question may mark one post as the answer. */
    acceptedAnswer: z.boolean().default(false),
    editedAt: IsoDateTimeSchema.nullable().default(null),
    deletedAt: IsoDateTimeSchema.nullable().default(null),
    createdAt: IsoDateTimeSchema,
  })
  .describe('A reply inside a thread.');
export type Post = z.infer<typeof PostSchema>;

export const ThreadSchema = z
  .object({
    threadId: ThreadIdSchema,
    spaceId: SpaceIdSchema,
    kind: ThreadKindSchema.default('discussion'),
    title: displayText(200),
    /** The opening post, always present, stored as the first Post row. */
    body: richText(POST_MAX_LENGTH),
    author: ActorRefSchema.nullable(),
    attachments: z.array(AttachmentRefSchema).max(10).default([]),
    tags: z.array(SlugSchema).max(8).default([]),
    reactions: z.array(ReactionSchema).max(20).default([]),

    postCount: z.number().int().nonnegative().default(0),
    participantCount: z.number().int().nonnegative().default(0),
    lastPostAt: IsoDateTimeSchema.nullable().default(null),
    lastPostBy: ActorRefSchema.nullable().default(null),

    pinned: z.boolean().default(false),
    locked: z.boolean().default(false),
    resolved: z.boolean().default(false),

    /** Viewer state, so the feed can render badges in one pass. */
    unread: z.boolean().default(false),
    following: z.boolean().default(false),

    editedAt: IsoDateTimeSchema.nullable().default(null),
    deletedAt: IsoDateTimeSchema.nullable().default(null),
  })
  .merge(TimestampsSchema);
export type Thread = z.infer<typeof ThreadSchema>;

export const ThreadDetailSchema = ThreadSchema.extend({
  posts: paginated(PostSchema),
});

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

export const FEED_SORTS = ['recent', 'active', 'top', 'unanswered'] as const;
export const FeedSortSchema = z.enum(FEED_SORTS).default('active');

export const FeedQuerySchema = PaginationQuerySchema.extend({
  /** Omitted means the cross-space feed of everything the viewer follows. */
  spaceId: SpaceIdSchema.optional(),
  sort: FeedSortSchema,
  kind: ThreadKindSchema.optional(),
  tag: SlugSchema.optional(),
  authorId: UserIdSchema.optional(),
  following: z.boolean().optional(),
});

export const FeedSchema = paginated(ThreadSchema);
export const SpaceListSchema = paginated(SpaceSchema);
export const MembershipListSchema = paginated(MembershipSchema);
export const PostListSchema = paginated(PostSchema);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NOTIFICATION_TYPES = [
  'thread.reply',
  'thread.mention',
  'post.reaction',
  'answer.accepted',
  'space.invite',
  'lesson.reminder',
  'assignment.graded',
  'chat.message',
  'course.published',
] as const;
export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

export const NotificationSchema = z.object({
  notificationId: z.uuid(),
  type: NotificationTypeSchema,
  actor: ActorRefSchema.nullable(),
  title: displayText(200),
  body: richText(500).nullable().default(null),
  /** In-app route the notification opens, e.g. '/spaces/x/threads/y'. */
  href: z.string().max(512),
  readAt: IsoDateTimeSchema.nullable().default(null),
  createdAt: IsoDateTimeSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationListSchema = paginated(NotificationSchema);
export const NotificationCountSchema = z.object({
  unread: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const CreateSpaceSchema = z.strictObject({
  name: displayText(80),
  slug: SlugSchema.optional(),
  description: richText(2000).optional(),
  visibility: VisibilitySchema.optional(),
  courseId: z.uuid().optional(),
});

export const UpdateSpaceSchema = CreateSpaceSchema.partial()
  .omit({ courseId: true })
  .extend({
    coverAssetId: AssetIdSchema.nullable().optional(),
    postingRestricted: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { error: 'nothing to update' });

export const CreateThreadSchema = z.strictObject({
  spaceId: SpaceIdSchema,
  kind: ThreadKindSchema.default('discussion'),
  title: displayText(200),
  body: richText(POST_MAX_LENGTH).min(1),
  attachmentIds: z.array(AssetIdSchema).max(10).default([]),
  tags: z.array(SlugSchema).max(8).default([]),
  mentions: z.array(UserIdSchema).max(50).default([]),
});

export const UpdateThreadSchema = z
  .strictObject({
    title: displayText(200).optional(),
    body: richText(POST_MAX_LENGTH).optional(),
    tags: z.array(SlugSchema).max(8).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { error: 'nothing to update' });

export const CreatePostSchema = z.strictObject({
  body: richText(POST_MAX_LENGTH).min(1),
  attachmentIds: z.array(AssetIdSchema).max(10).default([]),
  replyToPostId: PostIdSchema.optional(),
  mentions: z.array(UserIdSchema).max(50).default([]),
});

export const ReactSchema = z.strictObject({
  emoji: z.string().min(1).max(8),
  action: z.enum(['add', 'remove']).default('add'),
});

/** Moderator actions on a thread. One route, one audit entry per call. */
export const ModerateThreadSchema = z.strictObject({
  action: z.enum(['pin', 'unpin', 'lock', 'unlock', 'delete', 'restore', 'move']),
  /** Required for 'move'. */
  targetSpaceId: SpaceIdSchema.optional(),
  reason: richText(500).optional(),
});

export const ReportContentSchema = z.strictObject({
  targetType: z.enum(['thread', 'post']),
  targetId: z.uuid(),
  reason: ReportReasonSchema,
  detail: richText(2000).optional(),
});

export const UpdateMembershipSchema = z.strictObject({
  role: MemberRoleSchema.optional(),
  mutedUntil: IsoDateTimeSchema.nullable().optional(),
  suspended: z.boolean().optional(),
});

export const CommunitySearchQuerySchema = PaginationQuerySchema.extend({
  q: z.string().trim().min(2).max(256),
  spaceId: SpaceIdSchema.optional(),
  kind: ThreadKindSchema.optional(),
});

export const CommunitySearchHitSchema = z.object({
  thread: ThreadSchema,
  highlight: z.string().max(1000),
});
export const CommunitySearchResultSchema = paginated(CommunitySearchHitSchema);

// ---------------------------------------------------------------------------
// Inferred request and response types
// ---------------------------------------------------------------------------

export type FeedSort = z.infer<typeof FeedSortSchema>;
export type FeedQuery = z.infer<typeof FeedQuerySchema>;
export type ThreadDetail = z.infer<typeof ThreadDetailSchema>;
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;
export type CreateSpace = z.infer<typeof CreateSpaceSchema>;
export type UpdateSpace = z.infer<typeof UpdateSpaceSchema>;
export type CreateThread = z.infer<typeof CreateThreadSchema>;
export type UpdateThread = z.infer<typeof UpdateThreadSchema>;
export type CreatePost = z.infer<typeof CreatePostSchema>;
export type ReactInput = z.infer<typeof ReactSchema>;
export type ModerateThread = z.infer<typeof ModerateThreadSchema>;
export type ReportContent = z.infer<typeof ReportContentSchema>;
export type UpdateMembership = z.infer<typeof UpdateMembershipSchema>;
export type CommunitySearchQuery = z.infer<typeof CommunitySearchQuerySchema>;
export type CommunitySearchHit = z.infer<typeof CommunitySearchHitSchema>;