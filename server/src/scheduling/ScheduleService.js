/**
 * ScheduleService — live lesson slots, timezone-safe. (F1, F3)
 *
 * Owns: when a live lesson happens.
 *
 * Rules this file enforces:
 *  - Instants are stored as timestamptz (UTC). The IANA zone is stored next to them
 *    because "every Tuesday 18:00 Europe/Berlin" is not the same UTC instant all year.
 *  - Wall-clock input is resolved against the zone's real offset, including DST gaps
 *    (02:30 on a spring-forward day) and overlaps (01:30 twice on a fall-back day).
 *  - A session row is the only source of truth. Recurrence is materialised into rows at
 *    creation time so a rule change never silently rewrites history.
 *  - Every write that moves or cancels a session bumps `sequence` and re-syncs reminders
 *    (ReminderRules) — calendar clients use SEQUENCE to accept an update.
 */

import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';
import * as ReminderRules from './ReminderRules.js';

export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 8 * 60;
export const MAX_OCCURRENCES = 200;

const SESSION_COLUMNS = `
  id, tenant_id, series_id, course_id, lesson_id, host_id, room_id,
  title, description, starts_at, ends_at, time_zone, status, sequence,
  waiting_room, recurrence, created_by, created_at, updated_at,
  cancelled_at, cancel_reason
`;

export class ScheduleError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
    this.status = code === 'SESSION_NOT_FOUND' ? 404 : code === 'HOST_CONFLICT' ? 409 : 400;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ *
 * Time zone primitives
 * ------------------------------------------------------------------ */

const formatterCache = new Map();

function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Throws ScheduleError if the zone is not a zone this runtime knows. */
export function assertTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new ScheduleError('INVALID_TIMEZONE', 'A IANA time zone is required');
  }
  try {
    formatterFor(timeZone);
  } catch {
    formatterCache.delete(timeZone);
    throw new ScheduleError('INVALID_TIMEZONE', `Unknown time zone: ${timeZone}`);
  }
  return timeZone;
}

/** Wall-clock parts of a UTC instant, as seen in `timeZone`. */
export function partsInZone(utcMs, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  if (out.hour === 24) out.hour = 0; // h23 still emits 24 on some ICU builds
  return out;
}

function offsetMsAt(utcMs, timeZone) {
  const p = partsInZone(utcMs, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - (utcMs - (utcMs % 1000));
}

function sameWallClock(parts, wall) {
  return (
    parts.year === wall.year &&
    parts.month === wall.month &&
    parts.day === wall.day &&
    parts.hour === wall.hour &&
    parts.minute === wall.minute
  );
}

/**
 * Resolve a local wall clock in a zone to a UTC instant.
 *
 * DST gap      → shifted forward past the gap, reported as `adjusted: 'gap'`.
 * DST overlap  → the first (earlier) of the two instants, `adjusted: 'ambiguous'`.
 *
 * @param {{year:number,month:number,day:number,hour:number,minute:number,second?:number}} wall
 * @returns {{ utcMs:number, adjusted:null|'gap'|'ambiguous' }}
 */
export function wallClockToUtc(wall, timeZone) {
  assertTimeZone(timeZone);
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0);

  const candidateBefore = naive - offsetMsAt(naive - 86_400_000, timeZone);
  const candidateAfter = naive - offsetMsAt(naive + 86_400_000, timeZone);

  if (candidateBefore === candidateAfter) return { utcMs: candidateBefore, adjusted: null };

  const beforeValid = sameWallClock(partsInZone(candidateBefore, timeZone), wall);
  const afterValid = sameWallClock(partsInZone(candidateAfter, timeZone), wall);

  // `candidateBefore` uses the offset in force *before* the transition. In an overlap it
  // is the first of the two identical wall clocks; in a gap it lands past the gap, which
  // is the conventional "shift forward" behaviour.
  if (beforeValid && afterValid) return { utcMs: candidateBefore, adjusted: 'ambiguous' };
  if (beforeValid) return { utcMs: candidateBefore, adjusted: null };
  if (afterValid) return { utcMs: candidateAfter, adjusted: null };
  return { utcMs: candidateBefore, adjusted: 'gap' };
}

/** "2026-09-14T18:00" (+ optional ":ss") in a zone → Date. */
export function parseLocalDateTime(localIso, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(localIso ?? ''));
  if (!match) {
    throw new ScheduleError('INVALID_START', 'startsAtLocal must look like 2026-09-14T18:00');
  }
  const wall = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  const { utcMs, adjusted } = wallClockToUtc(wall, timeZone);
  return { date: new Date(utcMs), wall, adjusted };
}

