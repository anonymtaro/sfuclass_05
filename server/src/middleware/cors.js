// classroom-app/server/src/middleware/cors.js
/**
 * CORS  (F7)  [NEW]
 *
 * Exact origins from ALLOWED_ORIGINS, and nothing else. No wildcards, no
 * regular expressions, no "ends with our domain" check — that last one is how
 * `classroom.app.attacker.com` gets on the allowlist.
 *
 * One deliberate hole: a request with no Origin header at all is allowed. The
 * Expo app, server-to-server calls and curl all send none, and rejecting them
 * would break the mobile client for no security benefit — CORS protects a
 * browser from a page it did not intend to talk to, and there is no page here.
 * The bearer token is what authorises the request.
 *
 * A rejected origin gets a normal ApiError rather than a bare CORS failure, so
 * the browser console says something a developer can act on.
 */

import cors from 'cors';
import { ApiError } from '@classroom/contracts';
import { corsConfig } from '../config/security.config.js';

export const corsMiddleware = () => {
  const allowlist = new Set(corsConfig.allowlist);

  const handler = cors({
    origin(origin, callback) {
      if (!origin && corsConfig.allowNoOrigin) return callback(null, true);
      if (origin && allowlist.has(origin)) return callback(null, true);

      // The error is surfaced by the wrapper below, not thrown into cors's
      // own error path, so it comes out in the platform's error shape.
      return callback(
        new ApiError('forbidden', {
          title: 'Origin not allowed',
          detail: 'This origin is not permitted to call the API.',
        }),
      );
    },
    credentials: corsConfig.credentials,
    methods: corsConfig.methods,
    allowedHeaders: corsConfig.allowedHeaders,
    exposedHeaders: corsConfig.exposedHeaders,
    maxAge: corsConfig.maxAge,
    // 204 for OPTIONS. Some older clients choke on 200 with no body.
    optionsSuccessStatus: 204,
  });

  return (req, res, next) => {
    handler(req, res, (error) => {
      if (!error) return next();

      if (ApiError.is(error)) {
        error.traceId ||= req.traceId ?? '';
        req.log?.warn({ origin: req.get('origin') }, 'cors rejected');
      }
      next(error);
    });
  };
};

export default corsMiddleware;