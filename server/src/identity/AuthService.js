// classroom-app/server/src/identity/AuthService.js
/**
 * Authentication  (F5)  [NEW]
 *
 * Register, sign in, refresh, sign out. The token design:
 *
 *   access    RS256, fifteen minutes, sent as a bearer header. RS256 rather
 *             than HS256 so the SFU and the realtime service can verify it
 *             with the public key without holding anything that can mint one.
 *
 *   refresh   opaque, thirty days, in an httpOnly cookie on web and secure
 *             storage on mobile. Rotated on every use — see SessionStore.
 *
 * The access token is deliberately small: subject, role, session, expiry.
 * Putting entitlements or a display name in it would mean a plan upgrade or a
 * renamed user taking fifteen minutes to take effect, and a token that is a
 * cache is a cache nobody can invalidate.
 *
 * Timing is treated as a side channel throughout. A sign-in attempt for an
 * address that does not exist still hashes a password, and every failure
 * returns the same message — otherwise the endpoint is a directory of who has
 * an account.
 */

import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';
import * as Users from './User.js';
import * as Sessions from './SessionStore.js';
import * as Profiles from './Profile.js';

const log = logger.child({ component: 'auth' });

let keys = null;

/** jose, imported lazily so a process that never verifies a token never loads it. */
const getKeys = async () => {
  if (keys) return keys;

  const { importPKCS8, importSPKI } = await import('jose');

  keys = {
    private: env.JWT_PRIVATE_KEY ? await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256') : null,
    public: env.JWT_PUBLIC_KEY ? await importSPKI(env.JWT_PUBLIC_KEY, 'RS256') : null,
  };

  return keys;
};

/** A generic failure. Never says which half was wrong. */
const invalidCredentials = () =>
  Object.assign(new Error('That email address and password do not match.'), {
    code: 'unauthenticated',
  });

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Claims, and only these. `sid` ties the token to a session so it can be
 * revoked; `jti` identifies this token so it alone can be denied.
 */
export const issueAccessToken = async ({ userId, role, sessionId }) => {
  const { SignJWT } = await import('jose');
  const { private: privateKey } = await getKeys();

  if (!privateKey) {
    throw Object.assign(new Error('token signing is not configured'), { code: 'internal_error' });
  }

  const jti = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({ role, sid: sessionId })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(`${Sessions.ACCESS_TTL}s`)
    .sign(privateKey);

  return { token, jti, expiresAt: new Date((issuedAt + Sessions.ACCESS_TTL) * 1000).toISOString() };
};

/**
 * Verifies a token and checks it has not been revoked.
 *
 * The two revocation checks cover different cases: `isRevoked` denies one
 * specific token after a sign-out, and `isIssuedBeforeRevocation` denies every
 * token issued before a password change without listing them individually.
 */
export const verifyAccessToken = async (token) => {
  const { jwtVerify } = await import('jose');
  const { public: publicKey } = await getKeys();

  if (!publicKey) {
    throw Object.assign(new Error('token verification is not configured'), { code: 'internal_error' });
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, publicKey, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['RS256'],
      // Small tolerance for clock drift between tasks; larger would widen the
      // window a just-expired token stays usable.
      clockTolerance: 5,
    }));
  } catch (cause) {
    throw Object.assign(new Error('Your session has expired.'), {
      code: 'unauthenticated',
      cause,
    });
  }

  if (await Sessions.isRevoked(payload.jti)) {
    throw Object.assign(new Error('This session was signed out.'), { code: 'token_revoked' });
  }

  if (await Sessions.isIssuedBeforeRevocation({ userId: payload.sub, issuedAtSec: payload.iat })) {
    throw Object.assign(new Error('Please sign in again.'), { code: 'token_revoked' });
  }

  return {
    userId: payload.sub,
    role: payload.role,
    sessionId: payload.sid,
    jti: payload.jti,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
};