/* ------------------------------------------------------------------ *
 * Recurrence (materialised, not evaluated at read time)
 * ------------------------------------------------------------------ */

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function addLocalDays(wall, days) {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return {
    ...wall,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function localWeekday(wall) {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

/**
 * Expand a recurrence rule into local wall clocks, then to UTC instants.
 * Supported subset: FREQ=DAILY|WEEKLY, INTERVAL, BYDAY, COUNT, UNTIL (local date).
 * Anything richer belongs in a rule table, not in a scheduler.
 */
export function expandRecurrence(firstWall, timeZone, recurrence) {
  if (!recurrence) return [wallClockToUtc(firstWall, timeZone).utcMs];

  const freq = String(recurrence.freq ?? '').toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY') {
    throw new ScheduleError('INVALID_RECURRENCE', 'recurrence.freq must be DAILY or WEEKLY');
  }
  const interval = Number(recurrence.interval ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) {
    throw new ScheduleError('INVALID_RECURRENCE', 'recurrence.interval must be 1..52');
  }
  const count = recurrence.count == null ? null : Number(recurrence.count);
  if (count != null && (!Number.isInteger(count) || count < 1 || count > MAX_OCCURRENCES)) {
    throw new ScheduleError('INVALID_RECURRENCE', `recurrence.count must be 1..${MAX_OCCURRENCES}`);
  }
  const untilMs = recurrence.until
    ? parseLocalDateTime(`${recurrence.until}T23:59`, timeZone).date.getTime()
    : null;
  if (count == null && untilMs == null) {
    throw new ScheduleError('INVALID_RECURRENCE', 'recurrence needs either count or until');
  }

  const byDay = Array.isArray(recurrence.byDay) && recurrence.byDay.length
    ? recurrence.byDay.map((d) => {
        const index = WEEKDAY_CODES.indexOf(String(d).toUpperCase());
        if (index < 0) throw new ScheduleError('INVALID_RECURRENCE', `Unknown weekday: ${d}`);
        return index;
      })
    : null;

  const instants = [];
  let cursor = { ...firstWall };
  let guard = 0;
  const step = freq === 'DAILY' ? interval : 1;

  while (instants.length < (count ?? MAX_OCCURRENCES) && guard < MAX_OCCURRENCES * 14) {
    guard += 1;
    const weekdayOk = !byDay || byDay.includes(localWeekday(cursor));
    const weekOk =
      freq === 'WEEKLY'
        ? Math.floor(
            (Date.UTC(cursor.year, cursor.month - 1, cursor.day) -
              Date.UTC(firstWall.year, firstWall.month - 1, firstWall.day)) /
              (7 * 86_400_000),
          ) % interval === 0
        : true;

    if (weekdayOk && weekOk) {
      const { utcMs } = wallClockToUtc(cursor, timeZone);
      if (untilMs != null && utcMs > untilMs) break;
      instants.push(utcMs);
    }
    cursor = addLocalDays(cursor, freq === 'WEEKLY' ? 1 : step);
    if (untilMs != null) {
      const probe = wallClockToUtc(cursor, timeZone).utcMs;
      if (probe > untilMs) break;
    }
  }

  if (instants.length === 0) {
    throw new ScheduleError('INVALID_RECURRENCE', 'The recurrence rule produced no occurrences');
  }
  return instants;
}

/* ------------------------------------------------------------------ *
 * Persistence helpers
 * ------------------------------------------------------------------ */

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    seriesId: row.series_id,
    courseId: row.course_id,
    lessonId: row.lesson_id,
    hostId: row.host_id,
    roomId: row.room_id,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timeZone: row.time_zone,
    status: row.status,
    sequence: row.sequence,
    waitingRoom: row.waiting_room,
    recurrence: row.recurrence,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
  };
}

async function audit(event) {
  try {
    const { auditLog } = await import('../security/auditLog.js');
    const write = typeof auditLog === 'function' ? auditLog : auditLog?.record;
    if (write) await write(event);
  } catch (error) {
    logger.warn({ err: error, event: event.action }, 'scheduling: audit write skipped');
  }
}

/* ------------------------------------------------------------------ *
 * Conflict detection
 * ------------------------------------------------------------------ */

