// classroom-app/server/src/config/env.js
/**
 * Environment configuration  (F7)  [EXT]
 *
 * The single source of truth for every runtime setting. Importing this module
 * validates the environment and, on failure, prints what is wrong and exits.
 * That is the whole point: a process that boots with a missing S3 bucket and
 * discovers it during a learner's upload is worse than one that never booted.
 *
 * Two rules keep this honest:
 *
 *   1. Every variable in .env.example appears here, and nothing else does.
 *      `ops/scripts/check-env-schema.js` compares the two in CI and fails the
 *      build on drift, which is why the shape below is exported as well.
 *
 *   2. Secrets are already in process.env by the time this runs. In AWS they
 *      arrive from Secrets Manager via config/secrets.js, called from the
 *      bootstrap before this module is imported. This file never fetches.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

/** '1', 'true', 'yes' are true; everything else is false. */
const bool = (defaultValue) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined) return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    });

const int = (defaultValue, { min, max } = {}) => {
  let schema = z.coerce.number().int();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return defaultValue === undefined ? schema : schema.default(defaultValue);
};

/** Comma-separated list into a trimmed array, empties dropped. */
const csv = (defaultValue = []) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? defaultValue
        : value
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
    );

/** base64-encoded PEM, so a key survives a single-line environment variable. */
const pem = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (!value) return null;
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      if (!decoded.includes('-----BEGIN')) throw new Error('not a PEM');
      return decoded;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a base64-encoded PEM block' });
      return z.NEVER;
    }
  });

const duration = z.string().regex(/^\d+[smhd]$/, 'e.g. 15m, 30d');

// ---------------------------------------------------------------------------
// Schema — mirrors .env.example section for section
// ---------------------------------------------------------------------------

