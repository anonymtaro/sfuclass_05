/**
 * Community transport  (F2)
 *
 * Namespace: `/community`
 *
 * Community traffic is far quieter than chat and its expectations are
 * different: a thread reply may arrive a second late without anyone noticing,
 * but it must never be lost, because it is durable content. So the socket here
 * carries notifications about changes rather than the changes themselves — the
 * payloads are thin, and the client refetches through HTTP when it needs the
 * full object.
 *
 * Presence is shared with chat and the classroom. It is published once, on this
 * namespace, and every surface reads the same Redis source.
 */

import { z } from 'zod';
import { ActorRefSchema, IsoDateTimeSchema, UserIdSchema } from '../zod/common.schema.js';
import {
  NotificationSchema,
  PostIdSchema,
  SpaceIdSchema,
  ThreadIdSchema,
} from '../zod/community.schema.js';
import { PresenceStateSchema } from '../zod/profile.schema.js';

export const COMMUNITY_NAMESPACE = '/community' as const;

/** A presence entry that stops being refreshed expires by itself. */
export const PRESENCE_HEARTBEAT_MS = 30_000;

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/** Subscribe to a space's live updates while its page is open. */
export const WatchSpaceSchema = z.object({
  spaceIds: z.array(SpaceIdSchema).min(1).max(50),
});

export const UnwatchSpaceSchema = z.object({
  spaceIds: z.array(SpaceIdSchema).min(1).max(50),
});

/** Open thread pages get finer-grained events than the space feed. */
export const WatchThreadSchema = z.object({
  threadId: ThreadIdSchema,
});

/**
 * Presence heartbeat. Explicit rather than inferred from the connection,
 * because a socket may stay open in a background tab for hours.
 */
export const HeartbeatSchema = z.object({
  state: PresenceStateSchema.default('online'),
  /** Set while the user is in a live lesson, so others can jump to it. */
  roomId: z.uuid().nullable().default(null),
});

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

/**
 * Thin by design: the id and enough context to update a list in place. A client
 * showing the thread refetches the post; a client showing the feed just bumps
 * the counter.
 */
export const PostCreatedSchema = z.object({
  spaceId: SpaceIdSchema,
  threadId: ThreadIdSchema,
  postId: PostIdSchema,
  author: ActorRefSchema,
  /** First line, for a toast. Never the full body. */
  excerpt: z.string().max(280),
  /** So a viewer knows whether this concerns them directly. */
  mentionsViewer: z.boolean().default(false),
  postCount: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
});

export const ThreadCreatedSchema = z.object({
  spaceId: SpaceIdSchema,
  threadId: ThreadIdSchema,
  title: z.string().max(200),
  author: ActorRefSchema,
  createdAt: IsoDateTimeSchema,
});

export const ThreadUpdatedSchema = z.object({
  spaceId: SpaceIdSchema,
  threadId: ThreadIdSchema,
  /** What changed, so the client knows whether a refetch is worth it. */
  change: z.enum(['edited', 'pinned', 'unpinned', 'locked', 'unlocked', 'resolved', 'moved']),
  actor: ActorRefSchema.nullable().default(null),
});

export const ContentRemovedSchema = z.object({
  spaceId: SpaceIdSchema,
  targetType: z.enum(['thread', 'post']),
  targetId: z.uuid(),
  removedBy: z.enum(['author', 'moderator']),
  removedAt: IsoDateTimeSchema,
});

export const ReactionChangedSchema = z.object({
  targetType: z.enum(['thread', 'post']),
  targetId: z.uuid(),
  emoji: z.string().min(1).max(8),
  userId: UserIdSchema,
  action: z.enum(['add', 'remove']),
  count: z.number().int().nonnegative(),
});

export const PresenceChangedSchema = z.object({
  spaceId: SpaceIdSchema.nullable().default(null),
  userId: UserIdSchema,
  state: PresenceStateSchema,
  roomId: z.uuid().nullable().default(null),
});

