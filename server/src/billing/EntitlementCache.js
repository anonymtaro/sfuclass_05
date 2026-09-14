// classroom-app/server/src/billing/EntitlementCache.js
/**
 * Entitlement cache  [UNCHANGED]
 *
 * Reference implementation; keep yours if it differs.
 *
 * Entitlements are read before almost every meaningful action and change almost
 * never. Redis with a sixty-second TTL is the whole design.
 *
 * Sixty seconds is a deliberate compromise. Longer and a completed upgrade
 * leaves somebody staring at a paywall they have just paid to remove; shorter
 * and the database carries a query per request. Anything that *does* change
 * entitlements — a webhook, an upload, a publish — invalidates explicitly, so
 * the TTL is a safety net rather than the mechanism.
 */

import { env } from '../config/env.js';
import { redis } from '../db/redis.js';
import { logger } from '../observability/logger.js';
import * as LimitResolver from './LimitResolver.js';

const log = logger.child({ component: 'entitlements' });

const TTL_SEC = env.BILLING_ENTITLEMENT_TTL_SEC;
const key = (ownerId) => `${env.REDIS_PREFIX}:entitlements:${ownerId}`;
const lockKey = (ownerId) => `${env.REDIS_PREFIX}:entitlements:lock:${ownerId}`;

/** Per-process, per-owner promise. Collapses concurrent misses in one task. */
const inFlight = new Map();

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const get = async (ownerId, { refresh = false } = {}) => {
  if (!refresh) {
    const cached = await redis.get(key(ownerId)).catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return { ...parsed, cached: true };
      } catch {
        // A corrupt entry is not worth investigating; overwrite it.
        await redis.del(key(ownerId)).catch(() => undefined);
      }
    }
  }

  // Two requests in the same task must produce one database read, not two.
  const existing = inFlight.get(ownerId);
  if (existing) return existing;

  const promise = load(ownerId).finally(() => inFlight.delete(ownerId));
  inFlight.set(ownerId, promise);
  return promise;
};

const load = async (ownerId) => {
  /**
   * Cross-task stampede protection. After a deploy every task has a cold cache
   * and a popular tenant would otherwise produce one expensive query per task
   * per request. One task computes, the rest wait briefly and read the result.
   */
  const won = await redis
    .set(lockKey(ownerId), '1', 'EX', 10, 'NX')
    .catch(() => 'OK'); // Redis unavailable: everybody computes, which is correct

  if (!won) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const cached = await redis.get(key(ownerId)).catch(() => null);
    if (cached) return { ...JSON.parse(cached), cached: true };
    // The winner is slower than expected. Computing it ourselves beats waiting.
  }

  const entitlements = await LimitResolver.resolve(ownerId);

  const payload = {
    ...entitlements,
    computedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TTL_SEC * 1000).toISOString(),
  };

  await redis
    .set(key(ownerId), JSON.stringify(payload), 'EX', TTL_SEC)
    .catch((cause) => log.warn({ err: cause, ownerId }, 'entitlements not cached'));

  await redis.del(lockKey(ownerId)).catch(() => undefined);

  return { ...payload, cached: false };
};

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Called by anything that changes what a tenant may do: the Stripe webhook, a
 * completed upload, a published course, a deleted asset.
 *
 * Deleting rather than recomputing: the next read pays for the refresh, and a
 * tenant whose entitlements changed at 3 a.m. should not cost a query then.
 */
export const invalidate = async (ownerId) => {
  inFlight.delete(ownerId);
  await redis.del(key(ownerId)).catch((cause) =>
    log.warn({ err: cause, ownerId }, 'entitlement cache not invalidated'),
  );
};

/** After a plan change that affects a whole set of tenants. */
export const invalidateMany = async (ownerIds) => {
  if (ownerIds.length === 0) return 0;
  for (const ownerId of ownerIds) inFlight.delete(ownerId);
  return redis.del(...ownerIds.map(key)).catch(() => 0);
};

/**
 * Nuclear option, for a change to the plan catalogue itself. A SCAN rather
 * than KEYS: KEYS blocks Redis, and blocking Redis blocks every socket in the
 * platform.
 */
export const invalidateAll = async () => {
  const pattern = `${env.REDIS_PREFIX}:entitlements:*`;
  let cursor = '0';
  let removed = 0;

  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    if (found.length > 0) {
      await redis.del(...found);
      removed += found.length;
    }
  } while (cursor !== '0');

  inFlight.clear();
  log.warn({ removed }, 'entire entitlement cache invalidated');
  return removed;
};

/**
 * A cheap nudge for the one number that moves constantly. An upload changes
 * storage and nothing else, and a full recompute for every finished upload
 * would make the cache pointless on a busy tenant.
 */
export const adjustStorage = async (ownerId, deltaBytes) => {
  const cached = await redis.get(key(ownerId)).catch(() => null);
  if (!cached) return false;

  try {
    const entitlements = JSON.parse(cached);
    entitlements.usage.storageBytes = Math.max(0, entitlements.usage.storageBytes + deltaBytes);
    entitlements.can.upload = entitlements.usage.storageBytes < entitlements.usage.storageQuotaBytes;

    // The remaining TTL is kept rather than extended: a nudged entry must not
    // outlive the real one it is standing in for.
    const ttl = await redis.ttl(key(ownerId));
    await redis.set(key(ownerId), JSON.stringify(entitlements), 'EX', Math.max(1, ttl));
    return true;
  } catch {
    await invalidate(ownerId);
    return false;
  }
};

export default { get, invalidate, invalidateMany, invalidateAll, adjustStorage };