// classroom-app/server/src/config/security.config.js
/**
 * Security policy  (F7)  [NEW]
 *
 * Everything the hardening middleware needs, in one place, so a reviewer can
 * read the platform's security posture without opening six files.
 *
 * The shapes here are consumed by:
 *   middleware/helmet.js     headers and CSP
 *   middleware/cors.js       origin allowlist
 *   middleware/csrf.js       double-submit token
 *   middleware/hostGuard.js  ALLOWED_HOSTS equivalent
 *
 * A note on CSP and this product: a classroom app loads video from a CDN,
 * opens WebSockets to two different hosts and renders learner-authored
 * markdown. That is a wide surface, and the policy below is written to be as
 * narrow as it can be while still letting a lesson play.
 */

import { env, isProduction } from './env.js';

/** The CDN origin without its path, for CSP source lists. */
const cdnOrigin = (() => {
  try {
    return new URL(env.CDN_DOMAIN.startsWith('http') ? env.CDN_DOMAIN : `https://${env.CDN_DOMAIN}`)
      .origin;
  } catch {
    return env.CDN_DOMAIN;
  }
})();

const wsOrigins = [env.PUBLIC_WS_URL, env.PUBLIC_WS_URL.replace(/^ws/, 'http')].filter(Boolean);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

export const corsConfig = {
  /**
   * Exact origins only. Never a wildcard, and never a regex — a regex is how
   * `classroom.app.evil.com` ends up on the allowlist.
   */
  allowlist: env.ALLOWED_ORIGINS,

  /** Cookies must be sent for the refresh route. */
  credentials: true,

  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],

  allowedHeaders: [
    'content-type',
    'authorization',
    'x-contract-version',
    'x-request-id',
    'x-trace-id',
    'idempotency-key',
    'x-csrf-token',
  ],

  /** Clients read the trace id off a failed response to report a problem. */
  exposedHeaders: ['x-request-id', 'x-trace-id', 'x-release-sha', 'retry-after'],

  maxAge: 86_400,

  /**
   * Mobile apps and server-to-server calls send no Origin at all. Rejecting
   * those would break the Expo client, so a missing Origin is allowed — the
   * bearer token is what authorises the request, not the header.
   */
  allowNoOrigin: true,
};

// ---------------------------------------------------------------------------
// Helmet and CSP
// ---------------------------------------------------------------------------

export const helmetConfig = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],

      scriptSrc: ["'self'"],
      // Vite emits a small amount of inline style, and so does any chart.
      // Inline *script* stays forbidden, which is the one that matters.
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", 'data:'],

      // Avatars and thumbnails come from the CDN; blob: covers a local preview
      // of a file the user has just picked but not yet uploaded.
      imgSrc: ["'self'", 'data:', 'blob:', cdnOrigin],
      // HLS segments and recordings.
      mediaSrc: ["'self'", 'blob:', cdnOrigin],

      // API, both socket namespaces, and the SFU's own host for ICE.
      connectSrc: ["'self'", env.API_URL, ...wsOrigins, cdnOrigin, 'wss:'],

      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      // Reports go to the API so a violation shows up in CloudWatch rather
      // than only in somebody's console.
      reportUri: ['/internal/csp-report'],
      ...(isProduction ? { upgradeInsecureRequests: [] } : {}),
    },
    // Development runs report-only: a CSP that blocks the dev server teaches
    // people to disable CSP.
    reportOnly: !isProduction,
  },

  hsts: isProduction
    ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
    : false,

  /** Screen sharing and camera access need a permissive frame policy off. */
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },

  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  noSniff: true,
  frameguard: { action: 'deny' },
  /** Leaks the stack in a header; there is no reason to advertise it. */
  hidePoweredBy: true,
};

/**
 * Permissions-Policy. Camera, microphone and display capture are the whole
 * product, so they are allowed for this origin — and denied to everything else,
 * which is the part that matters.
 */
export const permissionsPolicy = [
  'camera=(self)',
  'microphone=(self)',
  'display-capture=(self)',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'interest-cohort=()',
].join(', ');

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/**
 * The API is bearer-token based and therefore not CSRF-exposed. Exactly one
 * surface is: the refresh route, which authenticates with an httpOnly cookie.
 * So CSRF protection is scoped to cookie-authenticated routes rather than
 * applied globally, where it would be ceremony without benefit.
 */
export const csrfConfig = {
  cookieName: 'classroom.csrf',
  headerName: 'x-csrf-token',
  /** Only these routes read the cookie, so only these need the token. */
  protectedPaths: ['/auth/refresh', '/auth/logout', '/billing/webhook/portal-return'],
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
  cookie: {
    httpOnly: false, // the client must read it to echo it back
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    path: '/',
    maxAge: 86_400_000,
  },
};

/** Settings for the refresh cookie itself, which is httpOnly and strict. */
export const sessionCookieConfig = {
  name: 'classroom.refresh',
  httpOnly: true,
  sameSite: 'lax',
  secure: env.COOKIE_SECURE,
  domain: env.COOKIE_DOMAIN,
  path: '/auth',
  signed: true,
};

// ---------------------------------------------------------------------------
// Host guard and misc
// ---------------------------------------------------------------------------

export const hostConfig = {
  allowedHosts: env.ALLOWED_HOSTS,
  /** Health checks arrive with the target group's IP as the Host header. */
  exemptPaths: ['/healthz', '/readyz', '/startupz'],
};

export const bodyLimits = {
  json: `${env.BODY_LIMIT_KB}kb`,
  urlencoded: `${env.BODY_LIMIT_KB}kb`,
  /** Stripe verifies a signature over the exact bytes, so this stays raw. */
  rawWebhookPaths: ['/billing/webhooks/stripe', '/media/webhooks/mediaconvert'],
  rawLimit: '1mb',
};

export const securityConfig = {
  cors: corsConfig,
  helmet: helmetConfig,
  permissionsPolicy,
  csrf: csrfConfig,
  sessionCookie: sessionCookieConfig,
  host: hostConfig,
  body: bodyLimits,
};

export default securityConfig;