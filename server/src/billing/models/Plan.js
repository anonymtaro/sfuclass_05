// classroom-app/server/src/billing/models/Plan.js
/**
 * Plan row access  (F4)  [EXT]
 *
 * Extended in version 6 with `storageQuotaGb` and the feature switches inside
 * `limits`.
 *
 * Storage is the new dimension and the one that changes how plans behave. Seats
 * are a rate — they free up when a lesson ends — but storage only ever grows,
 * so a tenant that fills its quota stays full until somebody deletes something.
 * A plan with generous seats and a small quota produces support tickets in
 * month three, which is exactly when nobody remembers choosing it.
 *
 * Limits live in one JSONB column rather than fifteen columns. They are always
 * read together, they change shape as features are added, and a migration per
 * new limit is a migration nobody needs.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'plans';

const GB = 1024 * 1024 * 1024;

/**
 * The floor. Applied when a tenant has no subscription at all — a lapsed trial,
 * a self-hosted install, a row that went missing. Never zero, because a tenant
 * that cannot open a single room cannot tell a billing problem from an outage.
 */
export const FREE_LIMITS = Object.freeze({
  seatsPerRoom: 8,
  concurrentRooms: 1,
  storageQuotaGb: 2,
  maxCourses: 1,
  maxSpaces: 1,
  maxTeachers: 1,
  recordingHoursPerMonth: 0,
  recordingRetentionDays: 7,
  features: {
    screenShare: true,
    breakoutRooms: false,
    recording: false,
    transcription: false,
    publicChat: true,
    directMessages: true,
    certificates: false,
    customDomain: false,
    sso: false,
  },
});

/** Fills in anything a stored plan omits, so a newly added switch defaults off. */
export const withDefaults = (limits = {}) => ({
  ...FREE_LIMITS,
  ...limits,
  features: { ...FREE_LIMITS.features, ...(limits.features ?? {}) },
});

export const rowToPlan = (row) => ({
  planId: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  price: { amountMinor: Number(row.price_amount_minor ?? 0), currency: row.price_currency },
  interval: row.interval,
  limits: withDefaults(row.limits),
  visible: row.visible,
  trialDays: row.trial_days ?? 0,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const findByCode = async (code, client = pool) => {
  const { rows } = await client.query(`SELECT * FROM plans WHERE code = $1`, [code]);
  return rows[0] ? rowToPlan(rows[0]) : null;
};

export const findById = async (planId, client = pool) => {
  const { rows } = await client.query(`SELECT * FROM plans WHERE id = $1`, [planId]);
  return rows[0] ? rowToPlan(rows[0]) : null;
};

/**
 * Only visible plans are listed. A hidden plan is grandfathered — still billed,
 * no longer sold — and putting it on a pricing page would let anybody sign up
 * for terms that were withdrawn.
 */
export const listVisible = async (client = pool) => {
  const { rows } = await client.query(
    `SELECT * FROM plans WHERE visible = true ORDER BY price_amount_minor ASC`,
  );
  return rows.map(rowToPlan);
};

export const listAll = async (client = pool) => {
  const { rows } = await client.query(`SELECT * FROM plans ORDER BY price_amount_minor ASC`);
  return rows.map(rowToPlan);
};

/** The synthetic plan used when there is no subscription to read. */
export const freePlan = () => ({
  planId: null,
  code: 'free',
  name: 'Free',
  description: null,
  price: { amountMinor: 0, currency: 'EUR' },
  interval: 'month',
  limits: withDefaults(),
  visible: true,
  trialDays: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const quotaBytes = (plan) => (plan?.limits?.storageQuotaGb ?? FREE_LIMITS.storageQuotaGb) * GB;

/**
 * What a plan change would cost the tenant. Used to warn *before* a downgrade
 * rather than after: the failure mode of discovering it afterwards is a tenant
 * over quota, unable to upload, with no explanation.
 */
export const compareLimits = (from, to) => {
  const losses = [];

  const numeric = [
    ['seatsPerRoom', 'seats per room'],
    ['concurrentRooms', 'concurrent rooms'],
    ['storageQuotaGb', 'storage'],
    ['recordingHoursPerMonth', 'recording hours'],
    ['recordingRetentionDays', 'recording retention'],
  ];

  for (const [key, label] of numeric) {
    const before = from.limits[key] ?? 0;
    const after = to.limits[key] ?? 0;
    if (after < before) losses.push({ key, label, from: before, to: after });
  }

  // null means unlimited, so null → a number is a loss even though a numeric
  // comparison would say otherwise.
  for (const [key, label] of [
    ['maxCourses', 'courses'],
    ['maxSpaces', 'spaces'],
    ['maxTeachers', 'teachers'],
  ]) {
    const before = from.limits[key];
    const after = to.limits[key];
    if (before === null && after !== null) losses.push({ key, label, from: 'unlimited', to: after });
    else if (before !== null && after !== null && after < before) {
      losses.push({ key, label, from: before, to: after });
    }
  }

  for (const [feature, enabled] of Object.entries(from.limits.features)) {
    if (enabled && !to.limits.features[feature]) {
      losses.push({ key: `features.${feature}`, label: feature, from: true, to: false });
    }
  }

  return losses;
};

export default { findByCode, findById, listVisible, listAll, freePlan, quotaBytes, withDefaults, compareLimits, FREE_LIMITS };