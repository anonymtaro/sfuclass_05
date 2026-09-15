/**
 * packages/contracts/src/index.ts
 *
 * The single source of truth for every shape crossing a process boundary:
 * server to web, server to mobile, and the WebSocket surface between them.
 *
 * Two export styles, and the split is deliberate:
 *
 *   Namespaced   the domain schemas. `Course.LessonSchema` and
 *                `Media.AssetSchema` are unambiguous; a flat export of both
 *                would collide on `Status`, `Metadata` and half a dozen other
 *                names that every domain legitimately wants.
 *
 *   Flat         ApiError, HEADERS, CONTRACT_VERSION and the common primitives.
 *                These are used as values in hot paths — httpClient constructs
 *                an ApiError on every failed request — and `Common.ApiError`
 *                would be noise in exchange for nothing.
 *
 * The schema files themselves own the types. This file re-exports and adds
 * nothing: a type written here rather than in a schema is a type with no
 * runtime validator behind it, which is how a contract quietly stops being one.
 */

// ---------------------------------------------------------------------------
// Flat: errors and primitives
// ---------------------------------------------------------------------------

export * from './apiError.ts';
export * from './zod/common.schema.ts';

// ---------------------------------------------------------------------------
// Namespaced: domain schemas
// ---------------------------------------------------------------------------

export * as Assignment from './zod/assignment.schema.ts';
export * as Billing from './zod/billing.schema.ts';
export * as Chat from './zod/chat.schema.ts';
export * as Community from './zod/community.schema.ts';
export * as Course from './zod/course.schema.ts';
export * as Media from './zod/media.schema.ts';
export * as Profile from './zod/profile.schema.ts';

// ---------------------------------------------------------------------------
// Namespaced: socket events
// ---------------------------------------------------------------------------

/**
 * SignalingEvents is namespaced rather than flat because it is addressed that
 * way everywhere it matters — SfuClient reads SIGNALING_CLIENT_EVENTS off it,
 * and server/src/signaling/socketHandlers.js destructures the same constant.
 * Keeping the namespace is what lets the contract test compare the two.
 */
export * as SignalingEvents from './events/signaling.events.ts';
export * as ChatEvents from './events/chat.events.ts';
export * as CommunityEvents from './events/community.events.ts';
export * as MediaEvents from './events/media.events.ts';

// ---------------------------------------------------------------------------
// Transport constants
// ---------------------------------------------------------------------------

/**
 * Namespaces are per-concern, not per-feature: the classroom connection dies
 * when a lesson ends, the chat connection lives as long as the session, and
 * one socket carrying both would tie their lifecycles together.
 */
export const SOCKET_NAMESPACES = Object.freeze({
  classroom: '/classroom',
  chat: '/chat',
  community: '/community',
} as const);

/**
 * Header names, written once. httpClient sets them on every request and the
 * server middleware reads them back; a literal on either side is a typo
 * waiting for production.
 */
export const HEADERS = Object.freeze({
  contractVersion: 'x-contract-version',
  csrfToken: 'x-csrf-token',
  idempotencyKey: 'x-idempotency-key',
  releaseSha: 'x-release-sha',
  requestId: 'x-request-id',
  traceId: 'x-trace-id',
} as const);

/**
 * The envelope every socket acknowledgement uses.
 *
 * Unwrapping it in socketClient means callers deal in values and exceptions
 * rather than in envelopes, and it is why a handler can never succeed silently
 * or fail silently — there is no third shape.
 */
export type SocketAck<TData = unknown> =
  | { ok: true; data: TData }
  | { ok: false; error: { code: string; message: string; traceId?: string } };