/** Opaque and random. A refresh token carries no claims by design. */
const newRefreshToken = () => randomBytes(48).toString('base64url');

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const register = async ({ email, password, displayName, locale, timeZone, device }) => {
  const policy = Users.validatePassword(password, { email, displayName });
  if (!policy.valid) {
    throw Object.assign(new Error(policy.errors[0]), {
      code: 'validation_failed',
      errors: policy.errors,
    });
  }

  const user = await Users.create({ email, password, displayName, locale, timeZone });
  await Profiles.createForUser({ userId: user.userId, displayName });

  await sendVerificationEmail({ user }).catch((cause) =>
    log.error({ err: cause, userId: user.userId }, 'verification email not sent'),
  );

  // Signed in immediately. Requiring verification before first use loses people
  // at the exact moment they are most willing to continue; the unverified state
  // gates what matters instead.
  const session = await startSession({ user, device });

  log.info({ userId: user.userId }, 'user registered');
  return { user, ...session };
};

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

export const login = async ({ email, password, device }) => {
  const credentials = await Users.findCredentials(email);

  /**
   * A missing account still costs a hash. Returning immediately would make the
   * response time a reliable oracle for which addresses are registered.
   */
  if (!credentials) {
    await Users.verifyPassword(password, await Users.hashPassword(randomUUID()));
    throw invalidCredentials();
  }

  if (Users.isLocked(credentials)) {
    throw Object.assign(
      new Error('Too many attempts. Try again in a few minutes.'),
      { code: 'rate_limited', retryAfter: 900 },
    );
  }

  if (credentials.status === 'suspended') {
    throw Object.assign(new Error('This account has been suspended.'), { code: 'forbidden' });
  }

  const correct = credentials.passwordHash
    ? await Users.verifyPassword(password, credentials.passwordHash)
    : false;

  if (!correct) {
    await Users.recordFailedLogin(credentials.userId);
    throw invalidCredentials();
  }

  // Opportunistic upgrade when the hashing parameters have been raised since
  // this password was last set.
  if (Users.needsRehash(credentials.passwordHash)) {
    await Users.updatePassword({ userId: credentials.userId, password }).catch(() => undefined);
  }

  await Users.recordSuccessfulLogin(credentials.userId);

  const user = await Users.findById(credentials.userId);
  const session = await startSession({ user, device });

  log.info({ userId: user.userId, platform: device?.platform }, 'signed in');
  return { user, ...session };
};

const startSession = async ({ user, device }) => {
  const refreshToken = newRefreshToken();
  const { sessionId } = await Sessions.createSession({
    userId: user.userId,
    refreshToken,
    device,
  });

  const access = await issueAccessToken({
    userId: user.userId,
    role: user.role,
    sessionId,
  });

  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken,
    sessionId,
  };
};

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/**
 * Exchanges a refresh token for a new pair. The old refresh token stops working
 * the moment this succeeds.
 */
export const refresh = async ({ sessionId, refreshToken, device }) => {
  const nextToken = newRefreshToken();

  const result = await Sessions.rotate({
    sessionId,
    presentedToken: refreshToken,
    newToken: nextToken,
    device,
  });

  if (!result.ok) {
    // Both failures look identical from outside. Telling a caller that their
    // token was reused tells an attacker they have been noticed.
    throw Object.assign(new Error('Please sign in again.'), { code: 'token_revoked' });
  }

  const user = await Users.findById(result.userId);
  if (!user || user.status !== 'active') {
    await Sessions.revokeSession({ sessionId, reason: 'account-inactive' });
    throw Object.assign(new Error('Please sign in again.'), { code: 'token_revoked' });
  }

  const access = await issueAccessToken({
    userId: user.userId,
    // Read fresh, not carried over: a role change takes effect on the next
    // refresh rather than in thirty days.
    role: user.role,
    sessionId,
  });

  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: nextToken,
    user,
  };
};

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

export const logout = async ({ sessionId, jti, accessTokenExpiresAt }) => {
  if (jti && accessTokenExpiresAt) {
    // The access token has minutes left; deny it rather than waiting.
    await Sessions.revokeAccessToken({ jti, expiresAt: accessTokenExpiresAt });
  }
  if (sessionId) await Sessions.revokeSession({ sessionId, reason: 'signed-out' });
  return true;
};

export const logoutEverywhere = async ({ userId, exceptSessionId = null }) => {
  const revoked = await Sessions.revokeAllForUser({
    userId,
    reason: 'signed-out-everywhere',
    exceptSessionId,
  });
  return { revoked };
};

