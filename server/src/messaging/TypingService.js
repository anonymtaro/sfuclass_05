// classroom-app/server/src/messaging/TypingService.js
/**
 * Typing indicators  (F6)
 *
 * Ephemeral by construction. Nothing is written to Postgres, nothing is
 * replayed on reconnect, and a lost typing event costs nobody anything.
 *
 * Two properties do the work:
 *
 *   A TTL, not a stop event. "X is typing" expires on its own after a few
 *   seconds, so a client that closes its laptop mid-sentence does not leave a
 *   permanent indicator behind. Clients still send `typing: false` when they
 *   send the message, but nothing depends on it arriving.
 *
 *   Redis pub/sub for fan-out, so a typist on one API task reaches a reader on
 *   another. The Socket.IO adapter would do this too, but keeping typing on its
 *   own channel means a burst of it cannot delay message delivery.
 *
 * Rate limiting is the client's job first (throttled to one event per half TTL)
 * and the socket budget's second.
 */

import { ChatEvents } from '@classroom/contracts';
import { env } from '../config/env.js';
import { redis } from '../db/redis.js';

const { TYPING_TTL_MS } = ChatEvents;

const TTL_SEC = Math.ceil(TYPING_TTL_MS / 1000);

const key = (target, userId) => `${env.REDIS_PREFIX}:typing:${fieldOf(target)}:${userId}`;
const pattern = (target) => `${env.REDIS_PREFIX}:typing:${fieldOf(target)}:*`;

const fieldOf = (target) => {
  switch (target.kind) {
    case 'conversation':
      return `c:${target.conversationId}`;
    case 'channel':
      return `ch:${target.channelId}`;
    default:
      return `r:${target.roomId}`;
  }
};

/**
 * Records that someone is typing and tells the room. Returns the expiry so the
 * client can show the indicator for exactly as long as the server will.
 */
export const setTyping = async ({ target, userId, typing }) => {
  const expiresAt = new Date(Date.now() + TYPING_TTL_MS).toISOString();

  if (typing) {
    // SET with an expiry, refreshed on every keystroke-batch. No cleanup job
    // and no stop event needed.
    await redis.set(key(target, userId), '1', 'EX', TTL_SEC);
  } else {
    await redis.del(key(target, userId));
  }

  const { broadcastTyping } = await import('./chatGateway.js');
  broadcastTyping({ target, userId, typing, expiresAt });

  return { expiresAt };
};

/**
 * Who is typing right now. Used when a client opens a thread, so it does not
 * have to wait for the next keystroke to see an indicator that is already true.
 *
 * SCAN rather than KEYS: this runs on a shared Redis and KEYS blocks it.
 */
export const whoIsTyping = async ({ target, excludeUserId = null }) => {
  const prefix = pattern(target);
  const found = [];
  let cursor = '0';

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', prefix, 'COUNT', 100);
    cursor = next;
    for (const entry of keys) {
      const userId = entry.slice(entry.lastIndexOf(':') + 1);
      if (userId !== excludeUserId) found.push(userId);
    }
  } while (cursor !== '0');

  return found;
};

/** A disconnect clears the indicator immediately rather than waiting for TTL. */
export const clearForUser = async ({ target, userId }) => {
  await redis.del(key(target, userId));
};

/**
 * Clears everything a socket left behind. Called on disconnect with the
 * targets the connection had subscribed to.
 */
export const clearAll = async ({ targets, userId }) => {
  if (targets.length === 0) return;
  await redis.del(...targets.map((target) => key(target, userId)));
};

export default { setTyping, whoIsTyping, clearForUser, clearAll };