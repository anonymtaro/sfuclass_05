/**
 * pruneChatRetention — message + attachment TTL (F6)
 *
 * This is the one scheduled job that destroys user data on purpose, so it is written to be
 * boring, bounded and reversible for as long as possible:
 *
 *  - Retention is per tenant (CHAT_RETENTION_DAYS is the default, not the rule). A tenant
 *    with no policy is skipped entirely; silence is not consent to delete.
 *  - Deletion is staged. Messages are soft-deleted first and the row is hard-deleted a
 *    grace period later, so an operator who discovers a misconfigured retention setting on
 *    Monday morning still has the data.
 *  - Attachments are detached here, never deleted here. The object's own lifecycle rule on
 *    the bucket removes the bytes; two systems deleting the same object is how you get a
 *    job that fails forever on an object that is already gone.
 *  - Anything under legal hold, or attached to a moderation report that is still open, is
 *    skipped. A retention policy must not shred the evidence in an abuse case.
 *  - Batched with a time budget, and the search index is updated in the same batch, so an
 *    interrupted run never leaves OpenSearch returning messages that no longer exist.
 *
 * Schedule: daily, off-peak.
 */

import { runJob, isMain } from './_runJob.js';
import { env } from '../config/env.js';
import * as ChatModerationService from '../messaging/ChatModerationService.js';
import * as ChatSearchService from '../messaging/ChatSearchService.js';
import * as ChatAttachmentService from '../messaging/ChatAttachmentService.js';
import { metrics } from '../observability/metrics.js';

const BATCH = 1000;
/** Days between soft delete and the row actually going. The "oh no" window. */
const HARD_DELETE_GRACE_DAYS = 7;

export async function pruneChatRetention({ log, clock, argv = {} } = {}) {
  const dryRun = Boolean(argv.dryRun);
  const summary = {
    tenants: 0,
    skippedNoPolicy: 0,
    softDeleted: 0,
    hardDeleted: 0,
    attachmentsDetached: 0,
    heldBack: 0,
    dryRun,
  };

  const tenants = await ChatModerationService.listRetentionPolicies({ defaultDays: env.CHAT_RETENTION_DAYS });

  for (const tenant of tenants) {
    if (clock?.expired()) break;
    summary.tenants += 1;

    // No policy means keep forever. Never fall back to a default that deletes.
    if (!tenant.retentionDays || tenant.retentionDays <= 0) {
      summary.skippedNoPolicy += 1;
      continue;
    }

    const cutoff = new Date(Date.now() - tenant.retentionDays * 86_400_000);

    /* Stage 1 — soft delete. */
    let more = true;
    while (more && !clock?.expired()) {
      const candidates = await ChatModerationService.listExpiredMessages({
        tenantId: tenant.id,
        before: cutoff,
        limit: BATCH,
      });
      more = candidates.length === BATCH;
      if (candidates.length === 0) break;

      const deletable = [];
      for (const message of candidates) {
        // Evidence and legal hold outrank retention.
        if (message.legalHold || message.openReportId) {
          summary.heldBack += 1;
          continue;
        }
        deletable.push(message);
      }
      if (deletable.length === 0) continue;

      if (!dryRun) {
        const ids = deletable.map((message) => message.id);

        // Detach attachments before the message goes, so the asset is not orphaned with no
        // record of what it belonged to. The bucket lifecycle removes the bytes.
        summary.attachmentsDetached += await ChatAttachmentService.detachForMessages(ids, {
          reason: 'retention',
        });

        await ChatModerationService.softDeleteMessages(ids, { reason: 'retention', cutoff });
        // Same batch, so an interrupted run cannot leave search ahead of the database.
        await ChatSearchService.removeMany(ids);
      }
      summary.softDeleted += deletable.length;
    }

    /* Stage 2 — hard delete what was soft-deleted long enough ago. */
    const hardCutoff = new Date(Date.now() - HARD_DELETE_GRACE_DAYS * 86_400_000);
    let purging = true;
    while (purging && !clock?.expired()) {
      const purged = dryRun
        ? 0
        : await ChatModerationService.hardDeleteMessages({
            tenantId: tenant.id,
            softDeletedBefore: hardCutoff,
            reason: 'retention',
            limit: BATCH,
          });
      summary.hardDeleted += purged;
      purging = purged === BATCH;
      if (dryRun) break;
    }
  }

  metrics.increment?.('chat_retention_soft_deleted', summary.softDeleted);
  metrics.increment?.('chat_retention_hard_deleted', summary.hardDeleted);
  if (summary.heldBack > 0) {
    log.info({ heldBack: summary.heldBack }, 'retention: messages kept under legal hold or an open report');
  }
  return summary;
}

if (isMain(import.meta.url)) {
  await runJob('pruneChatRetention', pruneChatRetention, { timeBudgetMs: 20 * 60_000, lockTtlMs: 25 * 60_000 });
}

export default pruneChatRetention;