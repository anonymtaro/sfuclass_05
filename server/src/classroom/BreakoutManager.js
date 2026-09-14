// classroom-app/server/src/classroom/BreakoutManager.js
/**
 * Breakout rooms  (F1)  [NEW]
 *
 * Splits a class into small groups and brings it back.
 *
 * A breakout is a real Room with its own router, not a filtered view of the
 * parent. Anything else would mean every group's media flowing to every
 * participant and being discarded client-side — which is exactly the bandwidth
 * problem an SFU exists to solve.
 *
 * Breakouts live on the same node as their parent. They could be spread across
 * the cluster, but a recall would then have to renegotiate every peer against a
 * different node, and the parent is where everyone is going back to anyway.
 *
 * The host is not assigned to a group. They move between them, which is what
 * teachers actually do, and they can broadcast to all groups at once.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'breakouts' });

/** parentRoomId -> session */
const sessions = new Map();

export const isOpen = (roomId) => sessions.has(roomId);

export const getSession = (roomId) => {
  const session = sessions.get(roomId);
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    openedAt: session.openedAt,
    endsAt: session.endsAt,
    groups: session.groups.map((group) => ({
      breakoutId: group.breakoutId,
      name: group.name,
      peerIds: [...group.peerIds],
      size: group.peerIds.size,
    })),
  };
};

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * @param {{ parent: import('./Room.js').Room, groups: {name: string, peerIds: string[]}[], durationMin?: number|null }} options
 */
export const open = async ({ parent, groups, durationMin = null }) => {
  if (sessions.has(parent.id)) {
    throw Object.assign(new Error('breakouts are already open'), { code: 'conflict' });
  }
  if (groups.length === 0) {
    throw Object.assign(new Error('at least one group is required'), { code: 'validation_failed' });
  }

  const { createRoom } = await import('./RoomManager.js');
  const sessionId = randomUUID();
  const endsAt = durationMin ? new Date(Date.now() + durationMin * 60_000).toISOString() : null;

  const created = [];

  for (const [index, definition] of groups.entries()) {
    const breakoutId = `${parent.id}:b${index + 1}`;

    const room = await createRoom({
      roomId: breakoutId,
      lessonId: parent.lessonId,
      // Seminar defaults regardless of the parent's mode: a group of four
      // people arriving muted with a waiting room is nobody's intention.
      mode: 'seminar',
      hostUserId: parent.hostUserId,
      breakoutParent: parent.id,
    });

    parent.breakouts.set(breakoutId, room);

    created.push({
      breakoutId,
      name: definition.name,
      room,
      peerIds: new Set(definition.peerIds),
    });
  }

  const session = { sessionId, openedAt: new Date().toISOString(), endsAt, groups: created, timer: null };

  // Each learner is told where to go. The client leaves the parent room and
  // joins the breakout, which is a normal join — no special path.
  for (const group of created) {
    for (const peerId of group.peerIds) {
      const peer = parent.getPeer(peerId);
      if (!peer) continue;
      peer.breakoutId = group.breakoutId;
      parent.sendTo(peerId, 'classroom:breakout.changed', {
        breakoutId: group.breakoutId,
        endsAt,
      });
    }
  }

  if (durationMin) {
    session.timer = setTimeout(() => {
      void recall({ parent }).catch((cause) =>
        log.error({ err: cause, roomId: parent.id }, 'automatic recall failed'),
      );
    }, durationMin * 60_000);
    session.timer.unref();
  }

  sessions.set(parent.id, session);
  log.info({ roomId: parent.id, groups: created.length, durationMin }, 'breakouts opened');

  return getSession(parent.id);
};

// ---------------------------------------------------------------------------
// During
// ---------------------------------------------------------------------------

/** A message from the host into every group at once. */
export const broadcast = ({ parent, message, from }) => {
  const session = sessions.get(parent.id);
  if (!session) return 0;

  for (const group of session.groups) {
    group.room.broadcast('classroom:breakout.message', {
      message,
      from: from?.user?.displayName ?? 'Host',
      at: new Date().toISOString(),
    });
  }
  return session.groups.length;
};

/** The host visiting a group. They keep their host role inside it. */
export const join = ({ parent, peerId, breakoutId }) => {
  const session = sessions.get(parent.id);
  const group = session?.groups.find((entry) => entry.breakoutId === breakoutId);
  if (!group) return null;

  const peer = parent.getPeer(peerId);
  if (peer) peer.breakoutId = breakoutId;

  parent.sendTo(peerId, 'classroom:breakout.changed', {
    breakoutId,
    endsAt: session.endsAt,
  });
  return { breakoutId };
};

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

/**
 * Ends every group and sends everyone back.
 *
 * The order matters: people are told to return *before* the rooms close, so
 * their clients reconnect to the parent rather than discovering a dead room.
 */
export const recall = async ({ parent, graceSec = 10 }) => {
  const session = sessions.get(parent.id);
  if (!session) return null;

  if (session.timer) clearTimeout(session.timer);
  sessions.delete(parent.id);

  for (const group of session.groups) {
    group.room.broadcast('classroom:breakout.changed', {
      breakoutId: null,
      endsAt: null,
      graceSec,
    });
  }

  // A short grace period so clients can renegotiate against the parent before
  // their current router disappears underneath them.
  await new Promise((resolve) => setTimeout(resolve, graceSec * 1_000));

  const { closeRoom } = await import('./RoomManager.js');
  for (const group of session.groups) {
    parent.breakouts.delete(group.breakoutId);
    await closeRoom(group.breakoutId, 'recalled').catch(() => undefined);
  }

  for (const peer of parent.peers.values()) peer.breakoutId = null;

  log.info({ roomId: parent.id, groups: session.groups.length }, 'breakouts recalled');
  return { recalled: session.groups.length };
};

/** Evenly distributes peers into `count` groups, host excluded. */
export const autoAssign = (parent, count) => {
  const learners = [...parent.peers.values()].filter((peer) => !peer.isHost);
  const groups = Array.from({ length: count }, (_, index) => ({
    name: `Group ${index + 1}`,
    peerIds: [],
  }));

  // Round-robin rather than chunking: chunking puts everyone who joined late
  // in the last group, which in a classroom is a real pattern.
  learners.forEach((peer, index) => {
    groups[index % count].peerIds.push(peer.id);
  });

  return groups;
};

/** Tests only. */
export const resetBreakouts = () => {
  for (const session of sessions.values()) if (session.timer) clearTimeout(session.timer);
  sessions.clear();
};

export default { open, recall, broadcast, join, autoAssign, isOpen };