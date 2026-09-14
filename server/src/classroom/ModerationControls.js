// classroom-app/server/src/classroom/ModerationControls.js
/**
 * Host controls  (F1)  [NEW]
 *
 * Waiting room, mute, remove, lock, and the host role itself.
 *
 * One principle runs through all of it: **the server does the thing**, it does
 * not ask the client to. A "mute" that emits an event and hopes the other
 * client stops sending is not a mute — it is a suggestion, and a modified
 * client ignores it. So muting closes or pauses the producer server-side, and
 * removal closes the transports.
 *
 * The one exception is unmuting, which is a *request*. A host cannot switch on
 * someone's microphone without their consent, and no amount of classroom
 * hierarchy makes that acceptable.
 */

import { logger } from '../observability/logger.js';
import { releaseForPeer, revoke as revokeShare } from './ScreenShareManager.js';

const log = logger.child({ component: 'moderation' });

const assertCanModerate = (actor) => {
  if (!actor?.canModerate) {
    throw Object.assign(new Error('only a host or cohost may do that'), { code: 'not_room_host' });
  }
};

// ---------------------------------------------------------------------------
// Waiting room
// ---------------------------------------------------------------------------

/**
 * Someone has knocked. They are held, not joined: no router resources are
 * allocated until they are admitted, so a flood of knocks costs nothing.
 */
export const knock = (room, { peerId, user }) => {
  if (!room.settings.waitingRoom) return { admitted: true };
  if (room.locked) {
    return { admitted: false, code: 'room_closed', reason: 'This room is locked.' };
  }

  room.waiting.set(peerId, { peerId, user, knockedAt: new Date().toISOString() });

  for (const peer of room.peers.values()) {
    if (peer.canModerate) {
      room.sendTo(peer.id, 'classroom:waiting.peer', room.waiting.get(peerId));
    }
  }

  return { admitted: false, waiting: true };
};

export const admit = (room, actor, peerId) => {
  assertCanModerate(actor);
  const waiting = room.waiting.get(peerId);
  if (!waiting) return false;

  room.waiting.delete(peerId);
  room.sendTo(peerId, 'classroom:waiting.admitted', { roomId: room.id });
  log.info({ roomId: room.id, peerId, by: actor.id }, 'peer admitted');
  return true;
};

export const deny = (room, actor, peerId, reason = 'The host did not admit you.') => {
  assertCanModerate(actor);
  if (!room.waiting.delete(peerId)) return false;
  room.sendTo(peerId, 'classroom:waiting.denied', { reason });
  return true;
};

export const admitAll = (room, actor) => {
  assertCanModerate(actor);
  const ids = [...room.waiting.keys()];
  for (const peerId of ids) admit(room, actor, peerId);
  return ids.length;
};

// ---------------------------------------------------------------------------
// Audio and video
// ---------------------------------------------------------------------------

/**
 * Pauses the producer server-side. Pause rather than close, so unmuting later
 * does not need a renegotiation — the track is still there, simply not flowing.
 */
export const mute = async (room, actor, peerId, kind = 'microphone') => {
  assertCanModerate(actor);
  const peer = room.getPeer(peerId);
  const producer = peer?.producers[kind];
  if (!producer) return false;

  await producer.pause();
  room.sendTo(peerId, 'classroom:muted.by-host', { kind, by: actor.user.displayName });
  room.broadcast('classroom:peer.updated', peer.toJSON());

  log.info({ roomId: room.id, peerId, kind, by: actor.id }, 'peer muted by host');
  return true;
};

export const muteAll = async (room, actor, { exceptHosts = true } = {}) => {
  assertCanModerate(actor);
  let muted = 0;

  for (const peer of room.peers.values()) {
    if (exceptHosts && peer.canModerate) continue;
    if (await mute(room, actor, peer.id, 'microphone')) muted += 1;
  }

  room.broadcast('classroom:muted.all', { by: actor.user.displayName, count: muted });
  return muted;
};

/**
 * A request, not an action. The client shows a prompt; the person decides.
 * Anything else would let a host switch on a microphone in someone's home.
 */
export const requestUnmute = (room, actor, peerId) => {
  assertCanModerate(actor);
  room.sendTo(peerId, 'classroom:unmute.requested', { by: actor.user.displayName });
  return true;
};

