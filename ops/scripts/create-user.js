#!/usr/bin/env node
/**
 * ops/scripts/create-user.js
 *
 * Creates the first account by calling AuthService.register directly.
 *
 * There is no HTTP registration route — auth.routes.js exposes login, refresh,
 * logout and devices, and nothing else. In production that is correct: accounts
 * arrive through an invitation or a tenant provisioning flow, not through an
 * open endpoint. But it leaves development with no way to get a first user, and
 * a database with no users is a product you cannot sign in to.
 *
 * It also seeds a tenant, because register() does not. Every table from
 * 002_identity.sql onward hangs off `tenants(id)`, and 001_init.sql creates the
 * table without a row in it — so on a freshly migrated database the very first
 * insert into `users` fails on a foreign key that has nothing to point at.
 * Explaining that in an error message is worse than simply not causing it.
 *
 * Usage:
 *   node --env-file=.env ops/scripts/create-user.js
 *   node --env-file=.env ops/scripts/create-user.js \
 *     --email=learner@classroom.local --password='dev-password-123' --name='Demo Learner'
 *
 * Refuses to run against production. Convenience is precisely the property you
 * do not want anywhere near real accounts.
 */

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    name: { type: 'string' },
    locale: { type: 'string', default: 'en' },
    timezone: { type: 'string', default: 'Europe/Berlin' },
    tenant: { type: 'string', default: 'Development' },
  },
});

const { env } = await import('../../server/src/config/env.js');

if (env.NODE_ENV === 'production') {
  console.error('create-user.js will not run against production.');
  process.exit(1);
}

const email = values.email ?? 'teacher@classroom.local';
const password = values.password ?? 'dev-password-123';
const displayName = values.name ?? 'Demo Teacher';

const { pool } = await import('../../server/src/db/pool.js');
const { redis } = await import('../../server/src/db/redis.js');
const AuthService = await import('../../server/src/identity/AuthService.js');

/**
 * Idempotent: the slug is unique, so a second run returns the existing row
 * rather than failing or creating a duplicate.
 */
const ensureTenant = async () => {
  const { rows } = await pool.query(
    `INSERT INTO tenants (name, slug, status)
          VALUES ($1, $2, 'active')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, slug`,
    [values.tenant, 'development'],
  );
  return rows[0];
};

try {
  const tenant = await ensureTenant();
  console.log(`\nTenant ready: ${tenant.name} (${tenant.id})`);

  const result = await AuthService.register({
    email,
    password,
    displayName,
    locale: values.locale,
    timeZone: values.timezone,
    // register() starts a session immediately, and startSession wants a device.
    device: { platform: 'web', model: 'create-user.js' },
    // Passed in case Users.create expects it. Harmless if it does not — an
    // unknown key in an options object costs nothing, and guessing wrong in
    // the other direction costs a failed insert nobody can read.
    tenantId: tenant.id,
  });

  console.log('\nAccount created.\n');
  console.log(`  email        ${email}`);
  console.log(`  password     ${password}`);
  console.log(`  userId       ${result.user?.userId ?? result.user?.id ?? '(unknown)'}`);
  console.log(`  displayName  ${displayName}`);
  console.log('\nSign in at http://localhost:5173/login\n');
} catch (cause) {
  // Only a genuine conflict is "nothing to do". Matching on the message text
  // was the earlier mistake here: "relation ... does not exist" contains the
  // word "exist", so a broken schema reported itself as a duplicate account
  // and the real failure stayed hidden.
  if (cause?.code === 'conflict' || cause?.code === '23505') {
    console.log(`\nAn account for ${email} already exists. Nothing to do.\n`);
  } else {
    console.error('\nCould not create the account.\n');
    console.error(`  message  ${cause?.message ?? cause}`);
    if (cause?.code) console.error(`  code     ${cause.code}`);
    // Postgres attaches these, and together they usually name the exact column
    // or constraint that rejected the row.
    if (cause?.detail) console.error(`  detail   ${cause.detail}`);
    if (cause?.table) console.error(`  table    ${cause.table}`);
    if (cause?.column) console.error(`  column   ${cause.column}`);
    if (cause?.constraint) console.error(`  constraint ${cause.constraint}`);
    if (cause?.errors) console.error(`  policy   ${cause.errors.join('\n           ')}`);
    console.error('');
    if (cause?.stack) console.error(cause.stack);
    process.exitCode = 1;
  }
} finally {
  // The pools keep the event loop alive; without this the script hangs after
  // printing its result, which looks like a failure and is not.
  await pool.end().catch(() => {});
  redis.disconnect?.();
}