/**
 * Sessions of the same host that overlap [startsAt, endsAt).
 * A teacher cannot be in two live rooms, so this is a hard gate rather than a warning.
 */
export async function findHostConflicts({ tenantId, hostId, startsAt, endsAt, excludeSessionIds = [], excludeSeriesId = null }, client = pool) {
  const { rows } = await client.query(
    `select ${SESSION_COLUMNS}
       from scheduled_sessions
      where tenant_id = $1
        and host_id = $2
        and status in ('scheduled', 'live')
        and starts_at < $4
        and ends_at > $3
        and ($5::uuid is null or series_id is distinct from $5)
        and not (id = any($6::uuid[]))
      order by starts_at asc
      limit 10`,
    [tenantId, hostId, startsAt, endsAt, excludeSeriesId, excludeSessionIds],
  );
  return rows.map(mapSession);
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/**
 * Create one session, or a whole materialised series.
 *
 * @param {object} input
 * @param {string} input.tenantId
 * @param {string} input.hostId
 * @param {string} input.title
 * @param {string} input.startsAtLocal  e.g. "2026-09-14T18:00"
 * @param {number} input.durationMinutes
 * @param {string} input.timeZone       IANA zone, e.g. "Europe/Berlin"
 * @param {string} [input.lessonId]     Lesson(type=live) this slot belongs to (F3)
 * @param {string} [input.courseId]     audience shortcut: everyone enrolled
 * @param {string[]} [input.inviteeIds] explicit audience for ad-hoc sessions
 * @param {object} [input.recurrence]   { freq, interval, byDay, count, until }
 * @param {boolean} [input.waitingRoom] default true
 * @param {{ userId:string, ip?:string }} actor
 */
export async function createSession(input, actor) {
  const {
    tenantId,
    hostId,
    title,
    description = null,
    startsAtLocal,
    durationMinutes,
    timeZone,
    lessonId = null,
    courseId = null,
    inviteeIds = [],
    recurrence = null,
    waitingRoom = true,
  } = input;

  if (!tenantId || !hostId) throw new ScheduleError('INVALID_INPUT', 'tenantId and hostId are required');
  if (!title || String(title).trim().length === 0) throw new ScheduleError('INVALID_INPUT', 'title is required');

  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration) || duration < MIN_DURATION_MINUTES || duration > MAX_DURATION_MINUTES) {
    throw new ScheduleError('INVALID_DURATION', `durationMinutes must be ${MIN_DURATION_MINUTES}..${MAX_DURATION_MINUTES}`);
  }

  assertTimeZone(timeZone);
  const first = parseLocalDateTime(startsAtLocal, timeZone);
  if (first.adjusted) {
    logger.info({ timeZone, startsAtLocal, adjusted: first.adjusted }, 'scheduling: DST-adjusted start time');
  }

  const instants = expandRecurrence(first.wall, timeZone, recurrence);
  const seriesId = crypto.randomUUID();
  const durationMs = duration * 60_000;

  const created = await withTransaction(async (client) => {
    const sessions = [];

    for (const startMs of instants) {
      const startsAt = new Date(startMs);
      const endsAt = new Date(startMs + durationMs);

      const conflicts = await findHostConflicts(
        { tenantId, hostId, startsAt, endsAt, excludeSeriesId: null },
        client,
      );
      if (conflicts.length > 0) {
        throw new ScheduleError('HOST_CONFLICT', 'The host already has a session in this slot', {
          startsAt,
          conflictWith: conflicts.map((c) => ({ id: c.id, title: c.title, startsAt: c.startsAt })),
        });
      }

      const { rows } = await client.query(
        `insert into scheduled_sessions
           (tenant_id, series_id, course_id, lesson_id, host_id, title, description,
            starts_at, ends_at, time_zone, status, sequence, waiting_room, recurrence, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'scheduled',0,$11,$12,$13)
         returning ${SESSION_COLUMNS}`,
        [
          tenantId,
          recurrence ? seriesId : null,
          courseId,
          lessonId,
          hostId,
          String(title).trim(),
          description,
          startsAt,
          endsAt,
          timeZone,
          waitingRoom,
          recurrence ? JSON.stringify(recurrence) : null,
          actor?.userId ?? hostId,
        ],
      );
      const session = mapSession(rows[0]);

      if (inviteeIds.length > 0) {
        await client.query(
          `insert into session_invitees (session_id, user_id)
           select $1, unnest($2::uuid[])
           on conflict do nothing`,
          [session.id, inviteeIds],
        );
      }

      await ReminderRules.syncForSession(session, client);
      sessions.push(session);
    }

    return sessions;
  });

  await audit({
    action: 'scheduling.session.created',
    actorId: actor?.userId ?? hostId,
    tenantId,
    targetType: 'scheduled_session',
    targetId: created[0].id,
    metadata: { count: created.length, seriesId: recurrence ? seriesId : null, lessonId, courseId },
  });

  logger.info({ tenantId, hostId, count: created.length, lessonId }, 'scheduling: sessions created');
  return created;
}

