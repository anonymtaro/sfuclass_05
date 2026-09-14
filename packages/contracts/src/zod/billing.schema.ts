/**
 * Billing and entitlements
 *
 * Mirrors the existing billing models rather than redesigning them. What is new
 * in version 6 is the storage dimension: a plan now carries `storageQuotaGb`
 * alongside its seat limits, because uploads, recordings and chat attachments
 * all consume the same pool (F4).
 *
 * The important shape here is Entitlements. It is the one object the whole
 * product reads before allowing anything expensive — opening a room, presigning
 * an upload, publishing a course. It is computed by LimitResolver.js, cached in
 * Redis for BILLING_ENTITLEMENT_TTL_SEC, and deliberately flat: a client should
 * never have to reason about plans, trials and overrides to answer "can I do
 * this".
 */

import { z } from 'zod';
import {
  IsoDateTimeSchema,
  MoneySchema,
  TimestampsSchema,
  UserIdSchema,
  UrlSchema,
  displayText,
  entityId,
  paginated,
  richText,
} from './common.schema.js';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const PlanIdSchema = entityId('PlanId');
export const SubscriptionIdSchema = entityId('SubscriptionId');
export const InvoiceIdSchema = entityId('InvoiceId');

export type PlanId = z.infer<typeof PlanIdSchema>;
export type SubscriptionId = z.infer<typeof SubscriptionIdSchema>;

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export const BILLING_INTERVALS = ['month', 'year'] as const;
export const BillingIntervalSchema = z.enum(BILLING_INTERVALS);

/**
 * Everything a plan permits. Every limit is a number so a comparison is always
 * the same operation; `null` means unlimited, which is checked explicitly.
 */
export const PlanLimitsSchema = z.object({
  /** Concurrent participants in one live room, enforced by CapacityGuard. */
  seatsPerRoom: z.number().int().positive(),
  /** Rooms that may run at the same time across the tenant. */
  concurrentRooms: z.number().int().positive(),
  /** Storage pool shared by media, recordings and chat attachments (F4). */
  storageQuotaGb: z.number().int().positive(),
  /** Published courses. Drafts are free. */
  maxCourses: z.number().int().positive().nullable(),
  maxSpaces: z.number().int().positive().nullable(),
  maxTeachers: z.number().int().positive().nullable(),
  /** 0 disables recording on the plan entirely. */
  recordingHoursPerMonth: z.number().int().nonnegative(),
  recordingRetentionDays: z.number().int().positive(),
  /** Feature switches, rather than numeric limits. */
  features: z
    .object({
      screenShare: z.boolean().default(true),
      breakoutRooms: z.boolean().default(false),
      recording: z.boolean().default(false),
      transcription: z.boolean().default(false),
      publicChat: z.boolean().default(true),
      directMessages: z.boolean().default(true),
      certificates: z.boolean().default(false),
      customDomain: z.boolean().default(false),
      sso: z.boolean().default(false),
    })
    // prefault, not default: the value supplied is an *input*, so each flag
    // falls back to its own default rather than having to be repeated here.
    .prefault({}),
});
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

export const PlanSchema = z
  .object({
    planId: PlanIdSchema,
    /** Stable internal key: 'free', 'pro', 'school'. Matches STRIPE_PRICE_MAP. */
    code: z.string().min(1).max(32),
    name: displayText(60),
    description: richText(1000).nullable().default(null),
    price: MoneySchema,
    interval: BillingIntervalSchema,
    limits: PlanLimitsSchema,
    /** Hidden plans are grandfathered: still billed, no longer sold. */
    visible: z.boolean().default(true),
    trialDays: z.number().int().min(0).max(90).default(0),
  })
  .merge(TimestampsSchema);
export type Plan = z.infer<typeof PlanSchema>;

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/** Mirrors the provider's lifecycle so reconciliation stays a straight map. */
export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'paused',
  'canceled',
  'incomplete',
] as const;
export const SubscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const SubscriptionSchema = z
  .object({
    subscriptionId: SubscriptionIdSchema,
    planId: PlanIdSchema,
    planCode: z.string().max(32),
    status: SubscriptionStatusSchema,
    /** Purchased seats, which may exceed the plan's per-room limit. */
    quantity: z.number().int().positive().default(1),
    currentPeriodStart: IsoDateTimeSchema,
    currentPeriodEnd: IsoDateTimeSchema,
    trialEndsAt: IsoDateTimeSchema.nullable().default(null),
    /** Set when a cancellation takes effect at the end of the period. */
    cancelAt: IsoDateTimeSchema.nullable().default(null),
    canceledAt: IsoDateTimeSchema.nullable().default(null),
    /** Opaque provider reference; never used for authorisation decisions. */
    providerRef: z.string().max(128).nullable().default(null),
  })
  .merge(TimestampsSchema);
export type Subscription = z.infer<typeof SubscriptionSchema>;

// ---------------------------------------------------------------------------
// Entitlements — the object the product actually reads
// ---------------------------------------------------------------------------

