// classroom-app/server/src/classroom/interaction/Whiteboard.js
/**
 * Whiteboard  (F1, F3)  [NEW]
 *
 * A Yjs document per room, served over the same collaboration server the course
 * builder uses (realtime/collabServer.js).
 *
 * A CRDT rather than a broadcast of drawing operations, because two people
 * drawing at once is the normal case, not the exception. Operational
 * transformation would need a central authority ordering every stroke; a CRDT
 * converges without one, which also means a peer that reconnects after thirty
 * seconds offline merges their strokes in rather than losing them.
 *
 * This module owns the document's lifecycle — creation, snapshots, access
 * control and cleanup. The actual sync protocol is the collab server's job, and
 * deliberately not reimplemented here.
 *
 * Persistence is a periodic snapshot, not every update. A busy board produces
 * hundreds of updates a second and none of them individually matter; what
 * matters is that reopening the lesson shows the board as it was.
 */

import { logger } from '../../observability/logger.js';

const log = logger.child({ component: 'whiteboard' });

/** How often a changed board is written back. */
const SNAPSHOT_INTERVAL_MS = 30_000;

/** roomId -> board */
const boards = new Map();

const docName = (roomId) => `whiteboard:${roomId}`;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Opens the board for a room, restoring the last snapshot if there is one.
 * Idempotent: every peer that opens the panel calls this.
 */
export const open = async (room, { restore = true } = {}) => {
  const existing = boards.get(room.id);
  if (existing) return view(existing);

  const { getOrCreateDoc } = await import('../../realtime/collabServer.js');

  const doc = await getOrCreateDoc(docName(room.id));

  if (restore && room.lessonId) {
    try {
      const { loadWhiteboardSnapshot } = await import('../../courses/CourseService.js');
      const snapshot = await loadWhiteboardSnapshot(room.lessonId);
      if (snapshot) {
        const Y = await import('yjs');
        Y.applyUpdate(doc, snapshot);
        log.info({ roomId: room.id, lessonId: room.lessonId }, 'whiteboard restored');
      }
    } catch (cause) {
      // An empty board is a worse outcome than a slow one, but not a fatal
      // one — the lesson continues with a blank canvas.
      log.error({ err: cause, roomId: room.id }, 'could not restore the whiteboard');
    }
  }

  const board = {
    roomId: room.id,
    lessonId: room.lessonId,
    docName: docName(room.id),
    doc,
    /** Everyone may draw unless the host says otherwise. */
    learnersMayDraw: room.settings.learnersMayShare !== false,
    dirty: false,
    openedAt: new Date().toISOString(),
    timer: null,
  };

  doc.on('update', () => {
    board.dirty = true;
  });

  board.timer = setInterval(() => {
    if (!board.dirty) return;
    void snapshot(room.id).catch((cause) =>
      log.error({ err: cause, roomId: room.id }, 'whiteboard snapshot failed'),
    );
  }, SNAPSHOT_INTERVAL_MS);
  board.timer.unref();

  boards.set(room.id, board);
  room.broadcast('classroom:whiteboard.opened', view(board));

  return view(board);
};

/**
 * Whether a peer may write to the board. Enforced by the collab server on every
 * update — a CRDT accepts anything it is given, so the authority check has to
 * happen before the update reaches the document.
 */
export const canDraw = (room, peer) => {
  const board = boards.get(room.id);
  if (!board) return false;
  if (peer.canModerate) return true;
  return board.learnersMayDraw;
};

export const setLearnersMayDraw = (room, actor, allowed) => {
  if (!actor?.canModerate) {
    throw Object.assign(new Error('only a host may change this'), { code: 'not_room_host' });
  }
  const board = boards.get(room.id);
  if (!board) return false;

  board.learnersMayDraw = allowed;
  room.broadcast('classroom:whiteboard.permissions', { learnersMayDraw: allowed });
  return allowed;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Writes the current state back against the lesson. */
export const snapshot = async (roomId) => {
  const board = boards.get(roomId);
  if (!board || !board.lessonId) return null;

  const Y = await import('yjs');
  const update = Y.encodeStateAsUpdate(board.doc);

  const { saveWhiteboardSnapshot } = await import('../../courses/CourseService.js');
  await saveWhiteboardSnapshot(board.lessonId, update);

  board.dirty = false;
  return { bytes: update.byteLength, at: new Date().toISOString() };
};

/**
 * Clears the board. The undo history goes with it — a CRDT keeps every deleted
 * stroke as a tombstone, so "clear" on a long lesson is also what stops the
 * document growing without bound.
 */
export const clear = async (room, actor) => {
  if (!actor?.canModerate) {
    throw Object.assign(new Error('only a host may clear the board'), { code: 'not_room_host' });
  }

  const board = boards.get(room.id);
  if (!board) return false;

  const { replaceDoc } = await import('../../realtime/collabServer.js');
  board.doc = await replaceDoc(board.docName);
  board.dirty = true;

  room.broadcast('classroom:whiteboard.cleared', { by: actor.user.displayName });
  return true;
};

/**
 * Room is ending. Snapshot before the document is dropped, or the board is
 * lost — which for a lesson somebody spent an hour drawing on is the failure
 * people remember.
 */
export const close = async (roomId) => {
  const board = boards.get(roomId);
  if (!board) return null;

  if (board.timer) clearInterval(board.timer);
  boards.delete(roomId);

  if (board.dirty) {
    boards.set(roomId, board); // snapshot() reads it back
    await snapshot(roomId).catch((cause) =>
      log.error({ err: cause, roomId }, 'final whiteboard snapshot failed'),
    );
    boards.delete(roomId);
  }

  const { releaseDoc } = await import('../../realtime/collabServer.js');
  await releaseDoc(board.docName).catch(() => undefined);

  return { roomId, saved: true };
};

const view = (board) => ({
  roomId: board.roomId,
  docName: board.docName,
  learnersMayDraw: board.learnersMayDraw,
  openedAt: board.openedAt,
});

export const current = (roomId) => {
  const board = boards.get(roomId);
  return board ? view(board) : null;
};

/** Tests only. */
export const resetWhiteboards = () => {
  for (const board of boards.values()) if (board.timer) clearInterval(board.timer);
  boards.clear();
};

export default { open, close, clear, canDraw, snapshot, current };