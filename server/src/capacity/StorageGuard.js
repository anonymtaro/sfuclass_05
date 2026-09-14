// classroom-app/server/src/capacity/StorageGuard.js
/**
 * Storage quota  (F4, F6)  [NEW]
 *
 * The gate in front of every presign. `UploadService.createUpload` calls
 * `assertStorageAvailable` before it creates anything, and that call is the only
 * thing standing between a tenant and a bill for storage they never bought.
 *
 * Storage differs from seats in the way that matters here: a seat is freed when
 * a lesson ends, but storage only comes back when somebody deletes something.
 * So the failure mode is not a race at the door, it is a slow drift where the
 * recorded usage and the real usage disagree until the quota stops meaning
 * anything.
 *
 * Two mechanisms deal with that:
 *
 *   reservations   a presign holds the bytes it is about to use, in Redis, with
 *                  a TTL matching the upload window. Without this, ten
 *                  simultaneous 5 GB presigns each see the same free space and
 *                  all ten pass.
 *
 *   reconciliation a nightly recount from the database, because reservations
 *                  expire, uploads fail halfway, and the cached number is an
 *                  optimisation rather than the truth.
 */

import { ApiError } from '@classroom/contracts';
import { env } from '../config/env.js';
import { redis } from '../db/redis.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'storage-guard' });

const GB = 1024 * 1024 * 1024;

/**
 * Slightly longer than the presigned URL TTL. A reservation that expires while
 * the upload is still running would let a second presign double-count the
 * space; one that outlives a dead upload is reclaimed by the next sweep.
 */
const RESERVATION_TTL_SEC = 4_200; // 70 minutes against a 60-minute URL

const pendingKey = (ownerId) => `${env.REDIS_PREFIX}:storage:pending:${ownerId}`;
const reservationKey = (ownerId, assetId) => `${env.REDIS_PREFIX}:storage:res:${ownerId}:${assetId}`;

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

/**
 * Atomic reserve: read the committed usage, add what is already pending, and
 * only then decide. Done in the application these are three steps and two
 * concurrent presigns interleave between them.
 *
 * KEYS[1] pending counter   KEYS[2] this reservation
 * ARGV[1] bytes   ARGV[2] quota   ARGV[3] committed   ARGV[4] ttl seconds
 *
 * Returns { granted, pendingBytes, availableBytes }
 */
const RESERVE = `
local pending_key = KEYS[1]
local res_key     = KEYS[2]
local bytes       = tonumber(ARGV[1])
local quota       = tonumber(ARGV[2])
local committed   = tonumber(ARGV[3])
local ttl         = tonumber(ARGV[4])

local pending = tonumber(redis.call('GET', pending_key) or '0')
local available = quota - committed - pending

if bytes > available then
  return { 0, pending, available }
end

-- The reservation is recorded twice: once in the counter everybody reads, and
-- once under its own key so it can be released by id.
redis.call('INCRBY', pending_key, bytes)
redis.call('EXPIRE', pending_key, ttl)
redis.call('SET', res_key, bytes, 'EX', ttl)

return { 1, pending + bytes, available - bytes }
`;

const RELEASE = `
local pending_key = KEYS[1]
local res_key     = KEYS[2]

local bytes = tonumber(redis.call('GET', res_key) or '0')
if bytes == 0 then
  return 0
end

redis.call('DEL', res_key)
-- Never below zero: a double release, or a release after the counter expired,
-- would otherwise leave a negative that grants free space forever.
local remaining = tonumber(redis.call('GET', pending_key) or '0') - bytes
if remaining > 0 then
  redis.call('SET', pending_key, remaining, 'KEEPTTL')
else
  redis.call('DEL', pending_key)
end

return bytes
`;

let reserveSha = null;
let releaseSha = null;

