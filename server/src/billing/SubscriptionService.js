// classroom-app/server/src/billing/SubscriptionService.js
/**
 * Subscriptions  [UNCHANGED]
 *
 * Reference implementation; keep yours if it differs. Version 6 changes nothing
 * here — the storage limit arrives through the plan, and this file already
 * treats limits as opaque.
 *
 * The orchestration layer between the product and Stripe. Two rules run through
 * it:
 *
 *   Stripe is the source of truth for money; this database is a cache of it.
 *   Every state change is written here *from a webhook*, never optimistically
 *   after an API call — a plan change that succeeded locally and failed at the
 *   provider is a tenant using something they are not paying for.
 *
 *   Entitlements are invalidated on every change. Forgetting that is the bug
 *   where somebody upgrades and stares at the same paywall for a minute.
 */

import { logger } from '../observability/logger.js';
import * as Plans from './models/Plan.js';
import * as Subscriptions from './models/Subscription.js';
import * as Stripe from './stripeClient.js';
import * as EntitlementCache from './EntitlementCache.js';

const log = logger.child({ component: 'subscriptions' });

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const getSubscription = (ownerId) => Subscriptions.findByOwner(ownerId);

export const listPlans = async () => ({ items: await Plans.listVisible() });

export const getEntitlements = (ownerId) => EntitlementCache.get(ownerId);

export const listInvoices = async ({ ownerId, cursor, limit }) => {
  const customerRef = await customerRefFor(ownerId);
  if (!customerRef) return { items: [], hasMore: false, nextCursor: null };
  return Stripe.listInvoices({ customerRef, limit, startingAfter: cursor });
};

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------

export const startCheckout = async ({ ownerId, planCode, interval = 'month', quantity = 1, successUrl, cancelUrl }) => {
  const plan = await Plans.findByCode(planCode);
  if (!plan || !plan.visible) {
    throw Object.assign(new Error('that plan is not available'), { code: 'not_found' });
  }

  // Already subscribed: a second checkout would create a second subscription
  // and bill twice. The portal is where a change belongs.
  const existing = await Subscriptions.findByOwner(ownerId);
  if (Subscriptions.isEntitled(existing)) {
    throw Object.assign(new Error('you already have a subscription; change it instead'), {
      code: 'conflict',
    });
  }

  return Stripe.createCheckoutSession({
    ownerId,
    planCode,
    interval,
    quantity,
    successUrl,
    cancelUrl,
    customerRef: await customerRefFor(ownerId),
  });
};

export const openPortal = async ({ ownerId, returnUrl }) => {
  const customerRef = await customerRefFor(ownerId);
  if (!customerRef) {
    throw Object.assign(new Error('there is nothing to manage yet'), { code: 'not_found' });
  }
  return Stripe.createPortalSession({ customerRef, returnUrl });
};

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

/**
 * Previews a plan change, including what it would take away.
 *
 * The blockers are the part worth having: a tenant using 40 GB cannot move to a
 * 10 GB plan, and telling them afterwards means they are over quota with no way
 * back.
 */
export const previewChange = async ({ ownerId, planCode, quantity }) => {
  const [subscription, target] = await Promise.all([
    Subscriptions.findByOwner(ownerId),
    Plans.findByCode(planCode),
  ]);

  if (!subscription) throw Object.assign(new Error('no subscription to change'), { code: 'not_found' });
  if (!target) throw Object.assign(new Error('unknown plan'), { code: 'not_found' });

  const current = (await Plans.findById(subscription.planId)) ?? Plans.freePlan();
  const losses = Plans.compareLimits(current, target);
  const entitlements = await EntitlementCache.get(ownerId);

  const blockers = [];

  for (const loss of losses) {
    if (loss.key === 'storageQuotaGb') {
      const wouldBe = target.limits.storageQuotaGb * 1024 * 1024 * 1024;
      if (entitlements.usage.storageBytes > wouldBe) {
        blockers.push({
          code: 'quota_exceeded',
          message: `You are using ${formatGb(entitlements.usage.storageBytes)} of storage; this plan allows ${target.limits.storageQuotaGb} GB. Delete some files first.`,
        });
      }
    }
    if (loss.key === 'maxCourses' && typeof loss.to === 'number') {
      if (entitlements.usage.publishedCourses > loss.to) {
        blockers.push({
          code: 'plan_upgrade_required',
          message: `You have ${entitlements.usage.publishedCourses} published courses; this plan allows ${loss.to}.`,
        });
      }
    }
  }

  const preview = await Stripe.previewChange({
    providerRef: subscription.providerRef,
    planCode,
    interval: subscription.interval ?? 'month',
    quantity: quantity ?? subscription.quantity,
  });

  return { ...preview, blockers, losses };
};