export const envSchema = z
  .object({
    // --- runtime ----------------------------------------------------------
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(4000, { min: 1, max: 65535 }),
    APP_URL: z.url(),
    API_URL: z.url(),
    PUBLIC_WS_URL: z.string().min(1),
    ALLOWED_ORIGINS: csv(),
    ALLOWED_HOSTS: csv(['localhost']),
    TRUST_PROXY: int(0, { min: 0, max: 10 }),
    RELEASE_SHA: z.string().default('local'),

    // --- auth (secret) ----------------------------------------------------
    JWT_PRIVATE_KEY: pem,
    JWT_PUBLIC_KEY: pem,
    JWT_ACCESS_TTL: duration.default('15m'),
    REFRESH_TTL: duration.default('30d'),
    JWT_ISSUER: z.string().default('classroom-app'),
    JWT_AUDIENCE: z.string().default('classroom-clients'),
    COOKIE_SECRET: z.string().min(16),
    COOKIE_DOMAIN: z.string().default('localhost'),
    COOKIE_SECURE: bool(false),

    // --- database ---------------------------------------------------------
    DATABASE_URL: z.string().startsWith('postgres'),
    DATABASE_READ_URL: z.string().optional().default(''),
    PGSSLMODE: z.enum(['disable', 'require', 'verify-full']).default('require'),
    PG_POOL_MAX: int(10, { min: 1, max: 100 }),
    PG_POOL_IDLE_TIMEOUT_MS: int(30_000),
    PG_STATEMENT_TIMEOUT_MS: int(15_000, { min: 1_000 }),
    PG_CONNECTION_TIMEOUT_MS: int(5_000),

    // --- redis ------------------------------------------------------------
    REDIS_URL: z.string().startsWith('redis'),
    REDIS_TLS: bool(false),
    REDIS_PREFIX: z.string().default('classroom'),

    // --- storage ----------------------------------------------------------
    AWS_REGION: z.string().default('eu-central-1'),
    S3_BUCKET_RAW: z.string().min(1),
    S3_BUCKET_QUARANTINE: z.string().min(1),
    S3_BUCKET_DELIVERY: z.string().min(1),
    S3_ENDPOINT: z.string().optional().default(''),
    S3_FORCE_PATH_STYLE: bool(false),
    AWS_ACCESS_KEY_ID: z.string().optional().default(''),
    AWS_SECRET_ACCESS_KEY: z.string().optional().default(''),
    CDN_DOMAIN: z.string().min(1),
    CDN_KEY_PAIR_ID: z.string().optional().default(''),
    CDN_PRIVATE_KEY: pem,
    CDN_SIGNED_URL_TTL_SEC: int(300, { min: 30, max: 86_400 }),
    MAX_UPLOAD_MB: int(2048, { min: 1 }),
    MEDIACONVERT_ROLE_ARN: z.string().optional().default(''),
    MEDIACONVERT_ENDPOINT: z.string().optional().default(''),
    MEDIACONVERT_QUEUE_ARN: z.string().optional().default(''),
    ANTIVIRUS_MODE: z.enum(['disabled', 'clamav', 'lambda']).default('disabled'),
    CLAMAV_HOST: z.string().default('localhost'),
    CLAMAV_PORT: int(3310),

    // --- sfu --------------------------------------------------------------
    SFU_HTTP_PORT: int(4200, { min: 1, max: 65535 }),
    SFU_NODE_ID: z.string().default('sfu-local-1'),
    MEDIASOUP_MIN_PORT: int(40_000, { min: 1024, max: 65535 }),
    MEDIASOUP_MAX_PORT: int(40_100, { min: 1024, max: 65535 }),
    ANNOUNCED_IP: z.string().default('127.0.0.1'),
    MEDIASOUP_WORKERS: int(0, { min: 0, max: 64 }),
    SFU_MAX_ROOMS_PER_NODE: int(40, { min: 1 }),
    SFU_DRAIN_TIMEOUT_SEC: int(1_800, { min: 0 }),
    TURN_URL: z.string().optional().default(''),
    TURN_SECRET: z.string().optional().default(''),
    TURN_CREDENTIAL_TTL_SEC: int(86_400),
    SCREENSHARE_MAX_PRESENTERS: int(1, { min: 1, max: 4 }),
    SCREENSHARE_MAX_BITRATE_KBPS: int(2_500, { min: 200 }),
    SCREENSHARE_MAX_FRAMERATE: int(15, { min: 1, max: 60 }),
    RECORDING_ENABLED: bool(false),
    RECORDING_RETENTION_DAYS: int(90, { min: 1 }),

    // --- realtime ---------------------------------------------------------
    REALTIME_PORT: int(4100, { min: 1, max: 65535 }),
    SOCKET_PING_INTERVAL_MS: int(25_000),
    SOCKET_PING_TIMEOUT_MS: int(20_000),
    SOCKET_MAX_EVENTS_PER_MIN: int(240, { min: 1 }),
    PRESENCE_TTL_SEC: int(60, { min: 10 }),

    // --- messaging --------------------------------------------------------
    CHAT_MAX_MESSAGE_LEN: int(4_000, { min: 1, max: 10_000 }),
    CHAT_RATE_PER_MIN: int(30, { min: 1 }),
    CHAT_ATTACHMENT_MAX_MB: int(100, { min: 1 }),
    CHAT_RETENTION_DAYS: int(0, { min: 0 }),
    CHAT_SLOW_MODE_SEC: int(0, { min: 0, max: 21_600 }),
    CHAT_EDIT_WINDOW_MIN: int(15, { min: 0 }),
    CHAT_DEFAULT_DM_POLICY: z.enum(['anyone', 'shared-context', 'nobody']).default('shared-context'),

    // --- notifications ----------------------------------------------------
    MAIL_TRANSPORT: z.enum(['smtp', 'ses']).default('smtp'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: int(1025),
    SES_FROM: z.email().or(z.string().min(1)),
    SES_REGION: z.string().default('eu-central-1'),
    SNS_PLATFORM_APP_APNS: z.string().optional().default(''),
    SNS_PLATFORM_APP_FCM: z.string().optional().default(''),
    NOTIFY_PUSH_DELAY_MIN: int(2, { min: 0 }),
    DIGEST_SEND_HOUR_UTC: int(6, { min: 0, max: 23 }),

    // --- billing ----------------------------------------------------------
    STRIPE_SECRET_KEY: z.string().optional().default(''),
    STRIPE_WEBHOOK_SECRET: z.string().optional().default(''),
    STRIPE_PRICE_MAP: z
      .string()
      .default('{}')
      .transform((value, ctx) => {
        try {
          return JSON.parse(value);
        } catch {
          ctx.addIssue({ code: 'custom', message: 'must be a JSON object' });
          return z.NEVER;
        }
      }),
    BILLING_ENTITLEMENT_TTL_SEC: int(60, { min: 5 }),

    // --- search -----------------------------------------------------------
    OPENSEARCH_URL: z.string().optional().default(''),
    OPENSEARCH_INDEX_PREFIX: z.string().default('classroom'),
    SEARCH_ENABLED: bool(false),

    // --- background work --------------------------------------------------
    WORKER_CONCURRENCY: int(5, { min: 1, max: 100 }),
    QUEUE_ATTEMPTS: int(5, { min: 1 }),
    QUEUE_BACKOFF_MS: int(5_000, { min: 100 }),
    QUEUE_KEEP_COMPLETED: int(1_000, { min: 0 }),
    QUEUE_KEEP_FAILED: int(5_000, { min: 0 }),

    // --- observability ----------------------------------------------------
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    LOG_PRETTY: bool(false),
    SERVICE_NAME: z.string().default('classroom-api'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional().default(''),
    OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(0.1),
    METRICS_ENABLED: bool(true),

    // --- limits and hardening ---------------------------------------------
    BODY_LIMIT_KB: int(256, { min: 1 }),
    RATE_LIMIT_WINDOW_SEC: int(60, { min: 1 }),
    RATE_LIMIT_MAX_PER_IP: int(300, { min: 1 }),
    RATE_LIMIT_MAX_PER_USER: int(600, { min: 1 }),
    SHUTDOWN_GRACE_SEC: int(25, { min: 0 }),
    READINESS_TIMEOUT_MS: int(2_000, { min: 100 }),
  })
  // --- cross-field rules the individual fields cannot express --------------
  .refine((env) => env.MEDIASOUP_MAX_PORT > env.MEDIASOUP_MIN_PORT, {
    error: 'MEDIASOUP_MAX_PORT must be greater than MEDIASOUP_MIN_PORT',
    path: ['MEDIASOUP_MAX_PORT'],
  })
  .refine((env) => env.CHAT_ATTACHMENT_MAX_MB <= env.MAX_UPLOAD_MB, {
    error: 'CHAT_ATTACHMENT_MAX_MB cannot exceed MAX_UPLOAD_MB',
    path: ['CHAT_ATTACHMENT_MAX_MB'],
  })
  .refine((env) => env.SOCKET_PING_TIMEOUT_MS < env.SOCKET_PING_INTERVAL_MS * 2, {
    error: 'SOCKET_PING_TIMEOUT_MS must stay below twice the ping interval',
    path: ['SOCKET_PING_TIMEOUT_MS'],
  })
  // Production has stricter minimums. Development is allowed to be sloppy;
  // production is not, and the difference is enforced here rather than trusted.
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    const required = [
      ['JWT_PRIVATE_KEY', env.JWT_PRIVATE_KEY],
      ['JWT_PUBLIC_KEY', env.JWT_PUBLIC_KEY],
      ['CDN_KEY_PAIR_ID', env.CDN_KEY_PAIR_ID],
      ['CDN_PRIVATE_KEY', env.CDN_PRIVATE_KEY],
    ];
    for (const [name, value] of required) {
      if (!value) ctx.addIssue({ code: 'custom', message: `${name} is required in production`, path: [name] });
    }

    if (env.ALLOWED_ORIGINS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'ALLOWED_ORIGINS cannot be empty in production',
        path: ['ALLOWED_ORIGINS'],
      });
    }
    if (env.ALLOWED_ORIGINS.includes('*')) {
      ctx.addIssue({ code: 'custom', message: 'wildcard origins are not allowed', path: ['ALLOWED_ORIGINS'] });
    }
    if (env.PGSSLMODE === 'disable') {
      ctx.addIssue({ code: 'custom', message: 'TLS to the database is mandatory', path: ['PGSSLMODE'] });
    }
    if (!env.COOKIE_SECURE) {
      ctx.addIssue({ code: 'custom', message: 'COOKIE_SECURE must be true behind HTTPS', path: ['COOKIE_SECURE'] });
    }
    if (env.COOKIE_SECRET.startsWith('dev-')) {
      ctx.addIssue({ code: 'custom', message: 'the development cookie secret is still set', path: ['COOKIE_SECRET'] });
    }
    if (env.S3_ENDPOINT) {
      ctx.addIssue({
        code: 'custom',
        message: 'S3_ENDPOINT is a MinIO setting and must be empty in production',
        path: ['S3_ENDPOINT'],
      });
    }
    if (env.ANNOUNCED_IP === '127.0.0.1') {
      ctx.addIssue({ code: 'custom', message: 'ANNOUNCED_IP must be reachable by clients', path: ['ANNOUNCED_IP'] });
    }
    if (env.LOG_PRETTY) {
      ctx.addIssue({ code: 'custom', message: 'production logs must be JSON', path: ['LOG_PRETTY'] });
    }
  });

// ---------------------------------------------------------------------------
// Parse, or die
// ---------------------------------------------------------------------------

/**
 * Exported so tests and ops/scripts/check-env-schema.js can validate an
 * arbitrary object without touching process.env or exiting the process.
 */
export const parseEnv = (source = process.env) => envSchema.safeParse(source);

const result = parseEnv();

if (!result.success) {
  // Deliberately console, not the logger: the logger is configured from the
  // very values that just failed to parse.
  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  console.error(
    [
      '',
      'Invalid environment configuration. The process will not start.',
      '',
      issues,
      '',
      'Compare your environment against .env.example.',
      '',
    ].join('\n'),
  );
  process.exit(78); // EX_CONFIG
}

export const env = Object.freeze(result.data);

// Convenience flags, so nothing has to compare strings in a hot path.
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

export default env;