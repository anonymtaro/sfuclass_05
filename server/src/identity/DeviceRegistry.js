// classroom-app/server/src/identity/DeviceRegistry.js
/**
 * Devices and push tokens  (F5)  [NEW]
 *
 * One row per device per user, holding the push token and the SNS endpoint that
 * was created for it.
 *
 * Push tokens rot constantly and in several different ways, which is most of
 * what this file deals with:
 *
 *   reinstall     a new token for the same device; the old one still exists and
 *                 still "works", so a notification goes to nobody
 *   handover      the same token turns up for a different user when a device is
 *                 passed on or an account is switched
 *   revocation    APNs or FCM reports the token as invalid, usually long after
 *                 the app was uninstalled
 *
 * The first two are handled by keying on the token as well as the device, so a
 * token can only ever belong to one user. The third is handled by counting
 * failures and pruning — a token that fails three deliveries in a row is dead,
 * and continuing to publish to it costs money and hides real failures in the
 * metrics.
 */

import { pool } from '../db/pool.js';
import { platformApplications, snsClientOptions, limits } from '../config/push.config.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'devices' });

let sns = null;

const getSns = async () => {
  if (sns) return sns;
  const { SNSClient } = await import('@aws-sdk/client-sns');
  sns = new SNSClient(snsClientOptions);
  return sns;
};

