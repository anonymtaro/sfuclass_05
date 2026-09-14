/**
 * CalendarFeed — a signed .ics feed per learner. (F1, F3)
 *
 * Calendar clients (Google, Apple, Outlook) poll a URL anonymously: they will not carry a
 * bearer token and they will not follow an auth redirect. So the URL itself is the
 * credential.
 *
 *   https://api.<domain>/calendar/<token>.ics
 *   token = base64url(userId.tokenId) + "." + base64url(HMAC-SHA256(payload, secret))
 *
 * Properties that make this safe enough for a read-only feed:
 *  - The token carries a per-user `token_id`. Rotating it (PrivacySettings → "reset
 *    calendar link") invalidates every subscribed client at once.
 *  - Revocation is checked in Postgres on every request, so a leaked URL is one row
 *    update away from dead.
 *  - The feed is read-only and contains only sessions the user is already entitled to see.
 *  - The route must be unauthenticated, rate-limited per token, and must not set cookies.
 *
 * The feed is RFC 5545. All DTSTART/DTEND values are UTC (`...Z`), which avoids shipping a
 * VTIMEZONE block and, more importantly, avoids being wrong about a DST rule. The local
 * zone still travels in X-WR-TIMEZONE so clients display something sensible.
 */

import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';
import * as ScheduleService from './ScheduleService.js';

const PRODID = '-//Classroom Platform//Schedule//EN';
const DEFAULT_WINDOW_PAST_MS = 30 * 86_400_000;
const DEFAULT_WINDOW_FUTURE_MS = 180 * 86_400_000;

/** Dedicated secret; falls back to the cookie secret so a missing var is not a boot failure. */
function feedSecret() {
  const secret = env.CALENDAR_FEED_SECRET ?? env.COOKIE_SECRET;
  if (!secret) throw new Error('CALENDAR_FEED_SECRET (or COOKIE_SECRET) must be configured');
  return secret;
}

export class CalendarFeedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CalendarFeedError';
    this.code = code;
    this.status = code === 'INVALID_TOKEN' || code === 'REVOKED' ? 404 : 400;
  }
}

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

const b64url = (input) => Buffer.from(input).toString('base64url');

function sign(payload) {
  return crypto.createHmac('sha256', feedSecret()).update(payload).digest('base64url');
}

function buildToken(userId, tokenId) {
  const payload = b64url(`${userId}.${tokenId}`);
  return `${payload}.${sign(payload)}`;
}

/** Create the feed token for a user, or return the existing one. */
export async function getOrCreateFeedToken(userId) {
  const { rows } = await pool.query(
    `insert into calendar_feed_tokens (user_id, token_id)
     values ($1, gen_random_uuid())
     on conflict (user_id) do update
        set revoked_at = null
     returning user_id, token_id`,
    [userId],
  );
  return buildToken(rows[0].user_id, rows[0].token_id);
}

/** Rotate: every currently subscribed client stops receiving updates. */
export async function rotateFeedToken(userId) {
  const { rows } = await pool.query(
    `update calendar_feed_tokens
        set token_id = gen_random_uuid(), revoked_at = null, rotated_at = now()
      where user_id = $1
      returning user_id, token_id`,
    [userId],
  );
  if (rows.length === 0) return getOrCreateFeedToken(userId);
  logger.info({ userId }, 'scheduling: calendar feed token rotated');
  return buildToken(rows[0].user_id, rows[0].token_id);
}

export async function revokeFeedToken(userId) {
  await pool.query(
    `update calendar_feed_tokens set revoked_at = now() where user_id = $1`,
    [userId],
  );
}

export function feedUrl(token) {
  const base = env.API_URL?.replace(/\/$/, '') ?? '';
  return `${base}/calendar/${token}.ics`;
}

