/**
 * One error shape, for every route, every socket acknowledgement and every
 * client.
 *
 * The format follows RFC 9457 (problem details) closely enough to be familiar,
 * with two additions the platform needs: a stable machine-readable `code` that
 * clients branch on, and the `traceId` that ties the response to a log line and
 * an X-Ray trace.
 *
 *   {
 *     "type":    "https://errors.classroom.app/quota_exceeded",
 *     "title":   "Storage quota exceeded",
 *     "status":  413,
 *     "code":    "quota_exceeded",
 *     "detail":  "This upload would exceed the plan's 50 GB storage limit.",
 *     "traceId": "0af7651916cd43dd8448eb211c80319c",
 *     "errors":  [{ "path": "file.size", "message": "too large" }]
 *   }
 *
 * Rules:
 *   - `code` is the contract. `detail` is for humans and may be reworded freely.
 *   - `detail` never contains a stack trace, a SQL fragment or an internal host
 *     name. In production middleware/errorHandler.js drops anything unexpected
 *     to a generic `internal_error` with the traceId intact.
 *   - Adding a code is a minor version change; removing or repurposing one is
 *     breaking, because a released mobile app may still branch on it.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  // --- request ------------------------------------------------------------
  'validation_failed', // body, query or params rejected by a zod schema
  'malformed_request', // unparseable body, bad content type
  'unsupported_contract_version', // client is older than the API still serves

  // --- identity -----------------------------------------------------------
  'unauthenticated', // no token, expired token, bad signature
  'token_revoked', // session was signed out or revoked server-side
  'forbidden', // authenticated, but not allowed
  'mfa_required',

  // --- resources ----------------------------------------------------------
  'not_found',
  'conflict', // duplicate slug, concurrent edit
  'version_mismatch', // optimistic concurrency: resource moved under you
  'gone', // soft-deleted and past the recovery window

  // --- limits -------------------------------------------------------------
  'rate_limited',
  'seat_limit_reached', // capacity/CapacityGuard.js
  'quota_exceeded', // capacity/StorageGuard.js
  'plan_upgrade_required', // billing/LimitResolver.js
  'payload_too_large',

  // --- domain: classroom (F1) ---------------------------------------------
  'room_full',
  'room_closed',
  'not_room_host',
  'screen_share_taken', // another presenter holds the lock
  'sfu_unavailable', // no node could take the room

  // --- domain: courses (F3) -----------------------------------------------
  'prerequisite_not_met',
  'curriculum_cycle', // the DAG would stop being a DAG
  'course_not_published',

  // --- domain: messaging (F6) ---------------------------------------------
  'blocked_by_user',
  'dm_not_allowed', // recipient's privacy setting forbids it
  'message_too_long',
  'slow_mode_active',
  'conversation_archived',

  // --- domain: media (F4) -------------------------------------------------
  'upload_incomplete',
  'unsupported_media_type',
  'asset_not_ready', // still uploading, scanning or transcoding
  'asset_infected', // quarantine rejected it

  // --- platform -----------------------------------------------------------
  'dependency_unavailable', // a downstream service failed, retry is sensible
  'not_implemented',
  'internal_error',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * Canonical HTTP status per code. The mapping lives here rather than in each
 * route so the same failure never surfaces as 400 in one place and 422 in
 * another.
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  validation_failed: 422,
  malformed_request: 400,
  unsupported_contract_version: 426,

  unauthenticated: 401,
  token_revoked: 401,
  forbidden: 403,
  mfa_required: 401,

  not_found: 404,
  conflict: 409,
  version_mismatch: 409,
  gone: 410,

  rate_limited: 429,
  seat_limit_reached: 409,
  quota_exceeded: 413,
  plan_upgrade_required: 402,
  payload_too_large: 413,

  room_full: 409,
  room_closed: 409,
  not_room_host: 403,
  screen_share_taken: 409,
  sfu_unavailable: 503,

  prerequisite_not_met: 403,
  curriculum_cycle: 422,
  course_not_published: 409,

  blocked_by_user: 403,
  dm_not_allowed: 403,
  message_too_long: 422,
  slow_mode_active: 429,
  conversation_archived: 409,

  upload_incomplete: 409,
  unsupported_media_type: 415,
  asset_not_ready: 409,
  asset_infected: 422,

  dependency_unavailable: 503,
  not_implemented: 501,
  internal_error: 500,
};

/**
 * Whether a client may retry the same request unchanged. `useChat`, `useUpload`
 * and the offline outbox read this instead of hard-coding status numbers.
 */
export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  'rate_limited',
  'slow_mode_active',
  'dependency_unavailable',
  'sfu_unavailable',
  'internal_error',
]);

export const isRetryable = (code: ErrorCode): boolean => RETRYABLE_CODES.has(code);

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** One field-level problem, produced from a zod issue. */
export const FieldErrorSchema = z.object({
  /** Dotted path into the request body, e.g. 'modules.2.lessons.0.title'. */
  path: z.string().max(256),
  message: z.string().max(512),
  /** The zod issue code, for clients that want to localise the message. */
  rule: z.string().max(64).optional(),
});
export type FieldError = z.infer<typeof FieldErrorSchema>;

