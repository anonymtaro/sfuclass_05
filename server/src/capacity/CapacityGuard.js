// classroom-app/server/src/capacity/CapacityGuard.js
/**
 * Seat capacity  (F1)  [UNCHANGED]
 *
 * Reference implementation; keep yours if it differs.
 *
 * Seats are a rate, not a quota: they are taken when somebody joins a room and
 * freed when they leave, so the interesting failure is a race rather than an
 * accumulation. Two learners clicking Join on the last seat at the same instant
 * must produce one admission and one clean refusal — which is why the check and
 * the take are a single Lua script rather than a read followed by a write.
 *
 * The other half of the design is the TTL. Nobody reliably leaves: a closed
 * laptop, a killed tab, a task that crashed. A seat that must be handed back
 * explicitly would leak one every time, and a room would slowly fill with
 * ghosts. Seats expire, and a connected client refreshes its own by
 * heartbeating.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { redis } from '../db/redis.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'capacity' });

/**
 * Two minutes. Long enough to survive a phone switching from wifi to mobile
 * data mid-lesson; short enough that a crashed browser frees its seat before
 * the next person gives up trying to join.
 */
const SEAT_TTL_MS = 120_000;

const seatKey = (roomId) => `${env.REDIS_PREFIX}:seats:${roomId}`;

let scriptSha = null;

const loadScript = async () => {
  if (scriptSha) return scriptSha;
  const path = fileURLToPath(new URL('./reserveSeat.lua', import.meta.url));
  const source = await readFile(path, 'utf8');
  scriptSha = await redis.script('LOAD', source);
  return scriptSha;
};

const evaluate = async (args) => {
  try {
    return await redis.evalsha(await loadScript(), 1, ...args);
  } catch (cause) {
    // A Redis restart clears the script cache. Reload once and retry.
    if (String(cause?.message).includes('NOSCRIPT')) {
      scriptSha = null;
      return redis.evalsha(await loadScript(), 1, ...args);
    }
    throw cause;
  }
};

// ---------------------------------------------------------------------------
// Reserving
// ---------------------------------------------------------------------------

/**
 * Takes a seat, or reports that the room is full.
 *
 * @param {{ roomId: string, userId: string, limit: number }} input
 * @returns {Promise<{ granted: boolean, occupied: number, remaining: number, rejoined: boolean, degraded?: boolean }>}
 */
export const reserveSeat = async ({ roomId, userId, limit, ttlMs = SEAT_TTL_MS }) => {
  try {
    const [granted, occupied, remaining, rejoined] = await evaluate([
      seatKey(roomId),
      userId,
      String(limit),
      String(Date.now()),
      String(ttlMs),
    ]);

    if (!granted) {
      log.info({ roomId, userId, occupied, limit }, 'room full');
    }

    return {
      granted: granted === 1,
      occupied,
      remaining,
      rejoined: rejoined === 1,
    };
  } catch (cause) {
    /**
     * Fail open. Redis being unavailable is already an incident; refusing
     * every join turns it into a total outage of the product's main feature.
     * An over-full room is recoverable, a lesson nobody can attend is not.
     */
    log.error({ err: cause, roomId, userId }, 'seat reservation unavailable, admitting anyway');
    return { granted: true, occupied: 0, remaining: limit, rejoined: false, degraded: true };
  }
};

/** Explicit release, on a clean leave. The TTL covers everything else. */
export const releaseSeat = async ({ roomId, userId }) => {
  try {
    await redis.hdel(seatKey(roomId), userId);
    return true;
  } catch (cause) {
    log.warn({ err: cause, roomId, userId }, 'seat not released; it will expire');
    return false;
  }
};

/**
 * Refreshes a seat. Called on the socket heartbeat, so a long lesson does not
 * expire seats out from under people who are still in it.
 */
export const heartbeatSeat = ({ roomId, userId, limit, ttlMs = SEAT_TTL_MS }) =>
  reserveSeat({ roomId, userId, limit, ttlMs });

/** The room ended. Everything goes at once rather than waiting for TTLs. */
export const releaseRoom = async (roomId) => {
  try {
    await redis.del(seatKey(roomId));
    return true;
  } catch (cause) {
    log.warn({ err: cause, roomId }, 'seats not cleared');
    return false;
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Live occupancy, expired seats excluded. */
export const occupancy = async (roomId) => {
  try {
    const entries = await redis.hgetall(seatKey(roomId));
    const now = Date.now();

    const live = Object.entries(entries).filter(([, expiry]) => Number(expiry) > now);
    return { occupied: live.length, userIds: live.map(([userId]) => userId) };
  } catch {
    return { occupied: 0, userIds: [] };
  }
};

/**
 * The full admission check: plan limit, then seat.
 *
 * Entitlements are consulted first because a refusal there is cheaper and the
 * message is different — "your plan allows 8 people" is actionable, "the room
 * is full" is not.
 */
export const admit = async ({ roomId, userId, ownerId }) => {
  const { get } = await import('../billing/EntitlementCache.js');
  const entitlements = await get(ownerId);

  if (!entitlements.can.startRoom && (await occupancy(roomId)).occupied === 0) {
    return {
      granted: false,
      code: 'seat_limit_reached',
      reason: 'Your plan does not allow another room right now.',
    };
  }

  const seat = await reserveSeat({
    roomId,
    userId,
    limit: entitlements.limits.seatsPerRoom,
  });

  if (!seat.granted) {
    return {
      granted: false,
      code: 'room_full',
      reason: `This room is limited to ${entitlements.limits.seatsPerRoom} people.`,
      occupied: seat.occupied,
    };
  }

  return { granted: true, ...seat, limit: entitlements.limits.seatsPerRoom };
};

/** Tests only. */
export const resetSeatScript = () => {
  scriptSha = null;
};

export default { reserveSeat, releaseSeat, releaseRoom, heartbeatSeat, occupancy, admit, SEAT_TTL_MS };