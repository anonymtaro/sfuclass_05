// classroom-app/server/src/config/secrets.js
/**
 * Secrets loader  (F7)  [NEW]
 *
 * Pulls secrets from AWS Secrets Manager and puts them into process.env before
 * config/env.js is imported. That ordering is the entire design:
 *
 *   bootstrap  →  hydrateSecrets()  →  import('./config/env.js')  →  everything else
 *
 * Which is why server.js and worker.js import env.js dynamically. A static
 * import would run env validation before the secrets exist.
 *
 * Why not put secrets straight into the task definition? Because a task
 * definition is a versioned, readable document, and a rotated secret would mean
 * a new revision and a redeploy. Here a rotation is a new secret version and a
 * restart, and the value never appears in an image, in git, or in the console.
 *
 * Locally this is a no-op: there is no Secrets Manager, .env already holds
 * development values, and nothing here should require AWS credentials to run
 * `npm run dev`.
 */

/**
 * Environment variable ← secret name. Only these are ever fetched; a secret
 * that is not listed cannot leak in through a misconfigured environment.
 *
 * The `{env}` placeholder is replaced with the deployment environment, so one
 * table serves staging and production.
 */
const SECRET_MAP = {
  JWT_PRIVATE_KEY: 'classroom/{env}/jwt/private-key',
  JWT_PUBLIC_KEY: 'classroom/{env}/jwt/public-key',
  COOKIE_SECRET: 'classroom/{env}/cookie-secret',
  DATABASE_URL: 'classroom/{env}/database/url',
  DATABASE_READ_URL: 'classroom/{env}/database/read-url',
  REDIS_URL: 'classroom/{env}/redis/url',
  CDN_PRIVATE_KEY: 'classroom/{env}/cdn/private-key',
  CDN_KEY_PAIR_ID: 'classroom/{env}/cdn/key-pair-id',
  STRIPE_SECRET_KEY: 'classroom/{env}/stripe/secret-key',
  STRIPE_WEBHOOK_SECRET: 'classroom/{env}/stripe/webhook-secret',
  TURN_SECRET: 'classroom/{env}/turn/secret',
  OPENSEARCH_URL: 'classroom/{env}/opensearch/url',
};

/** Secrets whose absence is fatal in production. The rest may be empty. */
const REQUIRED_IN_PRODUCTION = [
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'COOKIE_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
];

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map(); // secretName -> { value, fetchedAt }

let client = null;

/**
 * The SDK is imported lazily so a development machine never loads it, and so a
 * missing dependency cannot break `npm run dev`.
 */
const getClient = async (region) => {
  if (client) return client;
  const { SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
  client = new SecretsManagerClient({ region });
  return client;
};

const fetchSecret = async (name, region) => {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;

  const { GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const sm = await getClient(region);
  const response = await sm.send(new GetSecretValueCommand({ SecretId: name }));

  // Binary secrets are base64 in SecretBinary; string secrets are plain.
  const value =
    response.SecretString ??
    (response.SecretBinary ? Buffer.from(response.SecretBinary).toString('utf8') : null);

  if (value === null) throw new Error(`Secret ${name} has no value`);
  cache.set(name, { value, fetchedAt: Date.now() });
  return value;
};

/**
 * Fetches every mapped secret and writes it into process.env.
 *
 * An existing environment variable always wins. That is what lets a deployment
 * override one value without editing the map, and what lets tests inject fakes
 * without touching AWS.
 *
 * @param {{ environment?: string, region?: string, enabled?: boolean }} options
 * @returns {Promise<{ loaded: string[], skipped: string[] }>}
 */
export const hydrateSecrets = async (options = {}) => {
  const environment = options.environment ?? process.env.DEPLOY_ENV ?? process.env.NODE_ENV ?? 'development';
  const region = options.region ?? process.env.AWS_REGION ?? 'eu-central-1';

  // Default off outside production: no AWS calls, no credentials needed.
  const enabled = options.enabled ?? process.env.SECRETS_SOURCE === 'aws';

  if (!enabled) {
    return { loaded: [], skipped: Object.keys(SECRET_MAP) };
  }

  const loaded = [];
  const skipped = [];
  const failures = [];

  // Parallel: a dozen sequential round trips would add real seconds to a cold
  // start, and a cold start happens on every scale-out event.
  await Promise.all(
    Object.entries(SECRET_MAP).map(async ([variable, template]) => {
      if (process.env[variable]) {
        skipped.push(variable);
        return;
      }
      const name = template.replace('{env}', environment);
      try {
        process.env[variable] = await fetchSecret(name, region);
        loaded.push(variable);
      } catch (cause) {
        failures.push({ variable, name, message: cause?.message ?? 'unknown error' });
      }
    }),
  );

  const fatal = failures.filter(
    (failure) => environment === 'production' && REQUIRED_IN_PRODUCTION.includes(failure.variable),
  );

  if (fatal.length > 0) {
    // console, not the logger: the logger is not configured yet.
    console.error(
      [
        '',
        'Could not load required secrets. The process will not start.',
        ...fatal.map((failure) => `  ${failure.variable} (${failure.name}): ${failure.message}`),
        '',
      ].join('\n'),
    );
    process.exit(78); // EX_CONFIG, same as an invalid environment
  }

  for (const failure of failures) {
    console.warn(`optional secret unavailable: ${failure.variable} (${failure.message})`);
  }

  return { loaded, skipped };
};

/**
 * Re-reads one secret, bypassing the cache. Used by a rotation handler that
 * wants to pick up a new value without a restart; nothing calls it on a timer,
 * because a rotation is rare and a restart is cheap.
 */
export const refreshSecret = async (variable, options = {}) => {
  const template = SECRET_MAP[variable];
  if (!template) throw new Error(`${variable} is not a managed secret`);

  const environment = options.environment ?? process.env.DEPLOY_ENV ?? 'development';
  const region = options.region ?? process.env.AWS_REGION ?? 'eu-central-1';
  const name = template.replace('{env}', environment);

  cache.delete(name);
  const value = await fetchSecret(name, region);
  process.env[variable] = value;
  return value;
};

/** Exported for the CI check and for tests; never mutated at runtime. */
export const managedSecrets = Object.freeze(Object.keys(SECRET_MAP));

export default hydrateSecrets;