const evaluate = async (script, shaRef, keys, args) => {
  const load = async () => redis.script('LOAD', script);
  try {
    shaRef.value ??= await load();
    return await redis.evalsha(shaRef.value, keys.length, ...keys, ...args);
  } catch (cause) {
    if (String(cause?.message).includes('NOSCRIPT')) {
      shaRef.value = await load();
      return redis.evalsha(shaRef.value, keys.length, ...keys, ...args);
    }
    throw cause;
  }
};

const reserveRef = { get value() { return reserveSha; }, set value(v) { reserveSha = v; } };
const releaseRef = { get value() { return releaseSha; }, set value(v) { releaseSha = v; } };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Plan quota in bytes, from the cached entitlements. */
export const quotaBytesFor = async (ownerId) => {
  const { get } = await import('../billing/EntitlementCache.js');
  const entitlements = await get(ownerId);
  return entitlements.usage.storageQuotaBytes ?? entitlements.limits.storageQuotaGb * GB;
};

/**
 * Committed plus reserved. The number a progress bar should show, because a
 * 4 GB upload in flight is space the tenant cannot use for anything else.
 */
export const currentUsage = async (ownerId) => {
  const { get } = await import('../billing/EntitlementCache.js');
  const entitlements = await get(ownerId);

  const pending = Number(await redis.get(pendingKey(ownerId)).catch(() => 0)) || 0;
  const quotaBytes = entitlements.usage.storageQuotaBytes;
  const committed = entitlements.usage.storageBytes;

  return {
    committedBytes: committed,
    pendingBytes: pending,
    usedBytes: committed + pending,
    quotaBytes,
    availableBytes: Math.max(0, quotaBytes - committed - pending),
    usedPercent: quotaBytes === 0 ? 0 : Math.min(100, Math.round(((committed + pending) / quotaBytes) * 100)),
  };
};

/**
 * The gate. Throws rather than returning false, because every caller would
 * otherwise have to remember to check — and the one that forgets is the one
 * that lets an upload through.
 *
 * Called by UploadService.createUpload.
 */
export const assertStorageAvailable = async ({ ownerId, sizeBytes, assetId = null }) => {
  const { get } = await import('../billing/EntitlementCache.js');
  const entitlements = await get(ownerId);

  const quotaBytes = entitlements.usage.storageQuotaBytes;
  const committed = entitlements.usage.storageBytes;

  // No reservation without an asset id: an intent check, used by the client to
  // decide whether to show a file picker at all.
  if (!assetId) {
    const pending = Number(await redis.get(pendingKey(ownerId)).catch(() => 0)) || 0;
    if (committed + pending + sizeBytes > quotaBytes) {
      throw quotaError({ ownerId, sizeBytes, used: committed + pending, quotaBytes });
    }
    return { reserved: false, availableBytes: quotaBytes - committed - pending };
  }

  let result;
  try {
    result = await evaluate(
      RESERVE,
      reserveRef,
      [pendingKey(ownerId), reservationKey(ownerId, assetId)],
      [String(sizeBytes), String(quotaBytes), String(committed), String(RESERVATION_TTL_SEC)],
    );
  } catch (cause) {
    /**
     * Fail closed, unlike the seat guard. An unreserved upload becomes a
     * permanent cost, and there is no equivalent of "the lesson ends and the
     * seat comes back". A refused upload is an inconvenience; unbounded
     * storage on a two-euro plan is a bill.
     */
    log.error({ err: cause, ownerId }, 'storage reservation unavailable, refusing the upload');
    throw new ApiError('dependency_unavailable', {
      detail: 'Uploads are briefly unavailable. Try again in a moment.',
      retryAfter: 15,
    });
  }

  const [granted, pendingBytes, availableBytes] = result;

  if (!granted) {
    throw quotaError({ ownerId, sizeBytes, used: committed + pendingBytes, quotaBytes });
  }

  log.debug({ ownerId, assetId, sizeBytes, availableBytes }, 'storage reserved');
  return { reserved: true, availableBytes };
};

/**
 * The upload finished and the bytes are now real. Releases the reservation and
 * nudges the cached usage, so the next check sees the new number without a
 * full recompute.
 */
