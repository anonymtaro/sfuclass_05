// classroom-app/server/src/identity/SessionStore.js
/**
 * Sessions and revocation  (F7)  [NEW]
 *
 * A JWT is valid until it expires, whatever happens in between. That is the
 * point of a stateless token and also its problem: signing out, changing a
 * password, or suspending an account has to take effect *now*, not in fifteen
 * minutes.
 *
 * So there are two lists in Redis, and the asymmetry between them is the whole
 * design:
 *
 *   sessions    one record per device, holding the refresh token's identity.
 *               Consulted on refresh, which happens every fifteen minutes.
 *
 *   revoked     access token ids that must stop working immediately. Checked on
 *               every request, so it has to be cheap — a SET membership test,
 *               with each entry expiring exactly when the token it denies would
 *               have expired anyway. The list can never grow without bound.
 *
 * Refresh tokens rotate. Each use issues a new one and invalidates the old, so a
 * stolen refresh token is usable once — and when the legitimate client then
 * presents the same one, the reuse is detectable and the whole family is killed.
 * That detection is the reason rotation is worth the complexity.
 */

import { randomUUID, createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { redis } from '../db/redis.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'sessions' });

const sessionKey = (sessionId) => `${env.REDIS_PREFIX}:session:${sessionId}`;
const userSessionsKey = (userId) => `${env.REDIS_PREFIX}:sessions:${userId}`;
const revokedKey = (jti) => `${env.REDIS_PREFIX}:revoked:${jti}`;
const familyKey = (familyId) => `${env.REDIS_PREFIX}:family:${familyId}`;

const parseDuration = (value) => {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) return 900;
  const [, amount, unit] = match;
  return Number(amount) * { s: 1, m: 60, h: 3600, d: 86_400 }[unit];
};

const ACCESS_TTL_SEC = parseDuration(env.JWT_ACCESS_TTL);
const REFRESH_TTL_SEC = parseDuration(env.REFRESH_TTL);

/** Refresh tokens are stored hashed. A Redis dump is then not a set of keys. */
const fingerprint = (token) => createHash('sha256').update(token).digest('base64url');

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * @param {{ userId: string, refreshToken: string, device?: object, familyId?: string }} input
 */
export const createSession = async ({ userId, refreshToken, device = {}, familyId = null }) => {
  const sessionId = randomUUID();
  const family = familyId ?? randomUUID();

  const record = {
    sessionId,
    userId,
    familyId: family,
    tokenFingerprint: fingerprint(refreshToken),
    device: {
      platform: device.platform ?? 'web',
      name: device.name ?? 'Unknown device',
      // Stored for the "sign out other devices" screen, which is useless if it
      // says "unknown device" four times.
      userAgent: (device.userAgent ?? '').slice(0, 200),
      ip: device.ip ?? null,
    },
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };

  await redis
    .multi()
    .set(sessionKey(sessionId), JSON.stringify(record), 'EX', REFRESH_TTL_SEC)
    // A sorted set by last use, so the device list is ordered and the oldest
    // can be trimmed when somebody has forty of them.
    .zadd(userSessionsKey(userId), Date.now(), sessionId)
    .expire(userSessionsKey(userId), REFRESH_TTL_SEC)
    .set(familyKey(family), sessionId, 'EX', REFRESH_TTL_SEC)
    .exec();

  log.info({ userId, sessionId, platform: record.device.platform }, 'session created');
  return { sessionId, familyId: family };
};

/**
 * Validates a refresh token against its session and rotates it.
 *
 * The reuse branch is the important one. A refresh token that does not match
 * the stored fingerprint has already been rotated — which means either a stolen
 * copy is being used, or the legitimate client is replaying after a lost
 * response. Both are handled the same way: kill the family. A false positive
 * costs one re-login; a false negative leaves an attacker with a live session.
 */
export const rotate = async ({ sessionId, presentedToken, newToken, device = {} }) => {
  const raw = await redis.get(sessionKey(sessionId));
  if (!raw) return { ok: false, reason: 'session_not_found' };

  const record = JSON.parse(raw);

  if (record.tokenFingerprint !== fingerprint(presentedToken)) {
    log.error(
      { userId: record.userId, sessionId, familyId: record.familyId },
      'REFRESH TOKEN REUSE detected; revoking the family',
    );
    await revokeFamily({ familyId: record.familyId, reason: 'token-reuse' });
    return { ok: false, reason: 'token_reuse' };
  }

  record.tokenFingerprint = fingerprint(newToken);
  record.lastUsedAt = Date.now();
  if (device.ip) record.device.ip = device.ip;

  await redis
    .multi()
    .set(sessionKey(sessionId), JSON.stringify(record), 'EX', REFRESH_TTL_SEC)
    .zadd(userSessionsKey(record.userId), Date.now(), sessionId)
    .expire(userSessionsKey(record.userId), REFRESH_TTL_SEC)
    .exec();

  return { ok: true, userId: record.userId, familyId: record.familyId };
};