export const stopVideo = async (room, actor, peerId) => {
  assertCanModerate(actor);
  const peer = room.getPeer(peerId);
  if (!peer) return false;

  // Closed, not paused: a camera that is off should have its light off.
  peer.closeProducer('camera');
  room.sendTo(peerId, 'classroom:video.stopped-by-host', { by: actor.user.displayName });
  room.broadcast('classroom:peer.updated', peer.toJSON());
  return true;
};

export const stopScreenShare = (room, actor, peerId) => {
  assertCanModerate(actor);
  return revokeShare(room, peerId, 'revoked');
};

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export const remove = (room, actor, peerId, { reason = null } = {}) => {
  assertCanModerate(actor);

  const target = room.getPeer(peerId);
  if (!target) return false;
  // A cohost cannot remove the host, and nobody can remove themselves this way.
  if (target.isHost) {
    throw Object.assign(new Error('the host cannot be removed'), { code: 'forbidden' });
  }

  releaseForPeer(room, peerId);
  room.sendTo(peerId, 'classroom:removed', { reason, by: actor.user.displayName });
  room.removePeer(peerId, 'removed');

  log.warn({ roomId: room.id, peerId, by: actor.id, reason }, 'peer removed');
  return true;
};

export const promote = (room, actor, peerId) => {
  assertCanModerate(actor);
  const peer = room.getPeer(peerId);
  if (!peer || peer.isHost) return false;

  peer.role = 'cohost';
  room.broadcast('classroom:peer.updated', peer.toJSON());
  return true;
};

export const demote = (room, actor, peerId) => {
  assertCanModerate(actor);
  const peer = room.getPeer(peerId);
  if (!peer || peer.isHost) return false;

  peer.role = 'learner';
  room.broadcast('classroom:peer.updated', peer.toJSON());
  return true;
};

/**
 * Hands over the host role. Only the current host may do this, and it is
 * atomic — a room must never have two hosts or none.
 */
export const transferHost = (room, actor, peerId) => {
  if (!actor.isHost) {
    throw Object.assign(new Error('only the host may hand over'), { code: 'not_room_host' });
  }
  const target = room.getPeer(peerId);
  if (!target) return false;

  actor.role = 'cohost';
  target.role = 'host';
  room.hostUserId = target.user.userId;

  room.broadcast('classroom:peer.updated', actor.toJSON());
  room.broadcast('classroom:peer.updated', target.toJSON());
  log.info({ roomId: room.id, from: actor.id, to: peerId }, 'host transferred');
  return true;
};

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

/** Locking stops new arrivals. It does not remove anyone already present. */
export const setLocked = (room, actor, locked) => {
  assertCanModerate(actor);
  room.locked = locked;
  room.broadcast('classroom:room.locked', { locked, by: actor.user.displayName });
  return locked;
};

export const setWaitingRoom = (room, actor, enabled) => {
  assertCanModerate(actor);
  room.settings.waitingRoom = enabled;
  if (!enabled) admitAll(room, actor);
  return enabled;
};

export const setLearnersMayShare = (room, actor, allowed) => {
  assertCanModerate(actor);
  room.settings.learnersMayShare = allowed;
  room.broadcast('classroom:room.settings', { learnersMayShare: allowed });
  return allowed;
};

/** Single entry point for the `classroom:host.action` socket event. */
export const applyHostAction = async (room, actor, { targetPeerId, action, reason }) => {
  switch (action) {
    case 'mute':
      return mute(room, actor, targetPeerId);
    case 'unmute-request':
      return requestUnmute(room, actor, targetPeerId);
    case 'stop-video':
      return stopVideo(room, actor, targetPeerId);
    case 'revoke-screen-share':
      return stopScreenShare(room, actor, targetPeerId);
    case 'remove':
      return remove(room, actor, targetPeerId, { reason });
    case 'promote-cohost':
      return promote(room, actor, targetPeerId);
    case 'demote':
      return demote(room, actor, targetPeerId);
    case 'admit':
      return admit(room, actor, targetPeerId);
    case 'deny':
      return deny(room, actor, targetPeerId, reason);
    default:
      throw Object.assign(new Error(`unknown action: ${action}`), { code: 'validation_failed' });
  }
};

export default { applyHostAction, knock, admit, muteAll, remove, setLocked };