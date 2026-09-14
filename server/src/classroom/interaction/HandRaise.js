// classroom-app/server/src/classroom/interaction/HandRaise.js
/**
 * Hand raising  (F1)  [NEW]
 *
 * A queue, not a flag. The order people raised their hands in is the whole
 * point — a teacher looking at an unordered list of six raised hands has to
 * guess who was first, and gets it wrong.
 *
 * State lives in memory on the SFU node. A hand raised in a lesson does not
 * need to survive a node failure: the lesson does not survive it either.
 */

import { recordInteraction } from '../AttendanceService.js';

/** roomId -> Map<peerId, { raisedAt, order }> */
const queues = new Map();

const queueFor = (roomId) => {
  let queue = queues.get(roomId);
  if (!queue) {
    queue = new Map();
    queues.set(roomId, queue);
  }
  return queue;
};

export const raise = (room, peer) => {
  const queue = queueFor(room.id);
  if (queue.has(peer.id)) return list(room.id);

  queue.set(peer.id, { raisedAt: Date.now(), order: queue.size + 1 });
  peer.handRaised = true;
  peer.handRaisedAt = new Date().toISOString();

  recordInteraction(room.id, peer.user.userId, 'handRaises');
  room.broadcast('classroom:hand.raised', { peerId: peer.id, raised: true });

  return list(room.id);
};

export const lower = (room, peer) => {
  const queue = queueFor(room.id);
  if (!queue.delete(peer.id)) return list(room.id);

  peer.handRaised = false;
  peer.handRaisedAt = null;
  room.broadcast('classroom:hand.raised', { peerId: peer.id, raised: false });

  return list(room.id);
};

export const set = (room, peer, raised) => (raised ? raise(room, peer) : lower(room, peer));

/** Everyone's hands down. Used after a question has been answered. */
export const clear = (room, actor) => {
  if (!actor?.canModerate) {
    throw Object.assign(new Error('only a host may clear hands'), { code: 'not_room_host' });
  }

  const queue = queueFor(room.id);
  for (const peerId of queue.keys()) {
    const peer = room.getPeer(peerId);
    if (peer) {
      peer.handRaised = false;
      peer.handRaisedAt = null;
    }
  }
  queue.clear();
  room.broadcast('classroom:hand.cleared', { by: actor.user.displayName });
  return 0;
};

/** Oldest first. The teacher reads this top to bottom. */
export const list = (roomId) => {
  const queue = queues.get(roomId);
  if (!queue) return [];
  return [...queue.entries()]
    .sort(([, a], [, b]) => a.raisedAt - b.raisedAt)
    .map(([peerId, entry], index) => ({
      peerId,
      position: index + 1,
      waitingSec: Math.round((Date.now() - entry.raisedAt) / 1000),
    }));
};

export const next = (room) => {
  const [first] = list(room.id);
  if (!first) return null;
  const peer = room.getPeer(first.peerId);
  if (peer) lower(room, peer);
  return peer;
};

export const removePeer = (roomId, peerId) => queues.get(roomId)?.delete(peerId);
export const clearRoom = (roomId) => queues.delete(roomId);
export const resetHands = () => queues.clear();

export default { raise, lower, set, clear, list, next };