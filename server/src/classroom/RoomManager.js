// classroom-app/server/src/classroom/RoomManager.js
/**
 * Room registry, in-process  (F1)  [UNCHANGED]
 *
 * Reference implementation. Behaviour is as in version 5; if your file differs,
 * keep yours. Version 6 needs three things from it, all marked below:
 * `getRoomCount`, `getProducerCount` and `handleWorkerLoss`.
 *
 * This is the node's own view of what it is carrying. The cluster-wide view —
 * which node holds which room — is RoomRegistry.js, in Redis.
 */

import { createRouter } from '../mediasoup/createRouter.js';
import { registerCounters } from '../mediasoup/health.js';
import { canAcceptRoom } from '../lifecycle/drainSfu.js';
import { logger } from '../observability/logger.js';
import { Room } from './Room.js';

const log = logger.child({ component: 'room-manager' });

/** @type {Map<string, Room>} */
const rooms = new Map();

let emitter = () => {};

/** Injected at boot by signaling/, so this module never imports a socket. */
export const setEmitter = (fn) => {
  emitter = fn;
};

export const createRoom = async ({ roomId, lessonId = null, mode = 'seminar', hostUserId = null, breakoutParent = null }) => {
  const existing = rooms.get(roomId);
  if (existing && !existing.closed) return existing;

  // A draining node must not take new work, and a node at capacity must not
  // either. Both are checked here rather than at the call site, so no code
  // path can skip them.
  if (!canAcceptRoom()) {
    throw new Error('this node is draining and cannot accept new rooms');
  }

  const { router, worker } = await createRouter(roomId);

  const room = new Room({
    id: roomId,
    router,
    worker,
    lessonId,
    mode,
    hostUserId,
    breakoutParent,
    emit: (event, payload, options) => emitter(event, payload, { roomId, ...options }),
  });

  await room.startAudioLevelObserver();
  rooms.set(roomId, room);

  log.info({ roomId, lessonId, mode, breakout: Boolean(breakoutParent) }, 'room created');
  return room;
};

export const getRoom = (roomId) => rooms.get(roomId) ?? null;

export const closeRoom = async (roomId, reason = 'ended-by-host') => {
  const room = rooms.get(roomId);
  if (!room) return false;

  // A recording in progress has to be finalised before the router closes,
  // or the last segment is lost.
  const { handleRoomClosed } = await import('../mediasoup/recording/recordingPipeline.js');
  await handleRoomClosed(roomId).catch(() => undefined);

  // Breakouts die with their parent; leaving them would orphan their peers.
  for (const breakoutId of room.breakouts.keys()) {
    await closeRoom(breakoutId, 'parent-closed');
  }

  room.close(reason);
  rooms.delete(roomId);

  const { releaseRoom } = await import('./RoomRegistry.js');
  await releaseRoom(roomId).catch(() => undefined);

  log.info({ roomId, reason }, 'room closed');
  return true;
};

/** Read by mediasoup/health.js and by the drain wait. */
export const getRoomCount = () => rooms.size;

export const getProducerCount = () => {
  let total = 0;
  for (const room of rooms.values()) total += room.producerCount;
  return total;
};

export const listRooms = () => [...rooms.values()].map((room) => room.stats());

/**
 * A mediasoup worker died and took its routers with it. The rooms are already
 * gone; this tells the people who were in them, rather than leaving their
 * clients to discover it when the media stops.
 */
export const handleWorkerLoss = (roomIds) => {
  for (const roomId of roomIds) {
    const room = rooms.get(roomId);
    if (!room) continue;

    room.broadcast('classroom:room.closed', { reason: 'error', reconnectNodeId: null });
    room.closed = true;
    rooms.delete(roomId);

    log.error({ roomId, peers: room.peerCount }, 'room lost with its worker');
  }
};

/** Shutdown step: end everything still running on this node. */
export const closeAllRooms = async (reason = 'node-drained') => {
  const ids = [...rooms.keys()];
  for (const roomId of ids) await closeRoom(roomId, reason).catch(() => undefined);
  return ids.length;
};

// Health reads its load numbers from here.
registerCounters({ rooms: getRoomCount, producers: getProducerCount });

export default { createRoom, getRoom, closeRoom, getRoomCount };