export const changePlan = async ({ ownerId, planCode, quantity }) => {
  const preview = await previewChange({ ownerId, planCode, quantity });

  if (preview.blockers.length > 0) {
    throw Object.assign(new Error(preview.blockers[0].message), {
      code: preview.blockers[0].code,
      blockers: preview.blockers,
    });
  }

  const subscription = await Subscriptions.findByOwner(ownerId);

  await Stripe.changePlan({
    providerRef: subscription.providerRef,
    planCode,
    interval: subscription.interval ?? 'month',
    quantity: quantity ?? subscription.quantity,
  });

  // The local row is written by the webhook that follows, not here. Until then
  // the tenant keeps their old entitlements, which is the safe direction to be
  // wrong in.
  await EntitlementCache.invalidate(ownerId);

  log.info({ ownerId, planCode }, 'plan change requested');
  return Subscriptions.findByOwner(ownerId);
};

export const cancel = async ({ ownerId, immediately = false, reason = null }) => {
  const subscription = await Subscriptions.findByOwner(ownerId);
  if (!subscription) throw Object.assign(new Error('no subscription'), { code: 'not_found' });

  await Stripe.cancelSubscription({ providerRef: subscription.providerRef, immediately });
  await EntitlementCache.invalidate(ownerId);

  log.info({ ownerId, immediately, reason }, 'cancellation requested');
  return Subscriptions.findByOwner(ownerId);
};

// ---------------------------------------------------------------------------
// Applying provider state
// ---------------------------------------------------------------------------

/**
 * Writes a provider subscription into the local row. Called by the webhook, and
 * by the reconcile path when a webhook was missed.
 *
 * Idempotent by construction: the same provider object applied twice produces
 * the same row.
 */
export const applyProviderSubscription = async (providerSubscription) => {
  const ownerId = providerSubscription.metadata?.ownerId;
  if (!ownerId) {
    log.error({ providerRef: providerSubscription.id }, 'provider subscription carries no ownerId');
    return null;
  }

  const priceId = providerSubscription.items?.data?.[0]?.price?.id;
  const planCode = Stripe.planCodeFor(priceId) ?? providerSubscription.metadata?.planCode;
  const plan = planCode ? await Plans.findByCode(planCode) : null;

  if (!plan) {
    // A price that is not in STRIPE_PRICE_MAP. Loud, because the tenant has
    // paid for something this deployment cannot grant.
    log.error({ ownerId, priceId, planCode }, 'UNMAPPED PRICE: subscription cannot be applied');
    return null;
  }

  const subscription = await Subscriptions.upsertFromProvider({
    ownerId,
    planId: plan.planId,
    status: providerSubscription.status,
    quantity: providerSubscription.items.data[0].quantity ?? 1,
    currentPeriodStart: new Date(providerSubscription.current_period_start * 1000).toISOString(),
    currentPeriodEnd: new Date(providerSubscription.current_period_end * 1000).toISOString(),
    trialEndsAt: providerSubscription.trial_end
      ? new Date(providerSubscription.trial_end * 1000).toISOString()
      : null,
    cancelAt: providerSubscription.cancel_at
      ? new Date(providerSubscription.cancel_at * 1000).toISOString()
      : null,
    canceledAt: providerSubscription.canceled_at
      ? new Date(providerSubscription.canceled_at * 1000).toISOString()
      : null,
    providerRef: providerSubscription.id,
  });

  await EntitlementCache.invalidate(ownerId);

  log.info({ ownerId, planCode, status: subscription.status }, 'subscription applied');
  return subscription;
};

/**
 * Nightly sweep for subscriptions whose period ended without a renewal — a
 * webhook that never arrived, or a provider outage. Asks Stripe directly rather
 * than assuming.
 */
export const reconcileExpired = async () => {
  const expired = await Subscriptions.findExpired();
  if (expired.length === 0) return { checked: 0, corrected: 0 };

  let corrected = 0;

  for (const subscription of expired) {
    try {
      const remote = await Stripe.retrieveSubscription(subscription.providerRef);
      await applyProviderSubscription(remote);
      corrected += 1;
    } catch (cause) {
      // Gone at the provider: the subscription really has ended.
      if (cause?.code === 'resource_missing') {
        await Subscriptions.setStatus({
          providerRef: subscription.providerRef,
          status: 'canceled',
          canceledAt: new Date().toISOString(),
        });
        await EntitlementCache.invalidate(subscription.ownerId);
        corrected += 1;
      } else {
        log.error({ err: cause, providerRef: subscription.providerRef }, 'could not reconcile');
      }
    }
  }

  log.info({ checked: expired.length, corrected }, 'expired subscriptions reconciled');
  return { checked: expired.length, corrected };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const customerRefFor = async (ownerId) => {
  const { pool } = await import('../db/pool.js');
  const { rows } = await pool.query(`SELECT billing_customer_ref FROM users WHERE id = $1`, [ownerId]);
  return rows[0]?.billing_customer_ref ?? null;
};

export const setCustomerRef = async ({ ownerId, customerRef }) => {
  const { pool } = await import('../db/pool.js');
  await pool.query(`UPDATE users SET billing_customer_ref = $2 WHERE id = $1`, [ownerId, customerRef]);
};

const formatGb = (bytes) => `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;

export default {
  getSubscription, listPlans, getEntitlements, listInvoices, startCheckout,
  openPortal, previewChange, changePlan, cancel, applyProviderSubscription, reconcileExpired,
};