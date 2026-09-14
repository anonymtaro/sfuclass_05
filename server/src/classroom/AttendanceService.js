// classroom-app/server/src/classroom/AttendanceService.js
/**
 * Attendance  (F1)  [NEW]
 *
 * A join/leave ledger per room, turned into a per-person attendance record when
 * the session ends.
 *
 * Two things make this less trivial than it sounds:
 *
 *   Reconnections. A phone switching from wifi to mobile data produces a leave
 *   and a join thirty seconds apart. Counted naively that is two attendances
 *   and a gap; counted properly it is one, with a short interruption. Intervals
 *   closer together than RECONNECT_GRACE_SEC are merged.
 *
 *   Presence is not attendance. Someone who joins, mutes, and walks away has a
 *   long duration and no participation. The record therefore carries both:
 *   `durationSec` for how long they were connected and the interaction counts
 *   for what they actually did. Whoever reads the report decides which matters.
 *
 * Written to the database on room close, not on every event — a lecture with
 * two hundred people reconnecting on a bad network would otherwise be a write
 * per person per drop.
 */

import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'attendance' });

/** Two intervals closer than this are one attendance with a blip in the middle. */
const RECONNECT_GRACE_SEC = 120;

/** roomId -> Map<userId, record> */
const ledgers = new Map();

const ledgerFor = (roomId) => {
  let ledger = ledgers.get(roomId);
  if (!ledger) {
    ledger = new Map();
    ledgers.set(roomId, ledger);
  }
  return ledger;
};

// ---------------------------------------------------------------------------
// Recording events
// ---------------------------------------------------------------------------

export const recordJoin = (room, peer) => {
  const ledger = ledgerFor(room.id);
  const userId = peer.user.userId;
  const now = Date.now();

  const existing = ledger.get(userId);

  if (existing) {
    const last = existing.intervals.at(-1);
    // Still marked present: a duplicate join, or a second device.
    if (last && last.leftAt === null) return existing;

    if (last && (now - last.leftAt) / 1000 <= RECONNECT_GRACE_SEC) {
      // Reopen the previous interval instead of starting a new one.
      last.leftAt = null;
      existing.reconnects += 1;
      return existing;
    }

    existing.intervals.push({ joinedAt: now, leftAt: null });
    return existing;
  }

  const record = {
    userId,
    displayName: peer.user.displayName,
    role: peer.role,
    intervals: [{ joinedAt: now, leftAt: null }],
    reconnects: 0,
    interactions: { messages: 0, reactions: 0, handRaises: 0, pollVotes: 0, sharedScreen: false },
    firstJoinedAt: new Date(now).toISOString(),
  };

  ledger.set(userId, record);
  return record;
};

export const recordLeave = (room, peer) => {
  const record = ledgers.get(room.id)?.get(peer.user.userId);
  const open = record?.intervals.at(-1);
  if (!open || open.leftAt !== null) return record ?? null;

  open.leftAt = Date.now();
  return record;
};

/**
 * Counts something the person did. Called from the interaction modules, so
 * participation is measured where it happens rather than inferred later.
 */
export const recordInteraction = (roomId, userId, kind) => {
  const record = ledgers.get(roomId)?.get(userId);
  if (!record) return;

  if (kind === 'screenShare') {
    record.interactions.sharedScreen = true;
    return;
  }
  if (kind in record.interactions) record.interactions[kind] += 1;
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const summarise = (record, sessionEndedAt) => {
  const durationSec = record.intervals.reduce((total, interval) => {
    const end = interval.leftAt ?? sessionEndedAt;
    return total + Math.max(0, Math.round((end - interval.joinedAt) / 1000));
  }, 0);

  const interactions = record.interactions;
  const participated =
    interactions.messages > 0 ||
    interactions.handRaises > 0 ||
    interactions.pollVotes > 0 ||
    interactions.sharedScreen;

  return {
    userId: record.userId,
    displayName: record.displayName,
    role: record.role,
    firstJoinedAt: record.firstJoinedAt,
    lastLeftAt: new Date(record.intervals.at(-1).leftAt ?? sessionEndedAt).toISOString(),
    durationSec,
    reconnects: record.reconnects,
    interactions,
    participated,
  };
};

/** Live view, for the host's participant panel. */
export const currentReport = (roomId) => {
  const ledger = ledgers.get(roomId);
  if (!ledger) return [];
  const now = Date.now();
  return [...ledger.values()].map((record) => summarise(record, now));
};

/**
 * Closes the ledger and persists it. Called on room close, before the room's
 * peers are cleared — after that the display names are gone.
 *
 * @returns {Promise<{ roomId: string, attendees: number, persisted: boolean }>}
 */
export const finalise = async ({ room, lessonId = null }) => {
  const ledger = ledgers.get(room.id);
  if (!ledger) return { roomId: room.id, attendees: 0, persisted: false };

  ledgers.delete(room.id);
  const endedAt = Date.now();

  // Anyone still connected when the room ends left at that moment.
  for (const record of ledger.values()) {
    const open = record.intervals.at(-1);
    if (open && open.leftAt === null) open.leftAt = endedAt;
  }

  const attendees = [...ledger.values()].map((record) => summarise(record, endedAt));

  try {
    const { saveAttendance } = await import('../courses/ProgressService.js');
    await saveAttendance({
      roomId: room.id,
      lessonId: lessonId ?? room.lessonId,
      endedAt: new Date(endedAt).toISOString(),
      attendees,
    });

    log.info({ roomId: room.id, attendees: attendees.length }, 'attendance saved');
    return { roomId: room.id, attendees: attendees.length, persisted: true };
  } catch (cause) {
    // Not fatal to the lesson, but worth an alarm: an unsaved register is a
    // support ticket from whoever has to mark it.
    log.error({ err: cause, roomId: room.id }, 'could not save attendance');
    return { roomId: room.id, attendees: attendees.length, persisted: false, report: attendees };
  }
};

/** Tests only. */
export const resetAttendance = () => ledgers.clear();

export default { recordJoin, recordLeave, recordInteraction, currentReport, finalise };