/**
 * Profiles, privacy and blocking  (F6)
 *
 * The profile is the anchor for direct messages. Clicking a person anywhere in
 * the product — participant list, community thread, public channel, course
 * roster — resolves to a PublicProfile, and the Message action on that card is
 * the only entry point into a conversation.
 *
 * Two shapes, deliberately different:
 *
 *   PublicProfile   what anyone in the tenant may see. Contains no email, no
 *                   device information and no privacy settings. This is the
 *                   only profile shape a socket event ever carries.
 *   OwnProfile      what the signed-in user sees about themselves. Adds email,
 *                   locale, timezone and the privacy block.
 *
 * `canMessage` on the public shape is computed by the server from the target's
 * DM policy, the block lists in both directions and whether the two share a
 * course or space. Clients render the button from it; they never derive it
 * themselves, because only the server can see both block lists.
 */

import { z } from 'zod';
import {
  ActorRefSchema,
  EmailSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  PlatformRoleSchema,
  TimeZoneSchema,
  TimestampsSchema,
  UrlSchema,
  UserIdSchema,
  displayText,
  entityId,
  paginated,
  richText,
} from './common.schema.ts';

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * Who may open a direct message with this person.
 *   anyone          any member of the tenant
 *   shared-context  only people who share a course or a space  (default)
 *   nobody          no one; existing conversations stay readable
 *
 * Mirrors CHAT_DEFAULT_DM_POLICY in .env.example.
 */
export const DM_POLICIES = ['anyone', 'shared-context', 'nobody'] as const;
export const DmPolicySchema = z.enum(DM_POLICIES);
export type DmPolicy = z.infer<typeof DmPolicySchema>;

/** Coarse presence, shared by community, chat and classroom. */
export const PRESENCE_STATES = ['online', 'away', 'in-class', 'offline'] as const;
export const PresenceStateSchema = z.enum(PRESENCE_STATES);
export type PresenceState = z.infer<typeof PresenceStateSchema>;

export const PROFILE_FIELD_VISIBILITY = ['everyone', 'members', 'nobody'] as const;
export const ProfileFieldVisibilitySchema = z.enum(PROFILE_FIELD_VISIBILITY);

export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate_speech',
  'sexual_content',
  'violence',
  'self_harm',
  'impersonation',
  'copyright',
  'other',
] as const;
export const ReportReasonSchema = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof ReportReasonSchema>;

export const ReportIdSchema = entityId('ReportId');
export type ReportId = z.infer<typeof ReportIdSchema>;

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const ProfileLinkSchema = z.object({
  label: displayText(40),
  url: UrlSchema,
});

export const PublicProfileSchema = z
  .object({
    userId: UserIdSchema,
    displayName: displayText(80),
    /** Stable, lowercase, unique per tenant. Used for @mentions. */
    handle: z
      .string()
      .min(3)
      .max(32)
      .regex(/^[a-z0-9_]+$/, { error: 'lowercase letters, digits and underscores' }),
    avatarUrl: UrlSchema.nullable().default(null),
    headline: displayText(120).nullable().default(null),
    bio: richText(2000).nullable().default(null),
    links: z.array(ProfileLinkSchema).max(5).default([]),
    role: PlatformRoleSchema,

    presence: PresenceStateSchema.default('offline'),
    lastSeenAt: IsoDateTimeSchema.nullable().default(null),

    /**
     * Server-computed. False when the viewer is blocked, when the target's DM
     * policy forbids it, or when the two share no course or space.
     */
    canMessage: z.boolean(),
    /** Set when the viewer has blocked this person, so the UI can say so. */
    isBlockedByViewer: z.boolean().default(false),
    /** Fed by the shared context check; useful context on the profile card. */
    sharedSpaceCount: z.number().int().nonnegative().default(0),

    joinedAt: IsoDateTimeSchema,
  })
  .describe('What any member of the tenant may see about another member.');

export type PublicProfile = z.infer<typeof PublicProfileSchema>;

export const PrivacySettingsSchema = z.object({
  dmPolicy: DmPolicySchema.default('shared-context'),
  /** Off means presence reports 'offline' to everyone but never lies upward. */
  showPresence: z.boolean().default(true),
  showEmail: ProfileFieldVisibilitySchema.default('nobody'),
  showCourses: ProfileFieldVisibilitySchema.default('members'),
  /** Read receipts are mutual: switching this off also hides other people's. */
  sendReadReceipts: z.boolean().default(true),
  /** Suppresses the online marker in community and classroom lists. */
  discoverable: z.boolean().default(true),
});
export type PrivacySettings = z.infer<typeof PrivacySettingsSchema>;

