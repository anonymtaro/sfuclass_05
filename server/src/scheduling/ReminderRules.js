/**
 * ReminderRules — T-24h and T-10m reminders. (F2, F5)
 *
 * Two moving parts, deliberately separated:
 *
 *   1. Planning.  For a session, the rules below say *when* a nudge is due. Plans are
 *      persisted in `session_reminders`, one row per (session, rule). Postgres is the
 *      source of truth, not the queue — a flushed Redis must not lose a reminder.
 *
 *   2. Dispatch.  A sweeper (jobs/ via EventBridge, once a minute) hands rows whose
 *      fire time falls inside the horizon to the notify queue, where the existing
 *      notificationWorker fans them out to push / email / in-app.
 *
 * Idempotency: the BullMQ jobId is deterministic — `reminder:<sessionId>:<rule>:<sequence>`.
 * Two sweepers racing produce one job. A reschedule bumps `sequence`, so the stale job
 * for the old time can never be confused with the new one.
 */

import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';

/** Queue jobs are enqueued lazily so this module stays importable in tests without Redis. */
async function notifyQueue() {
  const module = await import('../queues/queues.js');
  return module.queues?.notify ?? module.notifyQueue;
}

/**
 * The rules. Adding one is a migration-free change: new rows appear on the next sync.
 *
 * leadMs        how far before the start the reminder fires
 * minNoticeMs   if a session is created inside this window, the rule is skipped rather
 *               than fired late — nobody wants a "starts in 24 hours" push at T-3h
 * channels      hints for the notification worker; per-user preferences still win
 */
export const RULES = Object.freeze([
  Object.freeze({
    key: 'T-24h',
    leadMs: 24 * 60 * 60 * 1000,
    minNoticeMs: 30 * 60 * 1000,
    template: 'session.reminder.day_before',
    channels: ['email', 'push', 'in-app'],
    priority: 'normal',
  }),
  Object.freeze({
    key: 'T-10m',
    leadMs: 10 * 60 * 1000,
    minNoticeMs: 2 * 60 * 1000,
    template: 'session.reminder.starting_soon',
    channels: ['push', 'in-app'],
    priority: 'high',
  }),
]);

/** Rows older than this at dispatch time are dropped, not fired late. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/** How far ahead the sweeper hands work to the queue. */
export const DEFAULT_HORIZON_MS = 5 * 60 * 1000;

export function describeRules() {
  return RULES.map((rule) => ({ key: rule.key, leadMinutes: rule.leadMs / 60_000, channels: rule.channels }));
}

/**
 * Fire times for a session, skipping rules that are already past or inside their
 * minimum-notice window. Pure — no I/O, so it is the thing to unit-test.
 *
 * @param {{ id:string, startsAt:Date|string, status:string, sequence:number }} session
 * @param {Date} [now]
 * @returns {Array<{ ruleKey:string, fireAt:Date, template:string, channels:string[] }>}
 */
export function planForSession(session, now = new Date()) {
  if (!session || session.status === 'cancelled' || session.status === 'ended') return [];

  const startsAt = new Date(session.startsAt).getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(startsAt) || startsAt <= nowMs) return [];

  const plans = [];
  for (const rule of RULES) {
    const fireAtMs = startsAt - rule.leadMs;
    if (fireAtMs <= nowMs) continue;                       // already past
    if (startsAt - nowMs < rule.minNoticeMs) continue;     // booked too late for this rule
    plans.push({
      ruleKey: rule.key,
      fireAt: new Date(fireAtMs),
      template: rule.template,
      channels: [...rule.channels],
      priority: rule.priority,
    });
  }
  return plans;
}

/**
 * Make the stored plan match the session as it is now. Call inside the same transaction
 * as the session write — a committed session with no reminders is a silent bug.
 */
export async function syncForSession(session, client = pool) {
  const plans = planForSession(session);
  const keep = plans.map((plan) => plan.ruleKey);

  await client.query(
    `update session_reminders
        set status = 'cancelled', updated_at = now()
      where session_id = $1
        and status = 'pending'
        and not (rule_key = any($2::text[]))`,
    [session.id, keep],
  );

  for (const plan of plans) {
    await client.query(
      `insert into session_reminders
         (session_id, rule_key, fire_at, sequence, template, channels, status)
       values ($1, $2, $3, $4, $5, $6, 'pending')
       on conflict (session_id, rule_key) do update
          set fire_at   = excluded.fire_at,
              sequence  = excluded.sequence,
              template  = excluded.template,
              channels  = excluded.channels,
              status    = 'pending',
              sent_at   = null,
              attempts  = 0,
              last_error = null,
              updated_at = now()`,
      [session.id, plan.ruleKey, plan.fireAt, session.sequence ?? 0, plan.template, plan.channels],
    );
  }

  logger.debug({ sessionId: session.id, rules: keep }, 'scheduling: reminders synced');
  return plans;
}