export const UsageSchema = z.object({
  storageBytes: z.number().int().nonnegative(),
  storageQuotaBytes: z.number().int().positive(),
  activeRooms: z.number().int().nonnegative(),
  publishedCourses: z.number().int().nonnegative(),
  spaces: z.number().int().nonnegative(),
  teachers: z.number().int().nonnegative(),
  recordingMinutesThisMonth: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const EntitlementsSchema = z.object({
  planCode: z.string().max(32),
  status: SubscriptionStatusSchema,
  limits: PlanLimitsSchema,
  usage: UsageSchema,
  /**
   * Pre-computed answers, so a client never re-implements the comparison and
   * then disagrees with the server about whether a button should be enabled.
   */
  can: z.object({
    startRoom: z.boolean(),
    record: z.boolean(),
    upload: z.boolean(),
    publishCourse: z.boolean(),
    createSpace: z.boolean(),
    inviteTeacher: z.boolean(),
    screenShare: z.boolean(),
    useBreakouts: z.boolean(),
  }),
  /** Freshness of the cached copy; see BILLING_ENTITLEMENT_TTL_SEC. */
  computedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
});
export type Entitlements = z.infer<typeof EntitlementsSchema>;

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'] as const;
export const InvoiceStatusSchema = z.enum(INVOICE_STATUSES);

export const InvoiceSchema = z.object({
  invoiceId: InvoiceIdSchema,
  number: z.string().max(64),
  status: InvoiceStatusSchema,
  total: MoneySchema,
  periodStart: IsoDateTimeSchema,
  periodEnd: IsoDateTimeSchema,
  issuedAt: IsoDateTimeSchema,
  paidAt: IsoDateTimeSchema.nullable().default(null),
  /** Hosted invoice page at the provider; short-lived. */
  hostedUrl: UrlSchema.nullable().default(null),
  pdfUrl: UrlSchema.nullable().default(null),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

export const InvoiceListSchema = paginated(InvoiceSchema);
export const PlanListSchema = z.object({ items: z.array(PlanSchema) });

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Checkout and plan changes are redirects to the provider, not forms handled
 * here. No card data ever reaches this API, which is what keeps PCI scope out
 * of the application.
 */
export const CreateCheckoutSessionSchema = z.strictObject({
  planCode: z.string().min(1).max(32),
  interval: BillingIntervalSchema.default('month'),
  quantity: z.number().int().positive().max(10_000).default(1),
  successUrl: UrlSchema,
  cancelUrl: UrlSchema,
});

export const CheckoutSessionSchema = z.object({
  /** The client redirects here; it is single-use and expires. */
  url: UrlSchema,
  expiresAt: IsoDateTimeSchema,
});

export const CreatePortalSessionSchema = z.strictObject({
  returnUrl: UrlSchema,
});

export const ChangePlanSchema = z.strictObject({
  planCode: z.string().min(1).max(32),
  quantity: z.number().int().positive().max(10_000).optional(),
  /** Preview the proration before committing to it. */
  previewOnly: z.boolean().default(false),
});

export const PlanChangePreviewSchema = z.object({
  immediateCharge: MoneySchema.nullable(),
  nextInvoiceTotal: MoneySchema,
  effectiveAt: IsoDateTimeSchema,
  /** Downgrades that would break current usage, e.g. storage already over quota. */
  blockers: z
    .array(z.object({ code: z.string().max(64), message: z.string().max(300) }))
    .default([]),
});

export const CancelSubscriptionSchema = z.strictObject({
  /** False cancels at the end of the paid period, which is the default. */
  immediately: z.boolean().default(false),
  reason: richText(500).optional(),
});

/** Seat and quota checks the UI runs before showing a paywall. */
export const CheckLimitQuerySchema = z.object({
  action: z.enum([
    'start-room',
    'record',
    'upload',
    'publish-course',
    'create-space',
    'invite-teacher',
  ]),
  /** For uploads: the size about to be requested. */
  sizeBytes: z.coerce.number().int().positive().optional(),
});

export const LimitCheckResultSchema = z.object({
  allowed: z.boolean(),
  /** Present when denied; matches an ErrorCode so the UI can reuse copy. */
  reason: z
    .enum(['seat_limit_reached', 'quota_exceeded', 'plan_upgrade_required'])
    .nullable()
    .default(null),
  /** What the caller would need. Drives the upgrade dialog's headline. */
  requiredPlanCode: z.string().max(32).nullable().default(null),
  currentUsage: z.number().int().nonnegative().nullable().default(null),
  limit: z.number().int().nonnegative().nullable().default(null),
});
export type LimitCheckResult = z.infer<typeof LimitCheckResultSchema>;

/** Audit view of a processed provider event, for support and reconciliation. */
export const ProcessedEventSchema = z.object({
  eventId: z.string().max(128),
  type: z.string().max(128),
  processedAt: IsoDateTimeSchema,
  subscriptionId: SubscriptionIdSchema.nullable().default(null),
  userId: UserIdSchema.nullable().default(null),
});

// ---------------------------------------------------------------------------
// Inferred request and response types
// ---------------------------------------------------------------------------

export type CheckLimitQuery = z.infer<typeof CheckLimitQuerySchema>;
export type CreateCheckoutSession = z.infer<typeof CreateCheckoutSessionSchema>;
export type CheckoutSession = z.infer<typeof CheckoutSessionSchema>;
export type CreatePortalSession = z.infer<typeof CreatePortalSessionSchema>;
export type ChangePlan = z.infer<typeof ChangePlanSchema>;
export type PlanChangePreview = z.infer<typeof PlanChangePreviewSchema>;
export type CancelSubscription = z.infer<typeof CancelSubscriptionSchema>;
export type ProcessedEvent = z.infer<typeof ProcessedEventSchema>;
export type BillingInterval = z.infer<typeof BillingIntervalSchema>;