export const NotificationSettingsSchema = z.object({
  dmPush: z.boolean().default(true),
  dmEmail: z.boolean().default(false),
  mentionPush: z.boolean().default(true),
  communityDigest: z.boolean().default(true),
  lessonReminders: z.boolean().default(true),
  /** Local clock, inclusive start and exclusive end, e.g. 22:00 → 07:00. */
  quietHours: z
    .object({
      start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    })
    .nullable()
    .default(null),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

/** The signed-in user's own view. Never sent to anyone else. */
export const OwnProfileSchema = PublicProfileSchema.omit({
  canMessage: true,
  isBlockedByViewer: true,
  sharedSpaceCount: true,
})
  .extend({
    email: EmailSchema,
    emailVerified: z.boolean(),
    locale: LocaleSchema,
    timeZone: TimeZoneSchema,
    privacy: PrivacySettingsSchema,
    notifications: NotificationSettingsSchema,
  })
  .merge(TimestampsSchema);

export type OwnProfile = z.infer<typeof OwnProfileSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const UpdateOwnProfileSchema = z
  .strictObject({
    displayName: displayText(80).optional(),
    handle: PublicProfileSchema.shape.handle.optional(),
    headline: displayText(120).nullable().optional(),
    bio: richText(2000).nullable().optional(),
    links: z.array(ProfileLinkSchema).max(5).optional(),
    locale: LocaleSchema.optional(),
    timeZone: TimeZoneSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { error: 'nothing to update' });
export type UpdateOwnProfile = z.infer<typeof UpdateOwnProfileSchema>;

export const UpdatePrivacySchema = PrivacySettingsSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { error: 'nothing to update' },
);

export const UpdateNotificationsSchema = NotificationSettingsSchema.partial();

/**
 * The avatar is a normal media asset: the client uploads through media/, then
 * points the profile at the finished asset. No image bytes ever pass through
 * this route.
 */
export const SetAvatarSchema = z.strictObject({
  assetId: z.uuid(),
});

// ---------------------------------------------------------------------------
// Directory lookup
// ---------------------------------------------------------------------------

export const ProfileSearchQuerySchema = z.object({
  /** Matches handle and display name. Two characters is enough for @mentions. */
  q: z.string().trim().min(2).max(64),
  /** Restricts to people the viewer shares this space or course with. */
  scopeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

/** Deliberately thinner than PublicProfile: this feeds mention autocomplete. */
export const ProfileSuggestionSchema = ActorRefSchema.extend({
  handle: PublicProfileSchema.shape.handle,
  presence: PresenceStateSchema,
});
export const ProfileSuggestionListSchema = z.object({
  items: z.array(ProfileSuggestionSchema),
});

// ---------------------------------------------------------------------------
// Blocking and reporting
// ---------------------------------------------------------------------------

/**
 * Blocking is enforced on send, server-side, in both directions: a blocked
 * person cannot message the blocker and the blocker sees no new messages from
 * them. History stays; deleting someone else's words is moderation, not
 * blocking.
 */
export const BlockSchema = z
  .object({
    blockedUserId: UserIdSchema,
    blockedAt: IsoDateTimeSchema,
    reason: richText(500).nullable().default(null),
    profile: ActorRefSchema,
  })
  .describe('An entry in the signed-in user\u2019s block list.');
export type Block = z.infer<typeof BlockSchema>;

export const BlockUserSchema = z.strictObject({
  userId: UserIdSchema,
  reason: richText(500).optional(),
  /** Also files a moderation report, so repeat offenders become visible. */
  alsoReport: z.boolean().default(false),
  reportReason: ReportReasonSchema.optional(),
});

export const BlockListSchema = paginated(BlockSchema);

export const ReportUserSchema = z.strictObject({
  userId: UserIdSchema,
  reason: ReportReasonSchema,
  detail: richText(2000).optional(),
  /** Optional evidence: a message, post or asset the report is about. */
  contextId: z.uuid().optional(),
  contextType: z.enum(['message', 'post', 'thread', 'asset', 'room']).optional(),
});
export type ReportUser = z.infer<typeof ReportUserSchema>;

export const ReportReceiptSchema = z.object({
  reportId: ReportIdSchema,
  status: z.enum(['received', 'reviewing', 'actioned', 'dismissed']),
  createdAt: IsoDateTimeSchema,
});

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export const PresenceEntrySchema = z.object({
  userId: UserIdSchema,
  state: PresenceStateSchema,
  /** Set only for 'in-class', so a viewer can jump to the lesson. */
  roomId: z.uuid().nullable().default(null),
  updatedAt: IsoDateTimeSchema,
});
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

export const PresenceQuerySchema = z.object({
  userIds: z.array(UserIdSchema).min(1).max(200),
});
export const PresenceListSchema = z.object({
  items: z.array(PresenceEntrySchema),
});

// ---------------------------------------------------------------------------
// Inferred request types
// ---------------------------------------------------------------------------

export type UpdatePrivacy = z.infer<typeof UpdatePrivacySchema>;
export type UpdateNotifications = z.infer<typeof UpdateNotificationsSchema>;
export type ProfileSearchQuery = z.infer<typeof ProfileSearchQuerySchema>;
export type ProfileSuggestion = z.infer<typeof ProfileSuggestionSchema>;
export type BlockUser = z.infer<typeof BlockUserSchema>;
export type ReportReceipt = z.infer<typeof ReportReceiptSchema>;
export type ProfileLink = z.infer<typeof ProfileLinkSchema>;