/** webcal:// makes desktop clients subscribe instead of downloading a snapshot. */
export function webcalUrl(token) {
  return feedUrl(token).replace(/^https?:\/\//, 'webcal://');
}

/**
 * Verify a token from the URL. Constant-time signature check, then a revocation lookup.
 * @returns {Promise<{ userId:string, tenantId:string }>}
 */
export async function verifyFeedToken(token) {
  const [payload, signature] = String(token ?? '').split('.');
  if (!payload || !signature) throw new CalendarFeedError('INVALID_TOKEN', 'Malformed feed token');

  const expected = Buffer.from(sign(payload));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    throw new CalendarFeedError('INVALID_TOKEN', 'Bad feed signature');
  }

  const [userId, tokenId] = Buffer.from(payload, 'base64url').toString('utf8').split('.');
  const { rows } = await pool.query(
    `select t.user_id, t.token_id, t.revoked_at, u.tenant_id
       from calendar_feed_tokens t
       join users u on u.id = t.user_id
      where t.user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row || row.revoked_at || row.token_id !== tokenId) {
    throw new CalendarFeedError('REVOKED', 'Feed token is no longer valid');
  }

  await pool.query(
    `update calendar_feed_tokens set last_accessed_at = now() where user_id = $1`,
    [userId],
  ).catch(() => {});

  return { userId: row.user_id, tenantId: row.tenant_id };
}

/* ------------------------------------------------------------------ *
 * ICS serialisation
 * ------------------------------------------------------------------ */

function icsEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 line folding: 75 octets, continuation lines start with a single space. */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const chunks = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // never split a multi-byte character
    while (end > start && end < bytes.length && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // one octet is spent on the leading space
  }
  return chunks.join('\r\n ');
}

function icsDate(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const STATUS_MAP = {
  scheduled: 'CONFIRMED',
  live: 'CONFIRMED',
  ended: 'CONFIRMED',
  cancelled: 'CANCELLED',
};

/**
 * One VEVENT per session. UID is stable across updates so a reschedule edits the existing
 * entry in the client instead of creating a second one; SEQUENCE tells the client which
 * version wins.
 */
function renderEvent(session, { joinUrl }) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${session.id}@classroom`,
    `DTSTAMP:${icsDate(session.updatedAt ?? session.createdAt ?? new Date())}`,
    `DTSTART:${icsDate(session.startsAt)}`,
    `DTEND:${icsDate(session.endsAt)}`,
    `SEQUENCE:${session.sequence ?? 0}`,
    `STATUS:${STATUS_MAP[session.status] ?? 'TENTATIVE'}`,
    `SUMMARY:${icsEscape(session.title)}`,
    'TRANSP:OPAQUE',
    `X-CLASSROOM-SESSION-ID:${session.id}`,
  ];

  if (session.description) lines.push(`DESCRIPTION:${icsEscape(session.description)}`);
  if (joinUrl) {
    lines.push(`URL;VALUE=URI:${icsEscape(joinUrl)}`);
    lines.push(`LOCATION:${icsEscape(joinUrl)}`);
  }

  if (session.status === 'scheduled') {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT10M',
      `DESCRIPTION:${icsEscape(session.title)}`,
      'END:VALARM',
    );
  }

  lines.push('END:VEVENT');
  return lines;
}

/**
 * Build the calendar document.
 * Cancelled sessions stay in the feed for a while on purpose: a client only removes an
 * entry when it sees STATUS:CANCELLED, never when the entry silently disappears.
 */
export function renderCalendar(sessions, { name = 'Classroom', timeZone = 'UTC', joinUrlFor } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    `PRODID:${PRODID}`,
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)}`,
    `X-WR-TIMEZONE:${icsEscape(timeZone)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
  ];

  for (const session of sessions) {
    lines.push(...renderEvent(session, { joinUrl: joinUrlFor?.(session) }));
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------ *
 * Route-facing entrypoint
 * ------------------------------------------------------------------ */

function defaultJoinUrl(session) {
  const base = env.APP_URL?.replace(/\/$/, '') ?? '';
  return session.lessonId
    ? `${base}/lessons/${session.lessonId}/live`
    : `${base}/sessions/${session.id}`;
}

/**
 * Everything the .ics route needs: body, ETag and Last-Modified.
 *
 * The route should answer 304 when If-None-Match matches — calendar clients poll every
 * few minutes per subscriber, and a 304 is the difference between a cheap feed and a
 * self-inflicted load test.
 */
export async function buildFeedForToken(token, { now = new Date() } = {}) {
  const { userId, tenantId } = await verifyFeedToken(token);

  const sessions = await ScheduleService.listForUser(userId, {
    tenantId,
    from: new Date(now.getTime() - DEFAULT_WINDOW_PAST_MS),
    to: new Date(now.getTime() + DEFAULT_WINDOW_FUTURE_MS),
    includeCancelled: true,
    limit: 1000,
  });

  const timeZone = sessions[0]?.timeZone ?? 'UTC';
  const body = renderCalendar(sessions, {
    name: 'Classroom — my sessions',
    timeZone,
    joinUrlFor: defaultJoinUrl,
  });

  const lastModified = sessions.reduce(
    (latest, session) => {
      const updated = new Date(session.updatedAt ?? session.createdAt ?? 0);
      return updated > latest ? updated : latest;
    },
    new Date(0),
  );

  return {
    body,
    contentType: 'text/calendar; charset=utf-8',
    filename: 'classroom.ics',
    etag: `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
    lastModified: lastModified.getTime() > 0 ? lastModified : now,
    count: sessions.length,
  };
}