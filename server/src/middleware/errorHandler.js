// classroom-app/server/src/middleware/errorHandler.js
/**
 * Error handler  (F7)  [NEW]
 *
 * The last middleware, and the only place an error becomes a response.
 *
 * Two rules:
 *
 *   Everything leaves as an ApiError. A client — web, mobile, or the outbox
 *   deciding whether to retry — parses one shape, always. An error that escapes
 *   in some other form is a bug in this file, not in the caller.
 *
 *   Nothing internal leaks in production. No stack, no SQL fragment, no
 *   internal host name, no library message. An unexpected error becomes a
 *   generic `internal_error` carrying only the trace id, which is enough for
 *   support to find the full detail in CloudWatch and not enough for anyone
 *   else to learn anything.
 *
 * That second rule is why the mapping below is explicit. Passing a caught
 * error's `.message` straight through is how a connection string ends up in a
 * browser console.
 */

import { ZodError } from 'zod';
import { ApiError, fromZodError } from '@classroom/contracts';
import { isProduction } from '../config/env.js';

/**
 * Recognises the errors thrown by libraries in the chain and gives each a
 * proper code. Anything unrecognised is deliberately not translated.
 */
const translate = (error, traceId) => {
  if (ApiError.is(error)) {
    error.traceId ||= traceId;
    return error;
  }

  if (error instanceof ZodError) {
    return fromZodError(error, traceId);
  }

  // express.json() on malformed input.
  if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    return new ApiError('malformed_request', {
      detail: 'The request body is not valid JSON.',
      traceId,
    });
  }

  // body-parser's limit.
  if (error?.type === 'entity.too.large') {
    return new ApiError('payload_too_large', {
      detail: 'The request body is too large.',
      traceId,
    });
  }

  // Postgres unique violation, surfaced as a conflict rather than a 500.
  if (error?.code === '23505') {
    return new ApiError('conflict', {
      detail: 'That value is already taken.',
      traceId,
    });
  }

  // Postgres foreign key violation: the client referenced something gone.
  if (error?.code === '23503') {
    return new ApiError('not_found', {
      detail: 'A referenced record does not exist.',
      traceId,
    });
  }

  // Statement timeout — the query is too slow, which is our problem, not the
  // caller's, but it is worth telling them a retry might work.
  if (error?.code === '57014') {
    return new ApiError('dependency_unavailable', {
      detail: 'The request took too long. Try again.',
      retryAfter: 2,
      traceId,
    });
  }

  if (error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT') {
    return new ApiError('dependency_unavailable', {
      detail: 'A downstream service is unavailable.',
      retryAfter: 5,
      traceId,
    });
  }

  return null;
};

export const errorHandler =
  ({ exposeStack = !isProduction } = {}) =>
  // eslint-disable-next-line no-unused-vars -- express identifies this by arity
  (error, req, res, next) => {
    const traceId = req.traceId ?? '';
    const translated = translate(error, traceId);

    const apiError =
      translated ??
      new ApiError('internal_error', {
        // Never the original message. In development the stack is attached
        // below, which is more useful anyway.
        detail: 'Something went wrong on our side.',
        traceId,
        cause: error,
      });

    // Log the real thing, always, whatever the client is told.
    const level = apiError.status >= 500 ? 'error' : 'warn';
    req.log?.[level](
      {
        err: error,
        code: apiError.code,
        status: apiError.status,
        path: req.path,
        method: req.method,
      },
      apiError.status >= 500 ? 'request failed' : 'request rejected',
    );

    // A response already on its way cannot be replaced; ending it is all that
    // is left, and Express's default handler would otherwise try to write.
    if (res.headersSent) {
      req.log?.error('error after headers were sent; destroying the response');
      return res.destroy();
    }

    if (apiError.retryAfter && !res.getHeader('Retry-After')) {
      res.setHeader('Retry-After', apiError.retryAfter);
    }

    const body = apiError.toJSON();

    // Development only, and only for genuinely unexpected errors — an
    // ApiError someone threw on purpose has no stack worth reading.
    if (exposeStack && !translated && error instanceof Error) {
      body.stack = error.stack?.split('\n').slice(0, 12);
    }

    res.status(apiError.status).type('application/problem+json').json(body);
  };

export default errorHandler;