/** Move a session (and only that session — a series is edited occurrence by occurrence). */
export async function rescheduleSession(sessionId, { startsAtLocal, durationMinutes, timeZone }, actor) {
  return withTransaction(async (client) => {
    const existing = await loadForUpdate(sessionId, client);
    if (existing.status === 'ended' || existing.status === 'cancelled') {
      throw new ScheduleError('INVALID_STATE', `A ${existing.status} session cannot be rescheduled`);
    }

    const zone = timeZone ? assertTimeZone(timeZone) : existing.time_zone;
    const duration = durationMinutes
      ? Number(durationMinutes)
      : Math.round((new Date(existing.ends_at) - new Date(existing.starts_at)) / 60_000);

    if (!Number.isFinite(duration) || duration < MIN_DURATION_MINUTES || duration > MAX_DURATION_MINUTES) {
      throw new ScheduleError('INVALID_DURATION', `durationMinutes must be ${MIN_DURATION_MINUTES}..${MAX_DURATION_MINUTES}`);
    }

    const startsAt = startsAtLocal
      ? parseLocalDateTime(startsAtLocal, zone).date
      : new Date(existing.starts_at);
    const endsAt = new Date(startsAt.getTime() + duration * 60_000);

    const conflicts = await findHostConflicts(
      {
        tenantId: existing.tenant_id,
        hostId: existing.host_id,
        startsAt,
        endsAt,
        excludeSessionIds: [sessionId],
      },
      client,
    );
    if (conflicts.length > 0) {
      throw new ScheduleError('HOST_CONFLICT', 'The host already has a session in this slot', {
        conflictWith: conflicts.map((c) => ({ id: c.id, title: c.title, startsAt: c.startsAt })),
      });
    }

    const { rows } = await client.query(
      `update scheduled_sessions
          set starts_at = $2, ends_at = $3, time_zone = $4,
              sequence = sequence + 1, updated_at = now()
        where id = $1
        returning ${SESSION_COLUMNS}`,
      [sessionId, startsAt, endsAt, zone],
    );
    const session = mapSession(rows[0]);

    await ReminderRules.syncForSession(session, client);
    await audit({
      action: 'scheduling.session.rescheduled',
      actorId: actor?.userId,
      tenantId: session.tenantId,
      targetType: 'scheduled_session',
      targetId: session.id,
      metadata: { startsAt: session.startsAt, sequence: session.sequence },
    });
    return session;
  });
}

/** Cancel a single session, or every future occurrence of its series. */
export async function cancelSession(sessionId, { reason = null, scope = 'this' } = {}, actor) {
  return withTransaction(async (client) => {
    const existing = await loadForUpdate(sessionId, client);
    if (existing.status === 'cancelled') return mapSession(existing);

    const ids = [sessionId];
    if (scope === 'following' && existing.series_id) {
      const { rows } = await client.query(
        `select id from scheduled_sessions
          where series_id = $1 and starts_at >= $2 and status = 'scheduled'
          for update`,
        [existing.series_id, existing.starts_at],
      );
      for (const row of rows) if (!ids.includes(row.id)) ids.push(row.id);
    }

    const { rows } = await client.query(
      `update scheduled_sessions
          set status = 'cancelled', cancelled_at = now(), cancel_reason = $2,
              sequence = sequence + 1, updated_at = now()
        where id = any($1::uuid[])
        returning ${SESSION_COLUMNS}`,
      [ids, reason],
    );

    for (const row of rows) await ReminderRules.cancelForSession(row.id, client);

    await audit({
      action: 'scheduling.session.cancelled',
      actorId: actor?.userId,
      tenantId: existing.tenant_id,
      targetType: 'scheduled_session',
      targetId: sessionId,
      metadata: { scope, count: rows.length, reason },
    });

    return rows.map(mapSession);
  });
}

