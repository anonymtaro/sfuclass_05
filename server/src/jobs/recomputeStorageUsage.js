/**
 * recomputeStorageUsage — quota drift repair (F4)
 *
 * The recorded usage counter is incremented on upload and decremented on delete, which
 * means it is wrong eventually. An aborted multipart that was never swept, a delete that
 * failed after the row went but before the object did, a reservation that leaked when a
 * task was killed mid-presign — each one is small, and they only ever accumulate in one
 * direction: the tenant appears to be using more than they are, and eventually a legitimate
 * upload is refused with a quota error nobody can explain.
 *
 * The repair is a recount from the assets table (authoritative for what the tenant owns)
 * reconciled against S3 inventory (authoritative for what exists). Both are needed: the
 * table alone cannot see an orphaned object, and S3 alone cannot see which tenant it is.
 *
 * Drift is reported before it is repaired. A tenant whose counter moves by gigabytes every
 * day has a leak, and silently correcting it every night hides that.
 *
 * Schedule: daily, off-peak.
 */

import { runJob, isMain } from './_runJob.js';
import * as StorageGuard from '../capacity/StorageGuard.js';
import { metrics } from '../observability/metrics.js';

const TENANT_BATCH = 25;
const SIGNIFICANT_DRIFT_BYTES = 10 * 1024 * 1024; // below this, it is rounding and churn

export async function recomputeStorageUsage({ log, clock, argv = {} } = {}) {
  const dryRun = Boolean(argv.dryRun);
  const summary = {
    audited: 0,
    repaired: 0,
    unchanged: 0,
    largestDriftBytes: 0,
    largestDriftTenantId: null,
    reservationsReleased: 0,
    dryRun,
  };

  // Leaked reservations first: they inflate the recount if they are still held.
  summary.reservationsReleased = await StorageGuard.expireStaleReservations({ olderThanMinutes: 60 * 24 });

  let cursor = argv.tenantId ? null : undefined;
  const singleTenant = argv.tenantId ? [argv.tenantId] : null;

  do {
    const tenantIds =
      singleTenant ??
      (await StorageGuard.tenantsToAudit({ cursor, limit: TENANT_BATCH }).then((page) => {
        cursor = page.nextCursor;
        return page.tenantIds;
      }));

    for (const tenantId of tenantIds) {
      if (clock?.expired()) {
        log.warn({ audited: summary.audited }, 'recompute: stopping at the time budget');
        return summary;
      }

      const { recordedBytes, actualBytes, breakdown } = await StorageGuard.recompute(tenantId);
      const drift = actualBytes - recordedBytes;
      summary.audited += 1;

      if (Math.abs(drift) > Math.abs(summary.largestDriftBytes)) {
        summary.largestDriftBytes = drift;
        summary.largestDriftTenantId = tenantId;
      }

      if (Math.abs(drift) < SIGNIFICANT_DRIFT_BYTES) {
        summary.unchanged += 1;
        continue;
      }

      // Report first. A repeat offender is a leak, not a rounding error, and the alarm in
      // section 11.1 is supposed to notice.
      log.warn(
        { tenantId, recordedBytes, actualBytes, driftBytes: drift, breakdown },
        'recompute: storage quota drift',
      );
      metrics.gauge?.('storage_quota_drift_bytes', Math.abs(drift), { tenant: tenantId });

      if (!dryRun) {
        await StorageGuard.repair(tenantId, actualBytes, { reason: 'nightly-recompute' });
        summary.repaired += 1;
      }
    }

    if (singleTenant) break;
  } while (cursor && !clock?.expired());

  metrics.gauge?.('storage_quota_tenants_repaired', summary.repaired);
  return summary;
}

if (isMain(import.meta.url)) {
  await runJob('recomputeStorageUsage', recomputeStorageUsage, { timeBudgetMs: 20 * 60_000, lockTtlMs: 25 * 60_000 });
}

export default recomputeStorageUsage;