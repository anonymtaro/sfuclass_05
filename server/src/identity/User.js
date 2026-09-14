// classroom-app/server/src/identity/User.js
/**
 * User accounts  (F5)  [NEW]
 *
 * The account: credentials, role, status. Everything a person *shows* — name,
 * avatar, bio — is in Profile.js, because those are read constantly by other
 * people and these are read only by the auth path.
 *
 * Password hashing uses scrypt from Node's standard library rather than argon2.
 * argon2 is the better algorithm and needs a native module; scrypt is
 * memory-hard, in core, and has no build step. The parameters below are tuned
 * to roughly 100 ms per hash on the API instance size — slow enough to make
 * offline cracking expensive, fast enough that a login is not noticeable.
 *
 * If you already depend on argon2, swap `hashPassword` and `verifyPassword`;
 * the stored format is prefixed so both can coexist during a migration.
 */

import { randomBytes, scrypt, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'users' });
const scryptAsync = promisify(scrypt);

/** N=2^15, r=8, p=1. Raise N as hardware improves; the prefix records it. */
const SCRYPT = { N: 32_768, r: 8, p: 1, keylen: 64 };

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/** `scrypt$N$r$p$salt$hash` — self-describing, so parameters can change. */
export const hashPassword = async (password) => {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });

  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
};

export const verifyPassword = async (password, stored) => {
  if (!stored?.startsWith('scrypt$')) return false;

  const [, N, r, p, salt, hash] = stored.split('$');

  const derived = await scryptAsync(password, Buffer.from(salt, 'base64'), Buffer.from(hash, 'base64').length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });

  const expected = Buffer.from(hash, 'base64');
  // Constant time: a length check first is safe, a byte comparison is not.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
};

/** True when a stored hash was made with weaker parameters than the current. */
export const needsRehash = (stored) => {
  if (!stored?.startsWith('scrypt$')) return true;
  const [, N] = stored.split('$');
  return Number(N) < SCRYPT.N;
};

/**
 * Minimum viable password policy: length, and nothing else.
 *
 * Composition rules — one capital, one digit, one symbol — produce `Password1!`
 * and make people write passwords down. Length is the only requirement that
 * reliably increases entropy, and the common-password check catches the rest.
 */
export const validatePassword = (password, { email = '', displayName = '' } = {}) => {
  const errors = [];

  if (!password || password.length < 12) {
    errors.push('Use at least 12 characters.');
  }
  if (password && password.length > 256) {
    // Not a policy: a 4 MB password is a denial-of-service against scrypt.
    errors.push('That is too long.');
  }

  const lowered = (password ?? '').toLowerCase();
  const localPart = email.split('@')[0]?.toLowerCase();

  if (localPart && localPart.length > 3 && lowered.includes(localPart)) {
    errors.push('Do not use your email address in your password.');
  }
  if (displayName && displayName.length > 3 && lowered.includes(displayName.toLowerCase())) {
    errors.push('Do not use your name in your password.');
  }
  if (COMMON.has(lowered)) {
    errors.push('That password is too common.');
  }

  return { valid: errors.length === 0, errors };
};