const rowToDevice = (row) => ({
  deviceId: row.id,
  userId: row.user_id,
  platform: row.platform,
  name: row.name,
  appVersion: row.app_version,
  pushEnabled: row.push_enabled && Boolean(row.endpoint_arn),
  lastSeenAt: row.last_seen_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers or updates a device. Called on every app start, not only the first
 * — a token can change without the user doing anything.
 *
 * @param {{ userId, platform, pushToken, name, appVersion, deviceId }} input
 */
export const register = async ({ userId, platform, pushToken = null, name = null, appVersion = null, deviceId = null }) => {
  if (!['ios', 'android', 'web'].includes(platform)) {
    throw Object.assign(new Error('unknown platform'), { code: 'validation_failed' });
  }

  /**
   * A token that already belongs to somebody else means the device changed
   * hands. The old association is removed rather than left: sending a new
   * owner's messages to a previous owner's device is the worst failure this
   * file can produce.
   */
  if (pushToken) {
    const { rows: stolen } = await pool.query(
      `DELETE FROM devices WHERE push_token = $1 AND user_id <> $2 RETURNING user_id, endpoint_arn`,
      [pushToken, userId],
    );

    for (const previous of stolen) {
      log.warn({ from: previous.user_id, to: userId }, 'push token moved to another account');
      await deleteEndpoint(previous.endpoint_arn).catch(() => undefined);
    }
  }

  const endpointArn = pushToken ? await ensureEndpoint({ platform, pushToken, userId }) : null;

  const { rows } = await pool.query(
    `INSERT INTO devices (id, user_id, platform, push_token, endpoint_arn, name, app_version,
                          push_enabled, failures, last_seen_at)
     VALUES (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $4 IS NOT NULL, 0, now())
     ON CONFLICT (user_id, platform, push_token) DO UPDATE
       SET endpoint_arn = EXCLUDED.endpoint_arn,
           name = coalesce(EXCLUDED.name, devices.name),
           app_version = EXCLUDED.app_version,
           push_enabled = EXCLUDED.push_enabled,
           -- A device that has just checked in is alive again, whatever it
           -- did before.
           failures = 0,
           last_seen_at = now()
     RETURNING *`,
    [deviceId, userId, platform, pushToken, endpointArn, name, appVersion],
  );

  log.info({ userId, platform, deviceId: rows[0].id, push: Boolean(endpointArn) }, 'device registered');
  return rowToDevice(rows[0]);
};

/**
 * Creates or repairs the SNS platform endpoint for a token.
 *
 * The repair path matters: SNS keeps a disabled endpoint when a token is
 * re-registered after a failure, and publishing to it silently does nothing
 * until its attributes are reset.
 */
const ensureEndpoint = async ({ platform, pushToken, userId }) => {
  const applicationArn = platformApplications[platform];
  if (!applicationArn) return null; // push not configured, or web

  try {
    const { CreatePlatformEndpointCommand, SetEndpointAttributesCommand } = await import('@aws-sdk/client-sns');
    const client = await getSns();

    const created = await client.send(
      new CreatePlatformEndpointCommand({
        PlatformApplicationArn: applicationArn,
        Token: pushToken,
        CustomUserData: userId,
      }),
    );

    // Re-enable, in case this endpoint was disabled by a previous failure.
    await client.send(
      new SetEndpointAttributesCommand({
        EndpointArn: created.EndpointArn,
        Attributes: { Enabled: 'true', Token: pushToken, CustomUserData: userId },
      }),
    ).catch(() => undefined);

    return created.EndpointArn;
  } catch (cause) {
    // A device that cannot receive push is still a device. Registration
    // succeeds without it.
    log.error({ err: cause, platform, userId }, 'could not create a push endpoint');
    return null;
  }
};

const deleteEndpoint = async (endpointArn) => {
  if (!endpointArn) return;
  const { DeleteEndpointCommand } = await import('@aws-sdk/client-sns');
  const client = await getSns();
  await client.send(new DeleteEndpointCommand({ EndpointArn: endpointArn }));
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const listForUser = async (userId) => {
  const { rows } = await pool.query(
    `SELECT * FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC NULLS LAST`,
    [userId],
  );
  return rows.map(rowToDevice);
};

/** The endpoints a notification should be published to. */
export const pushTargets = async (userId) => {
  const { rows } = await pool.query(
    `SELECT id, platform, endpoint_arn FROM devices
      WHERE user_id = $1 AND push_enabled = true AND endpoint_arn IS NOT NULL
        AND failures < $2
        -- A device that has not opened the app in three months is almost
        -- certainly gone; publishing to it is spend with no delivery.
        AND last_seen_at > now() - interval '90 days'`,
    [userId, limits.failuresBeforeTokenRemoval],
  );

  return rows.map((row) => ({
    deviceId: row.id,
    platform: row.platform,
    endpointArn: row.endpoint_arn,
  }));
};

export const pushTargetsForMany = async (userIds) => {
  if (userIds.length === 0) return new Map();

  const { rows } = await pool.query(
    `SELECT user_id, id, platform, endpoint_arn FROM devices
      WHERE user_id = ANY($1::uuid[]) AND push_enabled = true AND endpoint_arn IS NOT NULL
        AND failures < $2 AND last_seen_at > now() - interval '90 days'`,
    [userIds, limits.failuresBeforeTokenRemoval],
  );

  const byUser = new Map();
  for (const row of rows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push({
      deviceId: row.id,
      platform: row.platform,
      endpointArn: row.endpoint_arn,
    });
  }
  return byUser;
};

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * A delivery failed. Counted rather than acted on immediately: a single
 * failure is often a transient SNS error, and disabling a device on one of
 * those means a user stops receiving notifications for no reason.
 */
export const recordFailure = async ({ deviceId, endpointArn, permanent = false }) => {
  if (permanent) {
    // EndpointDisabled or InvalidParameter: the token is genuinely dead.
    await pool.query(`UPDATE devices SET push_enabled = false, failures = 99 WHERE id = $1`, [deviceId]);
    await deleteEndpoint(endpointArn).catch(() => undefined);
    log.info({ deviceId }, 'push endpoint removed');
    return { removed: true };
  }

  const { rows } = await pool.query(
    `UPDATE devices SET failures = failures + 1 WHERE id = $1 RETURNING failures`,
    [deviceId],
  );

  const failures = rows[0]?.failures ?? 0;

  if (failures >= limits.failuresBeforeTokenRemoval) {
    await pool.query(`UPDATE devices SET push_enabled = false WHERE id = $1`, [deviceId]);
    await deleteEndpoint(endpointArn).catch(() => undefined);
    log.info({ deviceId, failures }, 'push disabled after repeated failures');
    return { removed: true, failures };
  }

  return { removed: false, failures };
};

export const recordSuccess = async (deviceId) => {
  await pool.query(
    `UPDATE devices SET failures = 0, last_push_at = now() WHERE id = $1 AND failures > 0`,
    [deviceId],
  );
};

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

export const unregister = async ({ userId, deviceId }) => {
  const { rows } = await pool.query(
    `DELETE FROM devices WHERE id = $1 AND user_id = $2 RETURNING endpoint_arn`,
    [deviceId, userId],
  );
  if (rows[0]) await deleteEndpoint(rows[0].endpoint_arn).catch(() => undefined);
  return rows.length > 0;
};

/**
 * Signing out removes the push registration for that device only. Leaving it
 * would send the next person's notifications to a device they have signed out
 * of, which people notice.
 */
export const unregisterBySession = async ({ userId, sessionId }) => {
  const { rows } = await pool.query(
    `DELETE FROM devices WHERE user_id = $1 AND session_id = $2 RETURNING endpoint_arn`,
    [userId, sessionId],
  );
  for (const row of rows) await deleteEndpoint(row.endpoint_arn).catch(() => undefined);
  return rows.length;
};

export const unregisterAll = async (userId) => {
  const { rows } = await pool.query(
    `DELETE FROM devices WHERE user_id = $1 RETURNING endpoint_arn`,
    [userId],
  );
  for (const row of rows) await deleteEndpoint(row.endpoint_arn).catch(() => undefined);
  return rows.length;
};

/** Nightly sweep. Endpoints cost nothing individually and something in bulk. */
export const pruneStale = async ({ inactiveDays = 180 } = {}) => {
  const { rows } = await pool.query(
    `DELETE FROM devices
      WHERE last_seen_at < now() - ($1 || ' days')::interval
      RETURNING id, endpoint_arn`,
    [String(inactiveDays)],
  );

  for (const row of rows) await deleteEndpoint(row.endpoint_arn).catch(() => undefined);
  if (rows.length > 0) log.info({ pruned: rows.length }, 'stale devices pruned');

  return rows.length;
};

export default {
  register, unregister, unregisterAll, unregisterBySession, listForUser,
  pushTargets, pushTargetsForMany, recordFailure, recordSuccess, pruneStale,
};