/**
 * Shared primitives.
 *
 * Every other schema in this package builds on these, so the rules live here
 * once instead of being restated (and drifting) in seven files.
 *
 * Conventions this file fixes for the whole platform:
 *
 *   Identifiers   UUIDv7. Time-sortable, which is what makes keyset pagination
 *                 possible without a second sort column. Branded per entity so
 *                 a LessonId cannot be passed where a CourseId is expected.
 *   Timestamps    ISO 8601 with an offset, always UTC on the wire. Date objects
 *                 never cross a network boundary.
 *   Pagination    Cursor based, never offset. An offset shifts under you while
 *                 someone else is posting.
 *   Money         Integer minor units plus a currency. No floats, ever.
 *   Lists         { items, nextCursor, hasMore } — the same envelope everywhere.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------

/**
 * Bumped when a change would break an already-released client. Clients send it
 * as `X-Contract-Version`; the API keeps the previous major alive for one
 * release cycle after a mobile store submission (see deploy-mobile.yml).
 */
export const CONTRACT_VERSION = '6.0.0' as const;
export const CONTRACT_VERSION_HEADER = 'x-contract-version' as const;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Raw, unbranded id. Use `entityId()` for anything that names a real entity. */
export const UuidSchema = z.uuid();

/**
 * Branded id factory.
 *
 *   export const CourseIdSchema = entityId('CourseId');
 *   export type CourseId = z.infer<typeof CourseIdSchema>;
 *
 * The brand is a compile-time construct only; the value on the wire is a plain
 * UUID string.
 */
export const entityId = <B extends string>(brand: B) => z.uuid().brand<B>();

export const TenantIdSchema = entityId('TenantId');
export const UserIdSchema = entityId('UserId');

export type TenantId = z.infer<typeof TenantIdSchema>;
export type UserId = z.infer<typeof UserIdSchema>;

/**
 * Client-generated idempotency key. The chat composer, the upload queue and the
 * offline outbox all send one so a retry after a reconnect updates the original
 * row instead of creating a duplicate.
 */
export const IdempotencyKeySchema = z.uuid();

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** '2026-09-09T14:32:11.000Z' */
export const IsoDateTimeSchema = z.iso.datetime({ offset: false });
/** '2026-09-09' — due dates and calendar days, where a time would be a lie. */
export const IsoDateSchema = z.iso.date();
/** IANA zone, e.g. 'Europe/Berlin'. Live sessions are scheduled in one. */
export const TimeZoneSchema = z.string().min(1).max(64);
export const DurationSecondsSchema = z.number().int().nonnegative();

/** Present on every persisted entity. */
export const TimestampsSchema = z.object({
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

/** Soft deletion is the default; hard deletion is a retention job. */
export const SoftDeleteSchema = z.object({
  deletedAt: IsoDateTimeSchema.nullable().default(null),
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export const SlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: 'lowercase words separated by single hyphens' });

export const LocaleSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, { error: 'BCP-47 language tag, e.g. de or de-DE' })
  .default('en');

export const EmailSchema = z.email().max(254).toLowerCase().trim();
export const UrlSchema = z.url().max(2048);
export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * A short human label: trimmed, no control characters, no zero-width padding.
 * Used for titles, display names and channel names.
 */
export const displayText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u001F\u007F\u200B-\u200D\uFEFF]*$/u, {
      error: 'control and zero-width characters are not allowed',
    });

/** Longer prose: descriptions, bios, post bodies. Trimmed, length-capped. */
export const richText = (max: number) => z.string().trim().max(max);

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 100;

/**
 * Opaque cursor. Servers encode `(sortValue, id)`; clients pass it back
 * untouched. Treating it as opaque is what allows the sort key to change later
 * without breaking a released client.
 */
export const CursorSchema = z.string().min(1).max(512);

export const SortOrderSchema = z.enum(['asc', 'desc']).default('desc');

export const PaginationQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  order: SortOrderSchema,
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/** Wraps any item schema in the one list envelope this platform uses. */
export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: CursorSchema.nullable(),
    hasMore: z.boolean(),
  });

export type Paginated<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export const CurrencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, { error: 'ISO 4217 code, uppercase' });

/** 12.50 EUR is { amountMinor: 1250, currency: 'EUR' }. */
export const MoneySchema = z.object({
  amountMinor: z.number().int(),
  currency: CurrencySchema,
});
export type Money = z.infer<typeof MoneySchema>;

// ---------------------------------------------------------------------------
// Roles and visibility
// ---------------------------------------------------------------------------

/** Platform-wide capability, resolved by identity/rbac.js. */
export const PLATFORM_ROLES = ['owner', 'teacher', 'learner'] as const;
export const PlatformRoleSchema = z.enum(PLATFORM_ROLES);
export type PlatformRole = z.infer<typeof PlatformRoleSchema>;

/** Role inside a single space, room or conversation. */
export const MEMBER_ROLES = ['owner', 'moderator', 'member'] as const;
export const MemberRoleSchema = z.enum(MEMBER_ROLES);
export type MemberRole = z.infer<typeof MemberRoleSchema>;

export const VISIBILITIES = ['public', 'members', 'private'] as const;
export const VisibilitySchema = z.enum(VISIBILITIES);
export type Visibility = z.infer<typeof VisibilitySchema>;

// ---------------------------------------------------------------------------
// Small shared shapes
// ---------------------------------------------------------------------------

/** The minimum needed to render a person: avatar, name, link to a profile. */
export const ActorRefSchema = z.object({
  userId: UserIdSchema,
  displayName: displayText(80),
  avatarUrl: UrlSchema.nullable().default(null),
});
export type ActorRef = z.infer<typeof ActorRefSchema>;

/** Free-form key/value carried by events and jobs. Never trusted for authz. */
export const MetadataSchema = z.record(z.string().max(64), z.string().max(512)).default({});

/** Standard response for a mutation with nothing useful to return. */
export const AcknowledgedSchema = z.object({ ok: z.literal(true) });

/** Path parameter helper: `idParam('courseId', CourseIdSchema)`. */
export const idParam = <K extends string, S extends z.ZodTypeAny>(key: K, schema: S) =>
  z.object({ [key]: schema } as Record<K, S>);