/** A token gesture. A real deployment checks against a breach corpus. */
const COMMON = new Set([
  'password', 'password123', 'passwort', '123456789012', 'qwertyuiop',
  'letmein12345', 'administrator', 'welcome12345', 'classroom123',
]);

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export const rowToUser = (row) => ({
  userId: row.id,
  email: row.email,
  emailVerified: row.email_verified,
  displayName: row.display_name,
  avatarUrl: row.avatar_url,
  role: row.role,
  status: row.status,
  locale: row.locale,
  timeZone: row.time_zone,
  billingCustomerRef: row.billing_customer_ref,
  lastLoginAt: row.last_login_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** Never includes the password hash. Callers that need it ask explicitly. */
const SELECT = `
  SELECT id, email, email_verified, display_name, avatar_url, role, status,
         locale, time_zone, billing_customer_ref, last_login_at, created_at, updated_at
    FROM users
`;

export const findById = async (userId, client = pool) => {
  const { rows } = await client.query(`${SELECT} WHERE id = $1 AND deleted_at IS NULL`, [userId]);
  return rows[0] ? rowToUser(rows[0]) : null;
};

export const findByEmail = async (email, client = pool) => {
  const { rows } = await client.query(
    `${SELECT} WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [email],
  );
  return rows[0] ? rowToUser(rows[0]) : null;
};

/** The one place the hash is read. Used by the login path and nowhere else. */
export const findCredentials = async (email, client = pool) => {
  const { rows } = await client.query(
    `SELECT id, email, password_hash, role, status, display_name,
            failed_attempts, locked_until
       FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [email],
  );

  if (!rows[0]) return null;

  return {
    userId: rows[0].id,
    email: rows[0].email,
    passwordHash: rows[0].password_hash,
    role: rows[0].role,
    status: rows[0].status,
    displayName: rows[0].display_name,
    failedAttempts: rows[0].failed_attempts ?? 0,
    lockedUntil: rows[0].locked_until?.toISOString() ?? null,
  };
};

export const findMany = async (userIds, client = pool) => {
  if (userIds.length === 0) return [];
  const { rows } = await client.query(`${SELECT} WHERE id = ANY($1::uuid[])`, [userIds]);
  return rows.map(rowToUser);
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export const create = async ({ email, password, displayName, role = 'learner', locale = 'en', timeZone = 'UTC' }, client = pool) => {
  const passwordHash = password ? await hashPassword(password) : null;

  const { rows } = await client.query(
    `INSERT INTO users (email, password_hash, display_name, role, locale, time_zone, status)
     VALUES ($1,$2,$3,$4,$5,$6,'active')
     ON CONFLICT (lower(email)) DO NOTHING
     RETURNING id`,
    [email.trim(), passwordHash, displayName.trim(), role, locale, timeZone],
  );

  if (!rows[0]) {
    throw Object.assign(new Error('an account with that email already exists'), { code: 'conflict' });
  }

  log.info({ userId: rows[0].id, role }, 'user created');
  return findById(rows[0].id, client);
};

export const updatePassword = async ({ userId, password }, client = pool) => {
  const hash = await hashPassword(password);
  await client.query(
    `UPDATE users SET password_hash = $2, password_changed_at = now(),
            failed_attempts = 0, locked_until = NULL, updated_at = now()
      WHERE id = $1`,
    [userId, hash],
  );

  // Every other session dies with the old password. Somebody changing their
  // password because it was compromised expects exactly that.
  const { revokeAllForUser } = await import('./SessionStore.js');
  await revokeAllForUser({ userId, reason: 'password-changed' }).catch(() => undefined);

  log.info({ userId }, 'password changed');
  return true;
};

export const update = async ({ userId, patch }, client = pool) => {
  const columns = {
    displayName: 'display_name', locale: 'locale', timeZone: 'time_zone',
    avatarUrl: 'avatar_url', role: 'role', status: 'status', email: 'email',
  };

  const sets = [];
  const params = [];

  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }

  // Changing an email un-verifies it. Otherwise it is a way to claim an
  // address you do not control.
  if (patch.email !== undefined) sets.push('email_verified = false');
  if (sets.length === 0) return findById(userId, client);

  params.push(userId);
  await client.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
    params,
  );

  return findById(userId, client);
};

// ---------------------------------------------------------------------------
// Login attempts
// ---------------------------------------------------------------------------

/**
 * Progressive lockout. Five failures locks the account for fifteen minutes, and
 * each further failure extends it.
 *
 * The account is locked, not the IP: locking an IP punishes a whole school
 * behind one NAT, and an attacker has more IP addresses than the victim has
 * accounts. The per-IP rate limit in middleware/rateLimit.js is the other half.
 */
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export const recordFailedLogin = async (userId, client = pool) => {
  const { rows } = await client.query(
    `UPDATE users
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE
              WHEN failed_attempts + 1 >= $2
              THEN now() + ($3 || ' minutes')::interval * GREATEST(1, failed_attempts + 2 - $2)
              ELSE locked_until END
      WHERE id = $1
      RETURNING failed_attempts, locked_until`,
    [userId, MAX_ATTEMPTS, String(LOCK_MINUTES)],
  );

  const attempts = rows[0]?.failed_attempts ?? 0;
  if (rows[0]?.locked_until) {
    log.warn({ userId, attempts }, 'account locked after repeated failures');
  }

  return { attempts, lockedUntil: rows[0]?.locked_until?.toISOString() ?? null };
};

export const recordSuccessfulLogin = async (userId, client = pool) => {
  await client.query(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
    [userId],
  );
};

export const isLocked = (credentials) =>
  Boolean(credentials?.lockedUntil) && new Date(credentials.lockedUntil) > new Date();

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const verifyEmail = async (userId, client = pool) => {
  const { rowCount } = await client.query(
    `UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1 AND email_verified = false`,
    [userId],
  );
  return rowCount > 0;
};

export const suspend = async ({ userId, reason, actorId }, client = pool) => {
  await client.query(
    `UPDATE users SET status = 'suspended', updated_at = now() WHERE id = $1`,
    [userId],
  );

  const { revokeAllForUser } = await import('./SessionStore.js');
  await revokeAllForUser({ userId, reason: 'suspended' }).catch(() => undefined);

  log.warn({ userId, actorId, reason }, 'user suspended');
  return true;
};

export const reinstate = async (userId, client = pool) => {
  await client.query(`UPDATE users SET status = 'active', updated_at = now() WHERE id = $1`, [userId]);
  return true;
};

/**
 * Deletion is a scheduled anonymisation, not a DELETE. Their posts, grades and
 * attendance belong to the courses they were part of, and removing the row
 * would orphan all of it — so the account is emptied and the content stays
 * attributed to "Deleted user".
 */
export const requestDeletion = async ({ userId, graceDays = 30 }, client = pool) => {
  await client.query(
    `UPDATE users SET status = 'pending_deletion',
            deletion_scheduled_at = now() + ($2 || ' days')::interval,
            updated_at = now()
      WHERE id = $1`,
    [userId, String(graceDays)],
  );

  const { revokeAllForUser } = await import('./SessionStore.js');
  await revokeAllForUser({ userId, reason: 'deletion-requested' }).catch(() => undefined);

  log.warn({ userId, graceDays }, 'account deletion requested');
  return true;
};

export const anonymise = async (userId, client = pool) => {
  await client.query(
    `UPDATE users
        SET email = 'deleted+' || $1 || '@invalid',
            password_hash = NULL,
            display_name = 'Deleted user',
            avatar_url = NULL,
            status = 'deleted',
            deleted_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [userId],
  );

  log.warn({ userId }, 'account anonymised');
  return true;
};

export const newUserId = () => randomUUID();

export default {
  findById, findByEmail, findCredentials, create, update, updatePassword,
  recordFailedLogin, recordSuccessfulLogin, isLocked, verifyEmail, suspend,
  hashPassword, verifyPassword, validatePassword, needsRehash,
};