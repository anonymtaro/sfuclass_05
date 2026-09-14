// classroom-app/server/src/billing/models/ProcessedEvent.js
/**
 * Webhook idempotency  [UNCHANGED]
 *
 * Reference implementation; keep yours if it differs.
 *
 * Stripe delivers at least once and retries for up to three days on anything
 * that is not a 2xx. Without this table a retried `invoice.paid` extends a
 * subscription twice and a retried `checkout.completed` provisions a plan
 * twice — both of which are money.
 *
 * The claim is an INSERT with ON CONFLICT DO NOTHING rather than a
 * SELECT-then-INSERT: two API tasks receiving the same retry in the same
 * millisecond must not both conclude they are first.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'processed_events';

/**
 * Claims an event id.
 *
 * @returns {Promise<boolean>} true when this caller is the first to see it
 */
export const claim = async ({ eventId, source = 'stripe', type, payload = {} }, client = pool) => {
  const { rows } = await client.query(
    `INSERT INTO processed_events (event_id, source, type, payload)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, source, type, JSON.stringify(payload)],
  );
  return rows.length > 0;
};

/**
 * Marks a claimed event as handled. Separate from the claim so that a crash
 * between the two leaves a row that is claimed but unfinished — visible to the
 * sweep below rather than silently lost.
 */
export const markHandled = async ({ eventId, result = null }, client = pool) => {
  await client.query(
    `UPDATE processed_events SET handled_at = now(), result = $2::jsonb WHERE event_id = $1`,
    [eventId, JSON.stringify(result)],
  );
};

export const markFailed = async ({ eventId, error }, client = pool) => {
  await client.query(
    `UPDATE processed_events SET error = $2, attempts = attempts + 1 WHERE event_id = $1`,
    [eventId, String(error).slice(0, 500)],
  );
};

/**
 * Claimed but never handled. A process that died mid-webhook leaves one of
 * these, and Stripe has already been told 200 — so nobody will retry it but us.
 */
export const findUnhandled = async ({ olderThanMinutes = 15 }, client = pool) => {
  const { rows } = await client.query(
    `SELECT * FROM processed_events
      WHERE handled_at IS NULL
        AND created_at < now() - ($1 || ' minutes')::interval
        AND attempts < 5
      ORDER BY created_at ASC LIMIT 100`,
    [String(olderThanMinutes)],
  );
  return rows.map((row) => ({
    eventId: row.event_id,
    source: row.source,
    type: row.type,
    payload: row.payload,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
  }));
};

/**
 * Pruned, but not soon. Stripe retries for three days, so anything younger than
 * a week must still be recognised as a duplicate.
 */
export const prune = async ({ olderThanDays = 30 }, client = pool) => {
  const { rowCount } = await client.query(
    `DELETE FROM processed_events
      WHERE handled_at IS NOT NULL AND created_at < now() - ($1 || ' days')::interval`,
    [String(olderThanDays)],
  );
  return rowCount;
};

export default { claim, markHandled, markFailed, findUnhandled, prune };