/** Cancellation, start, and deletion all land here. */
export async function cancelForSession(sessionId, client = pool) {
  const { rowCount } = await client.query(
    `update session_reminders
        set status = 'cancelled', updated_at = now()
      where session_id = $1 and status = 'pending'`,
    [sessionId],
  );
  return rowCount;
}

/**
 * Sweeper entrypoint (jobs/, EventBridge, ~every minute).
 *
 * Claims due rows with SKIP LOCKED so two concurrent tasks never claim the same row,
 * then enqueues one notify job per row. The job payload carries the session and the
 * audience resolution is left to the worker, which already knows about device tokens,
 * quiet hours and per-user notification settings.
 */
export async function enqueueDue({ horizonMs = DEFAULT_HORIZON_MS, limit = 500, now = new Date() } = {}) {
  const queue = await notifyQueue();
  const until = new Date(now.getTime() + horizonMs);
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);

  const { rows } = await pool.query(
    `with due as (
        select r.id
          from session_reminders r
          join scheduled_sessions s on s.id = r.session_id
         where r.status = 'pending'
           and r.fire_at <= $1
           and s.status = 'scheduled'
         order by r.fire_at asc
         limit $2
         for update of r skip locked
     )
     update session_reminders r
        set status = 'queued', attempts = r.attempts + 1, updated_at = now()
       from due
      where r.id = due.id
      returning r.id, r.session_id, r.rule_key, r.fire_at, r.sequence, r.template, r.channels`,
    [until, limit],
  );

  let enqueued = 0;
  let dropped = 0;

  for (const row of rows) {
    if (new Date(row.fire_at) < staleBefore) {
      await markSkipped(row.id, 'stale');
      dropped += 1;
      continue;
    }

    const delay = Math.max(0, new Date(row.fire_at).getTime() - Date.now());
    try {
      await queue.add(
        'session.reminder',
        {
          reminderId: row.id,
          sessionId: row.session_id,
          ruleKey: row.rule_key,
          template: row.template,
          channels: row.channels,
          fireAt: row.fire_at,
        },
        {
          jobId: `reminder:${row.session_id}:${row.rule_key}:${row.sequence}`,
          delay,
          removeOnComplete: 1000,
          removeOnFail: 5000,
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
        },
      );
      enqueued += 1;
    } catch (error) {
      await markFailed(row.id, error);
      logger.error({ err: error, reminderId: row.id }, 'scheduling: reminder enqueue failed');
    }
  }

  if (rows.length > 0) {
    logger.info({ claimed: rows.length, enqueued, dropped }, 'scheduling: reminder sweep');
  }
  return { claimed: rows.length, enqueued, dropped };
}

/** Called by notificationWorker once the fan-out succeeded. */
export async function markSent(reminderId, { recipients = null } = {}) {
  await pool.query(
    `update session_reminders
        set status = 'sent', sent_at = now(), recipients = $2, updated_at = now()
      where id = $1 and status <> 'cancelled'`,
    [reminderId, recipients],
  );
}

/** Put a row back in play so the next sweep retries it; the queue retries first. */
export async function markFailed(reminderId, error) {
  await pool.query(
    `update session_reminders
        set status = case when attempts >= 5 then 'failed' else 'pending' end,
            last_error = $2,
            updated_at = now()
      where id = $1 and status <> 'cancelled'`,
    [reminderId, String(error?.message ?? error).slice(0, 500)],
  );
}

async function markSkipped(reminderId, reason) {
  await pool.query(
    `update session_reminders
        set status = 'skipped', last_error = $2, updated_at = now()
      where id = $1`,
    [reminderId, reason],
  );
}

/**
 * Backfill after an outage or after a rule is added: re-plan every future session whose
 * reminder rows are missing. Safe to run repeatedly.
 */
export async function resyncUpcoming({ withinMs = 7 * 86_400_000, limit = 2000 } = {}) {
  const { rows } = await pool.query(
    `select id, starts_at as "startsAt", status, sequence
       from scheduled_sessions
      where status = 'scheduled'
        and starts_at between now() and now() + ($1::bigint || ' milliseconds')::interval
      order by starts_at asc
      limit $2`,
    [withinMs, limit],
  );

  let synced = 0;
  for (const session of rows) {
    await syncForSession(session);
    synced += 1;
  }
  logger.info({ synced }, 'scheduling: reminders resynced');
  return synced;
}