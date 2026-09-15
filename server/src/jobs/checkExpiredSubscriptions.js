/**
 * checkExpiredSubscriptions — leader-elected. [UNCHANGED — reference fassung]
 *
 * Stripe is the source of truth for what a tenant has paid for, and the webhook is how we
 * find out. This job exists for the case where the webhook did not arrive: a delivery lost
 * during a deploy, an endpoint that was misconfigured for a day, a subscription that lapsed
 * while our receiver was returning 500s.
 *
 * Two directions, and the second one is the one that matters:
 *   - past its period end and still marked active  → downgrade
 *   - marked expired but Stripe says active        → restore
 *
 * Wrongly downgrading a paying customer is far worse than briefly letting a lapsed one
 * keep their seats, so every downgrade is confirmed against Stripe before it is applied.
 * The local `current_period_end` alone is not evidence: it is a cached copy of something
 * only Stripe knows.
 *
 * Schedule: hourly.
 */

import { runJob, isMain } from './_runJob.js';
import * as SubscriptionService from '../billing/SubscriptionService.js';
import * as EntitlementCache from '../billing/EntitlementCache.js';
import { getStripe } from '../billing/stripeClient.js';
import { metrics } from '../observability/metrics.js';

const BATCH = 200;
/** Stripe's own dunning runs for days; do not race it. */
const GRACE_HOURS = 24;

export async function checkExpiredSubscriptions({ log, clock, argv = {} } = {}) {
  const stripe = await getStripe();
  const dryRun = Boolean(argv.dryRun);
  const summary = { checked: 0, downgraded: 0, restored: 0, stillPaid: 0, unreachable: 0, dryRun };

  const cutoff = new Date(Date.now() - GRACE_HOURS * 3_600_000);
  const candidates = await SubscriptionService.listPastPeriodEnd({ before: cutoff, limit: argv.limit ?? BATCH });

  for (const subscription of candidates) {
    if (clock?.expired()) break;
    summary.checked += 1;

    // No Stripe subscription at all: a manual or legacy plan. Leave it alone — this job
    // must never downgrade something it does not understand.
    if (!subscription.stripeSubscriptionId) {
      summary.unreachable += 1;
      continue;
    }

    let remote;
    try {
      remote = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
    } catch (error) {
      if (error.statusCode === 404) {
        // Deleted at Stripe. That is a definitive answer, not an outage.
        remote = { status: 'canceled' };
      } else {
        // Stripe is unreachable. Change nothing: an API outage is not a billing event.
        summary.unreachable += 1;
        log.warn({ err: error, tenantId: subscription.tenantId }, 'billing: Stripe unreachable, skipping');
        continue;
      }
    }

    const paid = ['active', 'trialing', 'past_due'].includes(remote.status);

    if (paid) {
      // Our copy was stale, not their payment. Refresh the period end and move on.
      if (!dryRun) {
        await SubscriptionService.syncFromStripe(subscription.tenantId, remote);
        await EntitlementCache.invalidate(subscription.tenantId);
      }
      summary.stillPaid += 1;
      continue;
    }

    if (!dryRun) {
      await SubscriptionService.downgradeToFree({
        tenantId: subscription.tenantId,
        reason: `stripe:${remote.status}`,
      });
      await EntitlementCache.invalidate(subscription.tenantId);
    }
    summary.downgraded += 1;
    log.info({ tenantId: subscription.tenantId, stripeStatus: remote.status }, 'billing: downgraded');
  }

  /* The other direction: we marked them expired, Stripe says they are paying. */
  const wronglyExpired = await SubscriptionService.listExpiredWithLiveStripe({ limit: BATCH });
  for (const subscription of wronglyExpired) {
    if (clock?.expired()) break;
    if (!dryRun) {
      await SubscriptionService.restore(subscription.tenantId);
      await EntitlementCache.invalidate(subscription.tenantId);
    }
    summary.restored += 1;
    log.warn({ tenantId: subscription.tenantId }, 'billing: restored a wrongly expired subscription');
  }

  metrics.gauge?.('billing_downgraded', summary.downgraded);
  metrics.gauge?.('billing_stripe_unreachable', summary.unreachable);
  return summary;
}

if (isMain(import.meta.url)) {
  await runJob('checkExpiredSubscriptions', checkExpiredSubscriptions, { timeBudgetMs: 10 * 60_000 });
}

export default checkExpiredSubscriptions;