/** Periodic roll-up, so a member list is correct without per-user events. */
export const PresenceSnapshotSchema = z.object({
  spaceId: SpaceIdSchema,
  onlineCount: z.number().int().nonnegative(),
  /** Capped; the full list comes from HTTP when someone opens the panel. */
  sample: z.array(ActorRefSchema).max(20).default([]),
});

/**
 * A notification for this user, delivered live. The same object the bell
 * dropdown renders and the push worker would have sent had the user been away.
 */
export const NotificationReceivedSchema = z.object({
  notification: NotificationSchema,
  unread: z.number().int().nonnegative(),
});

export const MembershipChangedSchema = z.object({
  spaceId: SpaceIdSchema,
  userId: UserIdSchema,
  change: z.enum(['joined', 'left', 'role-changed', 'suspended', 'reinstated']),
  role: z.enum(['owner', 'moderator', 'member']).nullable().default(null),
});

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

export const COMMUNITY_CLIENT_EVENTS = {
  watchSpaces: 'community:space.watch',
  unwatchSpaces: 'community:space.unwatch',
  watchThread: 'community:thread.watch',
  unwatchThread: 'community:thread.unwatch',
  heartbeat: 'community:presence.heartbeat',
} as const;

export const COMMUNITY_SERVER_EVENTS = {
  postCreated: 'community:post.created',
  threadCreated: 'community:thread.created',
  threadUpdated: 'community:thread.updated',
  contentRemoved: 'community:content.removed',
  reactionChanged: 'community:reaction.changed',
  presenceChanged: 'community:presence.changed',
  presenceSnapshot: 'community:presence.snapshot',
  notification: 'community:notification',
  membershipChanged: 'community:membership.changed',
} as const;

export type CommunityClientEvent =
  (typeof COMMUNITY_CLIENT_EVENTS)[keyof typeof COMMUNITY_CLIENT_EVENTS];
export type CommunityServerEvent =
  (typeof COMMUNITY_SERVER_EVENTS)[keyof typeof COMMUNITY_SERVER_EVENTS];

// ---------------------------------------------------------------------------
// Payload maps
// ---------------------------------------------------------------------------

export type CommunityClientPayloads = {
  [COMMUNITY_CLIENT_EVENTS.watchSpaces]: z.infer<typeof WatchSpaceSchema>;
  [COMMUNITY_CLIENT_EVENTS.unwatchSpaces]: z.infer<typeof UnwatchSpaceSchema>;
  [COMMUNITY_CLIENT_EVENTS.watchThread]: z.infer<typeof WatchThreadSchema>;
  [COMMUNITY_CLIENT_EVENTS.unwatchThread]: z.infer<typeof WatchThreadSchema>;
  [COMMUNITY_CLIENT_EVENTS.heartbeat]: z.infer<typeof HeartbeatSchema>;
};

export type CommunityServerPayloads = {
  [COMMUNITY_SERVER_EVENTS.postCreated]: z.infer<typeof PostCreatedSchema>;
  [COMMUNITY_SERVER_EVENTS.threadCreated]: z.infer<typeof ThreadCreatedSchema>;
  [COMMUNITY_SERVER_EVENTS.threadUpdated]: z.infer<typeof ThreadUpdatedSchema>;
  [COMMUNITY_SERVER_EVENTS.contentRemoved]: z.infer<typeof ContentRemovedSchema>;
  [COMMUNITY_SERVER_EVENTS.reactionChanged]: z.infer<typeof ReactionChangedSchema>;
  [COMMUNITY_SERVER_EVENTS.presenceChanged]: z.infer<typeof PresenceChangedSchema>;
  [COMMUNITY_SERVER_EVENTS.presenceSnapshot]: z.infer<typeof PresenceSnapshotSchema>;
  [COMMUNITY_SERVER_EVENTS.notification]: z.infer<typeof NotificationReceivedSchema>;
  [COMMUNITY_SERVER_EVENTS.membershipChanged]: z.infer<typeof MembershipChangedSchema>;
};