export const getSession = async (sessionId) => {
  const raw = await redis.get(sessionKey(sessionId));
  return raw ? JSON.parse(raw) : null;
};

/** The device list. Ordered by last use, so "this device" is at the top. */
export const listSessions = async (userId) => {
  const ids = await redis.zrevrange(userSessionsKey(userId), 0, 50);
  if (ids.length === 0) return [];

  const records = await redis.mget(ids.map(sessionKey));

  return records
    .map((raw, index) => {
      if (!raw) {
        // Expired underneath the index; tidy up on read.
        void redis.zrem(userSessionsKey(userId), ids[index]).catch(() => undefined);
        return null;
      }
      const record = JSON.parse(raw);
      return {
        sessionId: record.sessionId,
        device: record.device,
        createdAt: new Date(record.createdAt).toISOString(),
        lastUsedAt: new Date(record.lastUsedAt).toISOString(),
      };
    })
    .filter(Boolean);
};

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

/**
 * Denies one access token until it would have expired anyway.
 *
 * The TTL is what keeps this list bounded: an entry for a token that expired an
 * hour ago is dead weight, and without the expiry the denylist grows forever
 * and the per-request check gets slower every day.
 */
export const revokeAccessToken = async ({ jti, expiresAt }) => {
  const ttl = Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
  await redis.set(revokedKey(jti), '1', 'EX', Math.min(ttl, ACCESS_TTL_SEC + 60));
};

/**
 * Checked on every authenticated request. One GET, and it fails *open* on a
 * Redis outage — an unavailable denylist would otherwise reject every request
 * in the platform, which is a far larger incident than a revoked token living
 * out its remaining few minutes.
 */
export const isRevoked = async (jti) => {
  if (!jti) return false;
  try {
    return (await redis.exists(revokedKey(jti))) === 1;
  } catch (cause) {
    log.error({ err: cause, jti }, 'revocation check unavailable, allowing the request');
    return false;
  }
};

export const revokeSession = async ({ sessionId, reason = 'signed-out' }) => {
  const record = await getSession(sessionId);
  if (!record) return false;

  await redis
    .multi()
    .del(sessionKey(sessionId))
    .zrem(userSessionsKey(record.userId), sessionId)
    .del(familyKey(record.familyId))
    .exec();

  log.info({ userId: record.userId, sessionId, reason }, 'session revoked');
  return true;
};

/** Kills every session descended from one login. See the reuse branch above. */
export const revokeFamily = async ({ familyId, reason }) => {
  const sessionId = await redis.get(familyKey(familyId));
  if (sessionId) await revokeSession({ sessionId, reason });
  await redis.del(familyKey(familyId));
  return true;
};

/**
 * Everything. Used on a password change, a suspension, and the "sign out
 * everywhere" button.
 */
export const revokeAllForUser = async ({ userId, reason, exceptSessionId = null }) => {
  const ids = await redis.zrange(userSessionsKey(userId), 0, -1);
  const targets = ids.filter((id) => id !== exceptSessionId);

  if (targets.length === 0) return 0;

  const pipeline = redis.multi();
  for (const sessionId of targets) {
    pipeline.del(sessionKey(sessionId));
    pipeline.zrem(userSessionsKey(userId), sessionId);
  }
  await pipeline.exec();

  /**
   * Access tokens already issued are still valid until they expire. Marking the
   * user as "revoked from" this instant lets the token check reject anything
   * older without listing every jti.
   */
  await redis.set(
    `${env.REDIS_PREFIX}:revoked-before:${userId}`,
    String(Date.now()),
    'EX',
    ACCESS_TTL_SEC + 60,
  );

  log.warn({ userId, revoked: targets.length, reason }, 'all sessions revoked');
  return targets.length;
};

/**
 * Whether a token issued at `issuedAt` predates a mass revocation. Cheaper than
 * a denylist entry per token and the reason "sign out everywhere" is one write
 * rather than forty.
 */
export const isIssuedBeforeRevocation = async ({ userId, issuedAtSec }) => {
  try {
    const cutoff = await redis.get(`${env.REDIS_PREFIX}:revoked-before:${userId}`);
    if (!cutoff) return false;
    return issuedAtSec * 1000 < Number(cutoff);
  } catch {
    return false;
  }
};

export const touch = async ({ sessionId, userId }) => {
  await redis.zadd(userSessionsKey(userId), Date.now(), sessionId).catch(() => undefined);
};

export const ACCESS_TTL = ACCESS_TTL_SEC;
export const REFRESH_TTL = REFRESH_TTL_SEC;

export default {
  createSession, rotate, getSession, listSessions, revokeSession,
  revokeFamily, revokeAllForUser, revokeAccessToken, isRevoked, isIssuedBeforeRevocation,
};