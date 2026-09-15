// classroom-app/server/src/app.js
/**
 * Express application  (F7)  [EXT]
 *
 * Builds the middleware chain and mounts the routes. It creates no server and
 * opens no ports — server.js does that — so tests can exercise the whole HTTP
 * surface without binding anything.
 *
 * The order below is the security posture of the product, and every step is
 * where it is for a reason:
 *
 *   1. trust proxy      before anything reads an IP, or every request appears
 *                       to come from the load balancer and rate limiting
 *                       becomes a global counter
 *   2. request context  before logging, so every line carries the trace id
 *   3. health           before auth, hosts and rate limits: a probe must never
 *                       be rejected because a dependency of the auth path is
 *                       having a bad day
 *   4. helmet, CORS     before any handler runs
 *   5. host guard       before body parsing, so a misrouted request costs
 *                       nothing
 *   6. raw webhooks     before the JSON parser, because signatures are computed
 *                       over exact bytes
 *   7. JSON parsing     with a small limit; files never travel through the API
 *   8. cookies          after parsing, before the routes that read them
 *   9. rate limits      after identification, so a signed-in user is limited as
 *                       a user rather than as an IP
 *  10. routes
 *  11. notFound, errorHandler   last, in that order
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import { env, isProduction } from './config/env.js';

import { requestContext } from './middleware/requestContext.js';
import { helmetMiddleware } from './middleware/helmet.js';
import { corsMiddleware } from './middleware/cors.js';
import { hostGuard } from './middleware/hostGuard.js';
import { rateLimit } from './middleware/rateLimit.js';
import { csrfProtection } from './middleware/csrf.js';
import { rawWebhookParsers, bodyParsers } from './middleware/bodyLimits.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';

import healthRoutes from './routes/health.routes.js';
import authRoutes from './routes/auth.routes.js';
import billingRoutes from './routes/billing.routes.js';
import classroomRoutes from './routes/classroom.routes.js';
import routeResolveRoutes from './routes/route-resolve.routes.js';
import courseRoutes from './routes/course.routes.js';
import progressRoutes from './routes/progress.routes.js';
import communityRoutes from './routes/community.routes.js';
import mediaRoutes from './routes/media.routes.js';
import assignmentRoutes from './routes/assignment.routes.js';
import messagingRoutes from './routes/messaging.routes.js';
import profileRoutes from './routes/profile.routes.js';

export const createApp = () => {
  const app = express();

  // -------------------------------------------------------------------------
  // 1. Proxy trust
  // -------------------------------------------------------------------------
  // A number, not `true`. Trusting every hop lets a client spoof its own IP by
  // sending an X-Forwarded-For header; trusting exactly the ALB does not.
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.set('etag', false);

  // -------------------------------------------------------------------------
  // 2. Request context
  // -------------------------------------------------------------------------
  app.use(requestContext());

  // -------------------------------------------------------------------------
  // 3. Health, ahead of everything that can reject a request
  // -------------------------------------------------------------------------
  app.use(healthRoutes);

  // -------------------------------------------------------------------------
  // 4. Headers and origins
  // -------------------------------------------------------------------------
  app.use(helmetMiddleware());
  app.use(corsMiddleware());

  // -------------------------------------------------------------------------
  // 5. Host allowlist
  // -------------------------------------------------------------------------
  app.use(hostGuard());

  // -------------------------------------------------------------------------
  // 6. Raw bodies for signature-verified webhooks
  // -------------------------------------------------------------------------
  // Stripe signs the exact bytes it sent. Parsing to JSON and re-serialising
  // changes them, and the signature check then fails for reasons that take a
  // day to find.
  for (const [path, parser] of rawWebhookParsers()) {
    app.use(path, parser);
  }

  // -------------------------------------------------------------------------
  // 7. Body parsing
  // -------------------------------------------------------------------------
  // Rejects multipart, then parses JSON and urlencoded under the configured
  // caps. Files never travel through the API.
  app.use(bodyParsers());

  // -------------------------------------------------------------------------
  // 8. Cookies
  // -------------------------------------------------------------------------
  // auth.routes.js writes the refresh token with `signed: true` and reads it
  // back from req.signedCookies, which does not exist without this. Symptom
  // when it is missing: every refresh answers "No refresh token presented",
  // so a reload always signs the user out.
  app.use(cookieParser(env.COOKIE_SECRET));

  // -------------------------------------------------------------------------
  // 9. Abuse controls
  // -------------------------------------------------------------------------
  app.use(rateLimit());
  // Scoped to the cookie-authenticated routes; the bearer-token API does not
  // need it and would only pay the cost. Called, not passed — the export is a
  // factory, and handing Express the factory itself hangs every request it
  // guards.
  app.use(csrfProtection());

  // -------------------------------------------------------------------------
  // 10. Routes
  // -------------------------------------------------------------------------
  app.use('/auth', authRoutes);
  app.use('/profiles', profileRoutes);
  app.use('/billing', billingRoutes);
  app.use('/rooms', routeResolveRoutes);
  app.use('/classroom', classroomRoutes);
  app.use('/courses', courseRoutes);
  app.use('/progress', progressRoutes);
  app.use('/community', communityRoutes);
  app.use('/media', mediaRoutes);
  app.use('/assignments', assignmentRoutes);
  app.use('/messaging', messagingRoutes);

  // CSP violation reports. Accepted and logged, never acted on automatically.
  app.post('/internal/csp-report', (req, res) => {
    req.log?.warn({ report: req.body }, 'csp violation');
    res.status(204).end();
  });

  // -------------------------------------------------------------------------
  // 11. Fallbacks
  // -------------------------------------------------------------------------
  app.use(notFound());
  app.use(errorHandler({ exposeStack: !isProduction }));

  return app;
};

export default createApp;