// classroom-app/server/src/billing/models/Subscription.js
/**
 * Subscription row access  [UNCHANGED]
 *
 * Reference implementation; keep yours if it differs. Nothing in version 6
 * changes this file — the storage limit lives on the plan, not here.
 *
 * The table mirrors the provider's lifecycle rather than inventing one.
 * Reconciling two different state machines after a missed webhook is a job
 * nobody wins, so the statuses below are the provider's statuses.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'subscriptions';

export const STATUSES = ['trialing', 'active', 'past_due', 'paused', 'canceled', 'incomplete'];

/**
 * Statuses that still grant access. `past_due` does, deliberately: a card that
 * expired on a Friday should not lock a teacher out of Monday's lesson. The
 * dunning process is what handles non-payment, not an access check.
 */
export const ENTITLED = new Set(['trialing', 'active', 'past_due']);

export const rowToSubscription = (row) => ({
  subscriptionId: row.id,
  ownerId: row.owner_id,
  planId: row.plan_id,
  planCode: row.plan_code,
  status: row.status,
  quantity: row.quantity ?? 1,
  currentPeriodStart: row.current_period_start.toISOString(),
  currentPeriodEnd: row.current_period_end.toISOString(),
  trialEndsAt: row.trial_ends_at?.toISOString() ?? null,
  cancelAt: row.cancel_at?.toISOString() ?? null,
  canceledAt: row.canceled_at?.toISOString() ?? null,
  providerRef: row.provider_ref,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export const findByOwner = async (ownerId, client = pool) => {
  const { rows } = await client.query(
    `SELECT s.*, p.code AS plan_code
       FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.owner_id = $1 AND s.status <> 'canceled'
      ORDER BY s.created_at DESC LIMIT 1`,
    [ownerId],
  );
  return rows[0] ? rowToSubscription(rows[0]) : null;
};

export const findByProviderRef = async (providerRef, client = pool) => {
  const { rows } = await client.query(
    `SELECT s.*, p.code AS plan_code
       FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.provider_ref = $1`,
    [providerRef],
  );
  return rows[0] ? rowToSubscription(rows[0]) : null;
};

/**
 * Upsert from the provider, keyed on `provider_ref`.
 *
 * That key rather than the owner, because an owner accumulates subscriptions
 * over time — cancelled, resumed, upgraded — and matching on owner alone would
 * overwrite the history the finance team needs.
 */
export const upsertFromProvider = async (input, client = pool) => {
  const { rows } = await client.query(
    `INSERT INTO subscriptions
       (owner_id, plan_id, status, quantity, current_period_start, current_period_end,
        trial_ends_at, cancel_at, canceled_at, provider_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (provider_ref) DO UPDATE
       SET plan_id = EXCLUDED.plan_id,
           status = EXCLUDED.status,
           quantity = EXCLUDED.quantity,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end = EXCLUDED.current_period_end,
           trial_ends_at = EXCLUDED.trial_ends_at,
           cancel_at = EXCLUDED.cancel_at,
           canceled_at = EXCLUDED.canceled_at,
           updated_at = now()
     RETURNING id`,
    [
      input.ownerId, input.planId, input.status, input.quantity ?? 1,
      input.currentPeriodStart, input.currentPeriodEnd, input.trialEndsAt ?? null,
      input.cancelAt ?? null, input.canceledAt ?? null, input.providerRef,
    ],
  );

  const { rows: fresh } = await client.query(
    `SELECT s.*, p.code AS plan_code FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id WHERE s.id = $1`,
    [rows[0].id],
  );
  return rowToSubscription(fresh[0]);
};

export const setStatus = async ({ providerRef, status, canceledAt = null }, client = pool) => {
  const { rowCount } = await client.query(
    `UPDATE subscriptions SET status = $2, canceled_at = $3, updated_at = now()
      WHERE provider_ref = $1`,
    [providerRef, status, canceledAt],
  );
  return rowCount > 0;
};

/**
 * Subscriptions whose period ended and were never renewed. Three days of grace
 * before they are swept, because a webhook that arrives late is far more common
 * than a subscription that genuinely lapsed.
 */
export const findExpired = async (client = pool) => {
  const { rows } = await client.query(
    `SELECT s.*, p.code AS plan_code
       FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('active','trialing','past_due')
        AND s.current_period_end < now() - interval '3 days'`,
  );
  return rows.map(rowToSubscription);
};

export const isEntitled = (subscription) => Boolean(subscription) && ENTITLED.has(subscription.status);

export default { findByOwner, findByProviderRef, upsertFromProvider, setStatus, findExpired, isEntitled, ENTITLED };