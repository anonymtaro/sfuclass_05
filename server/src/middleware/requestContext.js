// classroom-app/server/src/middleware/requestContext.js
/**
 * Request context  (F7)  [NEW]
 *
 * Runs first, before anything that logs or rejects. Every request gets:
 *
 *   requestId   unique to this attempt, ours
 *   traceId     unique to the logical operation, propagated from the client
 *   userId      once authentication has run and filled it in
 *
 * The distinction between the two ids is the point. A client retries a failed
 * request three times: three request ids, one trace id. When someone reports a
 * problem and gives you a trace id, you see all three attempts and the reason
 * the first two failed — with a single id you would see one of them and wonder
 * what happened to the others.
 *
 * The context lives in an AsyncLocalStorage, so a service five calls deep can
 * log with the right ids without every function taking a context argument. The
 * cost is that anything escaping the async chain — a `setTimeout` scheduled and
 * forgotten — loses it, which is a fair trade.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { HEADERS } from '@classroom/contracts';
import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';

const storage = new AsyncLocalStorage();

/** W3C traceparent: version-traceid-spanid-flags */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const extractTraceId = (req) => {
  // Prefer the W3C header, so a trace started in the browser's OTEL setup
  // continues here rather than restarting.
  const traceparent = req.get('traceparent');
  const match = traceparent && TRACEPARENT.exec(traceparent);
  if (match) return match[1];

  const supplied = req.get(HEADERS.traceId);
  // Only accept a plausible id: an unvalidated header ends up in log fields
  // and in dashboards, and a 4 KB "trace id" is somebody probing.
  if (supplied && /^[0-9a-zA-Z_-]{8,64}$/.test(supplied)) return supplied;

  return randomUUID().replaceAll('-', '');
};

export const requestContext = () => (req, res, next) => {
  const requestId = req.get(HEADERS.requestId)?.slice(0, 64) || randomUUID();
  const traceId = extractTraceId(req);
  const startedAt = process.hrtime.bigint();

  const context = {
    requestId,
    traceId,
    /** Filled in by the auth middleware; null for anonymous traffic. */
    userId: null,
    tenantId: null,
    startedAt,
  };

  req.context = context;
  req.requestId = requestId;
  req.traceId = traceId;

  // Echoed so a client can quote them in a support request, and so the web
  // app can show a trace id on its error screen.
  res.setHeader(HEADERS.requestId, requestId);
  res.setHeader(HEADERS.traceId, traceId);
  res.setHeader(HEADERS.releaseSha, env.RELEASE_SHA);

  req.log = logger.child({ requestId, traceId });

  // One line per request, on the way out, with the outcome. Logging on the way
  // in doubles the volume and tells you nothing you cannot infer from this.
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    req.log[level](
      {
        method: req.method,
        // The matched route, not the URL: `/courses/:id` aggregates in a
        // dashboard, `/courses/8f3a...` produces a million distinct entries.
        route: req.route?.path ?? req.baseUrl ?? req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        userId: context.userId,
        ip: req.ip,
      },
      'request',
    );
  });

  storage.run(context, () => next());
};

/** Current context, or null outside a request (a queue job, a startup task). */
export const getContext = () => storage.getStore() ?? null;

export const getTraceId = () => storage.getStore()?.traceId ?? null;

/**
 * Called by the auth middleware once a token has been verified. Mutating the
 * stored object rather than replacing it means loggers created earlier in the
 * chain pick the value up too.
 */
export const setUser = ({ userId, tenantId }) => {
  const context = storage.getStore();
  if (!context) return;
  context.userId = userId ?? null;
  context.tenantId = tenantId ?? null;
};

/** Lets a queue job run with a context, so its logs correlate with the request
 *  that enqueued it. */
export const runWithContext = (context, fn) =>
  storage.run({ requestId: randomUUID(), traceId: randomUUID().replaceAll('-', ''), ...context }, fn);

export default requestContext;