export const listDevices = (userId) => Sessions.listSessions(userId);

// ---------------------------------------------------------------------------
// Email verification and password reset
// ---------------------------------------------------------------------------

/** Single-use, hashed at rest, short-lived. */
const issueToken = async ({ userId, purpose, ttlSec }) => {
  const token = randomBytes(32).toString('base64url');
  const { redis } = await import('../db/redis.js');

  await redis.set(
    `${env.REDIS_PREFIX}:token:${purpose}:${createHash('sha256').update(token).digest('base64url')}`,
    userId,
    'EX',
    ttlSec,
  );

  return token;
};

const consumeToken = async ({ token, purpose }) => {
  const { redis } = await import('../db/redis.js');
  const key = `${env.REDIS_PREFIX}:token:${purpose}:${createHash('sha256').update(token).digest('base64url')}`;

  // GETDEL: read and consume atomically, so a token cannot be used twice by two
  // requests arriving together.
  const userId = await redis.getdel(key);
  return userId ?? null;
};

const sendVerificationEmail = async ({ user }) => {
  const token = await issueToken({ userId: user.userId, purpose: 'verify', ttlSec: 86_400 });
  const { enqueueNotification } = await import('../queues/queues.js');

  await enqueueNotification('notification.email', {
    userId: user.userId,
    type: 'email.verify',
    title: 'Confirm your email address',
    href: `${env.APP_URL}/verify-email?token=${token}`,
  });
};

export const verifyEmail = async ({ token }) => {
  const userId = await consumeToken({ token, purpose: 'verify' });
  if (!userId) {
    throw Object.assign(new Error('That link has expired.'), { code: 'not_found' });
  }
  await Users.verifyEmail(userId);
  return { userId };
};

/**
 * Always reports success, whether or not the address exists. Anything else is
 * an account-enumeration endpoint that nobody has to authenticate to use.
 */
export const requestPasswordReset = async ({ email }) => {
  const user = await Users.findByEmail(email);

  if (user) {
    const token = await issueToken({ userId: user.userId, purpose: 'reset', ttlSec: 3_600 });
    const { enqueueNotification } = await import('../queues/queues.js');

    await enqueueNotification('notification.email', {
      userId: user.userId,
      type: 'password.reset',
      title: 'Reset your password',
      href: `${env.APP_URL}/reset-password?token=${token}`,
    }).catch((cause) => log.error({ err: cause }, 'reset email not queued'));
  }

  return { sent: true };
};

export const resetPassword = async ({ token, password }) => {
  const userId = await consumeToken({ token, purpose: 'reset' });
  if (!userId) {
    throw Object.assign(new Error('That link has expired.'), { code: 'not_found' });
  }

  const user = await Users.findById(userId);
  const policy = Users.validatePassword(password, { email: user.email, displayName: user.displayName });

  if (!policy.valid) {
    throw Object.assign(new Error(policy.errors[0]), { code: 'validation_failed', errors: policy.errors });
  }

  // updatePassword revokes every session, which is the point of a reset.
  await Users.updatePassword({ userId, password });

  log.info({ userId }, 'password reset');
  return { userId };
};

/** Changing a password requires the current one, even while signed in. */
export const changePassword = async ({ userId, currentPassword, newPassword }) => {
  const user = await Users.findById(userId);
  const credentials = await Users.findCredentials(user.email);

  const correct = await Users.verifyPassword(currentPassword, credentials.passwordHash);
  if (!correct) throw invalidCredentials();

  const policy = Users.validatePassword(newPassword, { email: user.email, displayName: user.displayName });
  if (!policy.valid) {
    throw Object.assign(new Error(policy.errors[0]), { code: 'validation_failed', errors: policy.errors });
  }

  await Users.updatePassword({ userId, password: newPassword });
  return { userId };
};

/** Compares two secrets in constant time. Exported for the CSRF middleware. */
export const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

export default {
  register, login, refresh, logout, logoutEverywhere, listDevices,
  issueAccessToken, verifyAccessToken, verifyEmail, requestPasswordReset,
  resetPassword, changePassword,
};