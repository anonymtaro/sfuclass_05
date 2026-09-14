// classroom-app/server/src/classroom/interaction/Reactions.js
/**
 * Reactions  (F1)  [NEW]
 *
 * Ephemeral emoji. Nothing is persisted, nothing is stored, and that is the
 * design rather than an omission.
 *
 * A reaction is a way of saying "yes" without unmuting. It is meaningful for
 * about three seconds and meaningless afterwards, so putting it in the chat
 * history would be adding noise to something people read later. Compare
 * LiveChat.js, which is the opposite decision for the opposite reason.
 *
 * The rate limit exists because a burst of emoji from thirty people is the
 * cheapest way to make a lesson unreadable, and because a script can send
 * hundreds a second.
 */

import { recordInteraction } from '../AttendanceService.js';

/** Emoji anyone can send. Free text here would be a moderation surface. */
export const ALLOWED = ['👍', '👏', '🎉', '❤️', '😂', '😮', '🤔', '✋', '💡', '🙏'];

const PER_PEER_PER_10S = 8;
const WINDOW_MS = 10_000;

/** roomId -> Map<peerId, number[]> of recent timestamps */
const recent = new Map();

const withinLimit = (roomId, peerId) => {
  let room = recent.get(roomId);
  if (!room) {
    room = new Map();
    recent.set(roomId, room);
  }

  const now = Date.now();
  const times = (room.get(peerId) ?? []).filter((at) => now - at < WINDOW_MS);

  if (times.length >= PER_PEER_PER_10S) {
    room.set(peerId, times);
    return false;
  }

  times.push(now);
  room.set(peerId, times);
  return true;
};

/**
 * @returns {{ ok: true } | { ok: false, code: string, retryAfterSec?: number }}
 */
export const send = (room, peer, emoji) => {
  if (!ALLOWED.includes(emoji)) {
    return { ok: false, code: 'validation_failed', reason: 'unsupported reaction' };
  }

  if (!withinLimit(room.id, peer.id)) {
    // Silently dropped rather than errored: a rate-limited reaction is not
    // worth an error dialog over a thumbs-up.
    return { ok: false, code: 'rate_limited', retryAfterSec: 10 };
  }

  recordInteraction(room.id, peer.user.userId, 'reactions');

  // Fire and forget. No ack, no storage, no history.
  room.broadcast('classroom:reaction', { peerId: peer.id, emoji });

  return { ok: true };
};

export const clearRoom = (roomId) => recent.delete(roomId);
export const resetReactions = () => recent.clear();

export default { send, ALLOWED };