export const ApiErrorSchema = z.object({
  type: z.string().max(256),
  title: z.string().max(200),
  status: z.number().int().min(400).max(599),
  code: ErrorCodeSchema,
  detail: z.string().max(2000).optional(),
  /** Correlates with the log line and the X-Ray trace. Always present. */
  traceId: z.string().max(64),
  /** Only for validation_failed. */
  errors: z.array(FieldErrorSchema).max(100).optional(),
  /** Seconds to wait, mirrored in the Retry-After header. */
  retryAfter: z.number().int().positive().optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;

export const ERROR_TYPE_BASE = 'https://errors.classroom.app/' as const;

/** Default titles. A route may pass a better one; the code stays the same. */
const DEFAULT_TITLES: Partial<Record<ErrorCode, string>> = {
  validation_failed: 'Request validation failed',
  unauthenticated: 'Authentication required',
  forbidden: 'Not allowed',
  not_found: 'Not found',
  rate_limited: 'Too many requests',
  quota_exceeded: 'Storage quota exceeded',
  room_full: 'This room is full',
  screen_share_taken: 'Someone else is sharing',
  dm_not_allowed: 'This person does not accept direct messages',
  asset_not_ready: 'File is still being processed',
  internal_error: 'Something went wrong',
};

const titleFor = (code: ErrorCode): string =>
  DEFAULT_TITLES[code] ?? code.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// Throwable
// ---------------------------------------------------------------------------

export interface ApiErrorOptions {
  detail?: string;
  title?: string;
  errors?: FieldError[];
  retryAfter?: number;
  traceId?: string;
  /** Never serialised. Logged server-side so the original failure is not lost. */
  cause?: unknown;
}

/**
 * The only error type that should ever reach middleware/errorHandler.js
 * deliberately. Anything else is a bug and becomes `internal_error`.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly title: string;
  readonly detail?: string;
  readonly errors?: FieldError[];
  readonly retryAfter?: number;
  traceId: string;

  constructor(code: ErrorCode, options: ApiErrorOptions = {}) {
    super(options.detail ?? options.title ?? code, { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.title = options.title ?? titleFor(code);
    this.detail = options.detail;
    this.errors = options.errors;
    this.retryAfter = options.retryAfter;
    this.traceId = options.traceId ?? '';
    // Node-only; keeps the constructor out of the stack trace.
    (Error as { captureStackTrace?: (t: object, c: unknown) => void }).captureStackTrace?.(
      this,
      ApiError,
    );
  }

  get retryable(): boolean {
    return isRetryable(this.code);
  }

  toJSON(): ApiErrorBody {
    return {
      type: `${ERROR_TYPE_BASE}${this.code}`,
      title: this.title,
      status: this.status,
      code: this.code,
      ...(this.detail ? { detail: this.detail } : {}),
      traceId: this.traceId,
      ...(this.errors?.length ? { errors: this.errors } : {}),
      ...(this.retryAfter ? { retryAfter: this.retryAfter } : {}),
    };
  }

  static is(value: unknown): value is ApiError {
    return value instanceof ApiError;
  }

  /** Rebuilds a thrown error from a response body, so clients can `catch` it. */
  static fromResponse(body: unknown): ApiError {
    const parsed = ApiErrorSchema.safeParse(body);
    if (!parsed.success) {
      return new ApiError('internal_error', { detail: 'Unrecognised error response' });
    }
    const { code, title, detail, errors, retryAfter, traceId } = parsed.data;
    return new ApiError(code, { title, detail, errors, retryAfter, traceId });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Turns a zod failure into the validation_failed shape clients expect. */
export const fromZodError = (error: z.ZodError, traceId = ''): ApiError =>
  new ApiError('validation_failed', {
    traceId,
    detail: 'One or more fields are invalid.',
    errors: error.issues.slice(0, 100).map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      rule: issue.code,
    })),
  });

export const notFound = (what: string, traceId = ''): ApiError =>
  new ApiError('not_found', { detail: `${what} does not exist.`, traceId });

export const forbidden = (why: string, traceId = ''): ApiError =>
  new ApiError('forbidden', { detail: why, traceId });

export const rateLimited = (retryAfter: number, traceId = ''): ApiError =>
  new ApiError('rate_limited', {
    detail: `Too many requests. Try again in ${retryAfter}s.`,
    retryAfter,
    traceId,
  });

/**
 * Socket acknowledgement envelope. Socket.IO callbacks cannot throw across the
 * wire, so every ack is `{ ok: true, data }` or `{ ok: false, error }` — the
 * same ApiError body an HTTP route would have returned.
 */
export const SocketAckSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: ApiErrorSchema }),
  ]);

export type SocketAck<T> = { ok: true; data: T } | { ok: false; error: ApiErrorBody };