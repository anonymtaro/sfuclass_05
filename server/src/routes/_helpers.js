// classroom-app/server/src/routes/_helpers.js
/**
 * Route helpers  (F7)
 *
 * The small amount of plumbing every route file repeats, in one place.
 *
 * The one that earns its keep is `route`. Express 4 does not await an async
 * handler, so a rejected promise inside one is an unhandled rejection: the
 * request hangs until the client times out and errorHandler never sees it.
 * Wrapping the handler means a thrown ApiError lands in the error middleware
 * like any other, and a handler can simply `return` its payload instead of
 * remembering to call res.json().
 *
 * Returning `null` or `undefined` from a handler means 204 No Content. That is
 * deliberate: a DELETE that returns `{}` invites clients to look for something
 * in it.
 */

import { ApiError } from '@classroom/contracts';

/* ------------------------------------------------------------------ *
 * Handler wrapper
 * ------------------------------------------------------------------ */

/**
 * @param {(req, res, next) => Promise<unknown>} handler
 */
export const route = (handler) => async (req, res, next) => {
  try {
    const payload = await handler(req, res, next);

    // The handler answered for itself — a stream, a redirect, a file.
    if (res.headersSent) return;

    if (payload === null || payload === undefined) {
      res.status(204).end();
      return;
    }

    res.json(payload);
  } catch (error) {
    next(error);
  }
};

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const SOURCES = ['body', 'params', 'query', 'headers'];

/**
 * Parses the named parts of the request against zod schemas and *replaces*
 * them with the parsed result, so a handler downstream gets coerced types and
 * defaults rather than raw strings.
 *
 * `req.query` is a getter in Express 5 and read-only, so the parsed value goes
 * on `req.validatedQuery` as well; handlers should prefer that where both
 * exist.
 *
 * @param {{ body?: import('zod').ZodTypeAny, params?: …, query?: …, headers?: … }} schemas
 */
export const validate = (schemas) => (req, _res, next) => {
  for (const source of SOURCES) {
    const schema = schemas[source];
    if (!schema) continue;

    const result = schema.safeParse(req[source]);

    if (!result.success) {
      // Field-level detail, because "validation failed" tells a client nothing
      // it can act on. Values are never echoed back — a password would end up
      // in an error body and then in a log.
      const fields = result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      }));

      return next(
        new ApiError('validation_failed', {
          title: 'Invalid request',
          detail: `${fields.length} field${fields.length === 1 ? '' : 's'} failed validation.`,
          fields,
          traceId: req.traceId ?? '',
        }),
      );
    }

    try {
      req[source] = result.data;
    } catch {
      // Express 5 makes req.query read-only; the copy below is the way in.
    }
    if (source === 'query') req.validatedQuery = result.data;
  }

  return next();
};

/* ------------------------------------------------------------------ *
 * Authentication
 * ------------------------------------------------------------------ */

/**
 * Requires a verified bearer token.
 *
 * It does not verify anything itself — that is the auth middleware's job, and
 * by the time a route runs `req.user` is either populated or it is not. This
 * only turns "not populated" into the right status code, in one place, so that
 * twelve route files do not each invent their own.
 */
export const requireAuth = (req, _res, next) => {
  if (!req.user?.id) {
    return next(
      new ApiError('unauthenticated', {
        detail: 'Sign in to continue.',
        traceId: req.traceId ?? '',
      }),
    );
  }
  return next();
};

/** Requires one of the given tenant roles. Use after requireAuth. */
export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user?.id) {
      return next(new ApiError('unauthenticated', { traceId: req.traceId ?? '' }));
    }
    if (!roles.includes(req.user.role)) {
      return next(
        new ApiError('forbidden', {
          detail: 'Your account cannot perform this action.',
          traceId: req.traceId ?? '',
        }),
      );
    }
    return next();
  };

/* ------------------------------------------------------------------ *
 * Error constructors
 * ------------------------------------------------------------------ */

/**
 * Deliberately vague by default. "No such user" and "wrong password" are
 * different answers to the same question, and telling them apart turns a login
 * form into a user-enumeration endpoint.
 */
export const unauthorised = (detail = 'Sign in to continue.') =>
  new ApiError('unauthenticated', { detail });

export const forbidden = (detail = 'You do not have access to this.') =>
  new ApiError('forbidden', { detail });

export const notFound = (what = 'Resource') =>
  new ApiError('not_found', { detail: `${what} not found.` });

export const conflict = (detail) => new ApiError('conflict', { detail });

export const badRequest = (detail, _meta) => new ApiError('malformed_request', { detail });

export const tenantOf = (req) => req.user?.tenantId ?? req.context?.tenantId;

export const q = (req) => req.validatedQuery ?? req.query ?? {};

export const paging = (req, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const query = q(req);
  const requestedLimit = Number(query.limit ?? defaultLimit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), maxLimit)
    : defaultLimit;

  return {
    limit,
    cursor: query.cursor ?? null,
  };
};

/* ------------------------------------------------------------------ *
 * Response headers
 * ------------------------------------------------------------------ */

/**
 * Anything carrying a token, a session or a signed URL must not sit in a
 * shared cache or in the browser's back-forward cache. `no-store` rather than
 * `no-cache`: no-cache still permits storage, only revalidation.
 */
export const noStore = (res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  return res;
};

/** For immutable, content-addressed responses only. */
export const cacheFor = (res, seconds, { immutable = false } = {}) => {
  res.set(
    'Cache-Control',
    `public, max-age=${seconds}${immutable ? ', immutable' : ''}`,
  );
  return res;
};

/* ------------------------------------------------------------------ *
 * Pagination
 * ------------------------------------------------------------------ */

/**
 * Keyset, not offset. `LIMIT 20 OFFSET 100000` makes Postgres walk a hundred
 * thousand rows it then discards, and it skips or repeats rows when the table
 * changes underneath a paging client.
 */
export const keysetPage = (items, { limit, cursorOf }) => {
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return {
    items: page,
    nextCursor: hasMore && page.length > 0 ? cursorOf(page[page.length - 1]) : null,
  };
};

export default {
  route,
  validate,
  requireAuth,
  requireRole,
  unauthorised,
  forbidden,
  notFound,
  conflict,
  badRequest,
  tenantOf,
  q,
  paging,
  noStore,
  cacheFor,
  keysetPage,
};