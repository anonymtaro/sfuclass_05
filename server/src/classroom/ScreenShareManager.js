// classroom-app/server/src/classroom/ScreenShareManager.js
/**
 * Presenter lock  (F1)  [NEW]
 *
 * One person shares at a time, by default. The lock is held here, on the
 * server, and that is the whole reason this file exists: two teachers pressing
 * the button in the same second must produce one presenter and one clean
 * rejection, not a race that both clients think they won.
 *
 * The lock is acquired *before* the client opens its platform picker. A user
 * who is going to be refused never sees a dialog, and a dismissed dialog
 * releases the lock again rather than blocking the room.
 *
 * Quality is decided here too, not by the client. SCREENSHARE_MAX_* are the
 * ceilings; a client asking for 4K at 60fps gets the room's profile instead.
 * See the note on why simulcast is off in config/mediasoup.config.js.
 */

import { screenShareProfile } from '../config/mediasoup.config.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'screen-share' });

/** roomId -> { peerId, userId, label, acquiredAt, producerId } */
const locks = new Map();

/** A lock held without a producer arriving is stale after this. */
const PENDING_TIMEOUT_MS = 60_000;

const activeFor = (roomId) => {
  const held = locks.get(roomId);
  if (!held) return null;

  // The client asked, then never produced — a dismissed picker whose release
  // never arrived, or a tab that closed mid-dialog.
  if (!held.producerId && Date.now() - held.acquiredAt > PENDING_TIMEOUT_MS) {
    locks.delete(roomId);
    return null;
  }
  return held;
};

// ---------------------------------------------------------------------------
// Acquire and release
// ---------------------------------------------------------------------------

/**
 * @returns {{ ok: true, profile: object } | { ok: false, code: string, holder?: object }}
 */
export const acquire = (room, peer, { label = null } = {}) => {
  if (!peer.canModerate && !room.settings.learnersMayShare) {
    return { ok: false, code: 'forbidden', reason: 'Only the host can share in this room.' };
  }

  const held = activeFor(room.id);

  if (held && held.peerId !== peer.id) {
    // The host may take over; anyone else has to wait.
    if (!peer.isHost) {
      return {
        ok: false,
        code: 'screen_share_taken',
        holder: { peerId: held.peerId, userId: held.userId },
      };
    }
    revoke(room, held.peerId, 'taken-over');
  }

  locks.set(room.id, {
    peerId: peer.id,
    userId: peer.user.userId,
    label,
    acquiredAt: Date.now(),
    producerId: null,
  });

  log.info({ roomId: room.id, peerId: peer.id }, 'screen share lock acquired');

  // The client is told what to encode; it does not get to choose.
  return { ok: true, profile: screenShareProfile };
};

/**
 * The producer arrived. Until this happens the lock is only reserved, which is
 * what the pending timeout above cleans up.
 */
export const attachProducer = (room, peer, producer, { label } = {}) => {
  const held = locks.get(room.id);
  if (!held || held.peerId !== peer.id) {
    // Produced without holding the lock. Close it rather than letting a second
    // share appear for everyone.
    producer.close();
    return { ok: false, code: 'screen_share_taken' };
  }

  held.producerId = producer.id;
  held.label = label ?? held.label;

  producer.appData = {
    ...producer.appData,
    source: 'screen',
    label: held.label,
    startedAt: new Date().toISOString(),
  };

  const started = {
    peerId: peer.id,
    user: peer.toJSON().user,
    producerId: producer.id,
    audioProducerId: peer.producers.screenAudio?.id ?? null,
    label: held.label,
    startedAt: producer.appData.startedAt,
  };

  room.broadcast('classroom:screenShare.started', started);

  // The recording follows the lesson: a share that starts becomes the source.
  void import('../mediasoup/recording/recordingPipeline.js')
    .then(({ followRoomChange }) => followRoomChange({ room, reason: 'screen-share-started' }))
    .catch(() => undefined);

  return { ok: true, started };
};

export const release = (room, peerId, reason = 'stopped') => {
  const held = locks.get(room.id);
  if (!held || held.peerId !== peerId) return false;

  locks.delete(room.id);

  const peer = room.getPeer(peerId);
  const producerId = held.producerId;
  peer?.closeScreenShare();

  room.broadcast('classroom:screenShare.stopped', {
    peerId,
    producerId: producerId ?? '',
    reason,
  });

  void import('../mediasoup/recording/recordingPipeline.js')
    .then(({ followRoomChange }) => followRoomChange({ room, reason: 'screen-share-stopped' }))
    .catch(() => undefined);

  log.info({ roomId: room.id, peerId, reason }, 'screen share released');
  return true;
};

/** A host ending somebody else's share. Distinct from `release` so the client
 *  can say "the host stopped your share" rather than nothing. */
export const revoke = (room, peerId, reason = 'revoked') => release(room, peerId, reason);

/** A peer leaving or disconnecting must not leave the lock behind. */
export const releaseForPeer = (room, peerId) => {
  const held = locks.get(room.id);
  if (held?.peerId === peerId) release(room, peerId, 'disconnected');
};

export const getPresenter = (roomId) => activeFor(roomId);

export const isSharing = (roomId, peerId) => activeFor(roomId)?.peerId === peerId;

export const clearRoom = (roomId) => locks.delete(roomId);

/** Tests only. */
export const resetScreenShareLocks = () => locks.clear();

export default { acquire, attachProducer, release, revoke, getPresenter };