/**
 * Bind a session to a live classroom Room (LiveSessionLink calls this when the host opens
 * the room). Idempotent: a second call with the same roomId is a no-op.
 */
export async function startSession(sessionId, roomId, actor) {
  const { rows } = await pool.query(
    `update scheduled_sessions
        set room_id = $2, status = 'live', updated_at = now()
      where id = $1 and status in ('scheduled', 'live')
      returning ${SESSION_COLUMNS}`,
    [sessionId, roomId],
  );
  if (rows.length === 0) throw new ScheduleError('INVALID_STATE', 'Session is not startable');

  await ReminderRules.cancelForSession(sessionId);
  await audit({
    action: 'scheduling.session.started',
    actorId: actor?.userId,
    tenantId: rows[0].tenant_id,
    targetType: 'scheduled_session',
    targetId: sessionId,
    metadata: { roomId },
  });
  return mapSession(rows[0]);
}

/** Called when the room empties / the recorder finishes. Attendance stays in AttendanceService. */
export async function endSession(sessionId) {
  const { rows } = await pool.query(
    `update scheduled_sessions
        set status = 'ended', updated_at = now()
      where id = $1 and status = 'live'
      returning ${SESSION_COLUMNS}`,
    [sessionId],
  );
  return mapSession(rows[0] ?? null);
}

async function loadForUpdate(sessionId, client) {
  const { rows } = await client.query(
    `select ${SESSION_COLUMNS} from scheduled_sessions where id = $1 for update`,
    [sessionId],
  );
  if (rows.length === 0) throw new ScheduleError('SESSION_NOT_FOUND', 'No such session');
  return rows[0];
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

export async function getSession(sessionId) {
  const { rows } = await pool.query(
    `select ${SESSION_COLUMNS} from scheduled_sessions where id = $1`,
    [sessionId],
  );
  return mapSession(rows[0] ?? null);
}

/**
 * Everything a user is expected to attend in a window: hosted, enrolled or invited.
 * Used by the app, by push reminders and by CalendarFeed.
 */
export async function listForUser(userId, {
  tenantId,
  from = new Date(),
  to = new Date(Date.now() + 90 * 86_400_000),
  includeCancelled = false,
  limit = 500,
} = {}) {
  const { rows } = await pool.query(
    `select ${SESSION_COLUMNS}
       from scheduled_sessions s
      where s.tenant_id = $1
        and s.ends_at >= $3
        and s.starts_at < $4
        and ($5 or s.status <> 'cancelled')
        and (
          s.host_id = $2
          or exists (select 1 from session_invitees i where i.session_id = s.id and i.user_id = $2)
          or (s.course_id is not null and exists (
                select 1 from enrollments e
                 where e.course_id = s.course_id and e.user_id = $2 and e.status = 'active'))
        )
      order by s.starts_at asc
      limit $6`,
    [tenantId, userId, from, to, includeCancelled, limit],
  );
  return rows.map(mapSession);
}

export async function listForLesson(lessonId) {
  const { rows } = await pool.query(
    `select ${SESSION_COLUMNS} from scheduled_sessions
      where lesson_id = $1 and status <> 'cancelled'
      order by starts_at asc`,
    [lessonId],
  );
  return rows.map(mapSession);
}

export async function listForCourse(courseId, { from = new Date(), limit = 200 } = {}) {
  const { rows } = await pool.query(
    `select ${SESSION_COLUMNS} from scheduled_sessions
      where course_id = $1 and ends_at >= $2 and status <> 'cancelled'
      order by starts_at asc limit $3`,
    [courseId, from, limit],
  );
  return rows.map(mapSession);
}

/** Audience for reminders and push fan-out. */
export async function listAudience(sessionId) {
  const { rows } = await pool.query(
    `select distinct user_id from (
        select host_id as user_id from scheduled_sessions where id = $1
        union
        select user_id from session_invitees where session_id = $1
        union
        select e.user_id
          from scheduled_sessions s
          join enrollments e on e.course_id = s.course_id and e.status = 'active'
         where s.id = $1 and s.course_id is not null
     ) audience`,
    [sessionId],
  );
  return rows.map((row) => row.user_id);
}

/** Human-readable local start, for notification bodies. */
export function formatLocal(session, locale = 'en-GB') {
  return new Intl.DateTimeFormat(locale, {
    timeZone: session.timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(session.startsAt));
}