export const commitReservation = async ({ ownerId, assetId, sizeBytes }) => {
  await releaseReservation({ ownerId, assetId }).catch(() => undefined);

  const { adjustStorage } = await import('../billing/EntitlementCache.js');
  await adjustStorage(ownerId, sizeBytes).catch(() => undefined);

  return true;
};

/** The upload was aborted, failed, or the file was rejected by the scan. */
export const releaseReservation = async ({ ownerId, assetId }) => {
  try {
    const released = await evaluate(
      RELEASE,
      releaseRef,
      [pendingKey(ownerId), reservationKey(ownerId, assetId)],
      [],
    );
    return Number(released) || 0;
  } catch (cause) {
    // Not fatal: the reservation has a TTL and will clear itself.
    log.warn({ err: cause, ownerId, assetId }, 'reservation not released; it will expire');
    return 0;
  }
};

/** A deletion returns space. Negative delta, same mechanism. */
export const releaseBytes = async ({ ownerId, sizeBytes }) => {
  const { adjustStorage } = await import('../billing/EntitlementCache.js');
  await adjustStorage(ownerId, -Math.abs(sizeBytes)).catch(() => undefined);
};

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Recounts from the database and drops the cached copy. Called after a delete,
 * and nightly by jobs/recomputeStorageUsage.js.
 *
 * The nightly run is not optional. Reservations expire without being committed,
 * uploads die halfway, and a scan rejects a file after its bytes were counted —
 * each of those leaves the cached number slightly wrong, and slightly wrong
 * compounds.
 */
export const recomputeUsage = async (ownerId) => {
  const { usageFor } = await import('../media/models/Asset.js');
  const { invalidate } = await import('../billing/EntitlementCache.js');

  const { usedBytes } = await usageFor(ownerId);

  // Stale reservations go too: anything still pending after the TTL never
  // became a real file.
  await redis.del(pendingKey(ownerId)).catch(() => undefined);
  await invalidate(ownerId);

  log.info({ ownerId, usedBytes }, 'storage usage recomputed');
  return { ownerId, usedBytes };
};

/**
 * Warns a tenant approaching their limit, once per threshold. Running out of
 * space in the middle of uploading a lecture is avoidable with a week's notice.
 */
export const checkThresholds = async (ownerId) => {
  const usage = await currentUsage(ownerId);
  const crossed = [100, 95, 80].find((threshold) => usage.usedPercent >= threshold);
  if (!crossed) return null;

  const marker = `${env.REDIS_PREFIX}:storage:warned:${ownerId}:${crossed}`;
  // Once per threshold per week, not once per upload.
  const first = await redis.set(marker, '1', 'EX', 604_800, 'NX').catch(() => null);
  if (!first) return null;

  const { notify } = await import('../community/NotificationService.js');
  await notify({
    userId: ownerId,
    type: 'space.invite',
    title:
      crossed === 100
        ? 'You are out of storage'
        : `You have used ${crossed}% of your storage`,
    body: crossed === 100 ? 'Delete some files or upgrade to keep uploading.' : null,
    href: '/settings/billing',
  }).catch(() => undefined);

  log.info({ ownerId, threshold: crossed, usedPercent: usage.usedPercent }, 'storage threshold crossed');
  return { threshold: crossed, usage };
};

const quotaError = ({ sizeBytes, used, quotaBytes }) => {
  const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;

  return new ApiError('quota_exceeded', {
    title: 'Not enough storage',
    // The numbers are in the message on purpose: "quota exceeded" tells
    // somebody nothing about how much they need to free up.
    detail: `This file needs ${gb(sizeBytes)}, and ${gb(Math.max(0, quotaBytes - used))} of your ${gb(quotaBytes)} is free.`,
  });
};

/** Tests only. */
export const resetStorageScripts = () => {
  reserveSha = null;
  releaseSha = null;
};

export default {
  assertStorageAvailable, commitReservation, releaseReservation, releaseBytes,
  quotaBytesFor, currentUsage, recomputeUsage, checkThresholds,
};