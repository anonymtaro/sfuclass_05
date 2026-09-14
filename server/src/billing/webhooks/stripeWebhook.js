// classroom-app/server/src/billing/webhooks/stripeWebhook.js
/**
 * Stripe webhook  [UNCHANGED]
 *
 * Reference implementation; keep yours if it differs.
 *
 * Three properties, in order of how expensive they are to get wrong:
 *
 *   signature verified   an unverified endpoint is an open API for granting
 *                        yourself a subscription. The signature is computed
 *                        over the exact bytes, which is why this route is
 *                        mounted on the raw body parser — see bodyLimits.js.
 *
 *   idempotent           Stripe delivers at least once and retries for three
 *                        days. A retried `invoice.paid` must not extend a
 *                        subscription twice.
 *
 *   fast                 Stripe times out after a few seconds and retries what
 *                        it considers failed. The handler claims the event,
 *                        answers, and then does the work.
 *
 * The status codes are deliberate: 400 for anything Stripe should stop
 * retrying, 500 only for something a retry might fix.
 */

import { logger } from '../../observability/logger.js';
import * as Stripe from '../stripeClient.js';
import * as ProcessedEvents from '../models/ProcessedEvent.js';
import * as SubscriptionService from '../SubscriptionService.js';
import * as EntitlementCache from '../EntitlementCache.js';

const log = logger.child({ component: 'stripe-webhook' });

/**
 * Events that change what a tenant may do. Everything else is acknowledged and
 * ignored — subscribing to fewer event types in the dashboard would be better
 * still, but a deployment cannot rely on that being configured correctly.
 */
const HANDLERS = {
  'checkout.session.completed': onCheckoutCompleted,
  'customer.subscription.created': onSubscriptionChanged,
  'customer.subscription.updated': onSubscriptionChanged,
  'customer.subscription.deleted': onSubscriptionDeleted,
  'customer.subscription.trial_will_end': onTrialEnding,
  'invoice.paid': onInvoicePaid,
  'invoice.payment_failed': onPaymentFailed,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handleStripeWebhook = async (req, res) => {
  const signature = req.get('stripe-signature');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

  let event;
  try {
    event = await Stripe.constructEvent(raw, signature);
  } catch (cause) {
    // 400, not 500: a bad signature will never verify on a retry, and telling
    // Stripe to try for three days achieves nothing.
    log.warn({ err: cause.message }, 'rejected a webhook with an invalid signature');
    return res.status(400).json({ error: 'invalid signature' });
  }

  const handler = HANDLERS[event.type];

  if (!handler) {
    // Acknowledged so it is not retried for three days.
    return res.status(200).json({ ignored: event.type });
  }

  const fresh = await ProcessedEvents.claim({
    eventId: event.id,
    source: 'stripe',
    type: event.type,
    payload: { objectId: event.data?.object?.id },
  });

  if (!fresh) {
    log.debug({ eventId: event.id, type: event.type }, 'duplicate webhook ignored');
    return res.status(200).json({ duplicate: true });
  }

  // Answer first. Stripe's timeout is short, and a slow handler turns one
  // event into four.
  res.status(200).json({ received: true });

  try {
    const result = await handler(event);
    await ProcessedEvents.markHandled({ eventId: event.id, result });
    log.info({ eventId: event.id, type: event.type }, 'webhook handled');
  } catch (cause) {
    // Recorded rather than thrown: the response has already gone, and the
    // unhandled sweep is what picks this up.
    await ProcessedEvents.markFailed({ eventId: event.id, error: cause.message });
    log.error({ err: cause, eventId: event.id, type: event.type }, 'webhook handler failed');
  }
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * The customer finished paying. Two things matter: remembering the customer
 * reference so the portal works later, and applying the subscription.
 */
async function onCheckoutCompleted(event) {
  const session = event.data.object;
  const ownerId = session.metadata?.ownerId ?? session.client_reference_id;

  if (!ownerId) {
    log.error({ sessionId: session.id }, 'checkout completed with no ownerId');
    return { skipped: 'no ownerId' };
  }

  if (session.customer) {
    await SubscriptionService.setCustomerRef({ ownerId, customerRef: session.customer });
  }

  if (session.subscription) {
    const subscription = await Stripe.retrieveSubscription(session.subscription);
    // The session's metadata does not always reach the subscription object,
    // so it is put there explicitly before applying.
    subscription.metadata = { ...subscription.metadata, ownerId };
    await SubscriptionService.applyProviderSubscription(subscription);
  }

  return { ownerId, subscription: session.subscription ?? null };
}

/** Created, upgraded, downgraded, paused, resumed — all the same write. */
async function onSubscriptionChanged(event) {
  const applied = await SubscriptionService.applyProviderSubscription(event.data.object);
  return { subscriptionId: applied?.subscriptionId ?? null, status: applied?.status ?? null };
}

async function onSubscriptionDeleted(event) {
  const subscription = event.data.object;
  const ownerId = subscription.metadata?.ownerId;

  const { setStatus } = await import('../models/Subscription.js');
  await setStatus({
    providerRef: subscription.id,
    status: 'canceled',
    canceledAt: new Date().toISOString(),
  });

  // The tenant drops to the free limits immediately, so the cache must go.
  if (ownerId) await EntitlementCache.invalidate(ownerId);

  log.info({ providerRef: subscription.id, ownerId }, 'subscription cancelled');
  return { ownerId, status: 'canceled' };
}

/** Three days before a trial ends. A reminder, not a state change. */
async function onTrialEnding(event) {
  const subscription = event.data.object;
  const ownerId = subscription.metadata?.ownerId;
  if (!ownerId) return { skipped: 'no ownerId' };

  const { notify } = await import('../../community/NotificationService.js');
  await notify({
    userId: ownerId,
    type: 'space.invite', // shared billing channel; see the note in NotificationService
    title: 'Your trial ends in three days',
    body: 'Add a payment method to keep your courses and recordings.',
    href: '/settings/billing',
  }).catch(() => undefined);

  return { ownerId, notified: true };
}

/**
 * A renewal succeeded. The period moved, so the local row has to move with it —
 * otherwise the nightly sweep will decide the subscription expired.
 */
async function onInvoicePaid(event) {
  const invoice = event.data.object;
  if (!invoice.subscription) return { skipped: 'not a subscription invoice' };

  const subscription = await Stripe.retrieveSubscription(invoice.subscription);
  const applied = await SubscriptionService.applyProviderSubscription(subscription);

  return { subscriptionId: applied?.subscriptionId ?? null, periodEnd: applied?.currentPeriodEnd ?? null };
}

/**
 * A card failed. Access is *not* revoked here: the status becomes `past_due`,
 * which still grants entitlement, and Stripe's dunning does the chasing.
 * Cutting a teacher off mid-term over an expired card would be both hostile and
 * bad for recovery.
 */
async function onPaymentFailed(event) {
  const invoice = event.data.object;
  if (!invoice.subscription) return { skipped: 'not a subscription invoice' };

  const subscription = await Stripe.retrieveSubscription(invoice.subscription);
  const applied = await SubscriptionService.applyProviderSubscription(subscription);
  const ownerId = subscription.metadata?.ownerId;

  if (ownerId) {
    const { notify } = await import('../../community/NotificationService.js');
    await notify({
      userId: ownerId,
      type: 'space.invite',
      title: 'A payment did not go through',
      body: 'Update your card to avoid losing access at the end of the period.',
      href: '/settings/billing',
    }).catch(() => undefined);
  }

  log.warn({ ownerId, invoiceId: invoice.id }, 'payment failed');
  return { ownerId, status: applied?.status ?? 'past_due' };
}

/**
 * Replays events that were claimed but never handled — a process that died
 * mid-webhook. Called by jobs/checkExpiredSubscriptions.js.
 */
export const replayUnhandled = async () => {
  const pending = await ProcessedEvents.findUnhandled({ olderThanMinutes: 15 });
  if (pending.length === 0) return { replayed: 0 };

  let replayed = 0;

  for (const record of pending) {
    const handler = HANDLERS[record.type];
    if (!handler) {
      await ProcessedEvents.markHandled({ eventId: record.eventId, result: { ignored: true } });
      continue;
    }

    try {
      // Re-fetched rather than replayed from the stored payload: the stored
      // copy is a summary, and the provider's current state is more correct
      // than a fifteen-minute-old snapshot anyway.
      const objectId = record.payload?.objectId;
      if (!objectId) {
        await ProcessedEvents.markFailed({ eventId: record.eventId, error: 'no object id' });
        continue;
      }

      if (record.type.startsWith('customer.subscription')) {
        const subscription = await Stripe.retrieveSubscription(objectId);
        await SubscriptionService.applyProviderSubscription(subscription);
      }

      await ProcessedEvents.markHandled({ eventId: record.eventId, result: { replayed: true } });
      replayed += 1;
    } catch (cause) {
      await ProcessedEvents.markFailed({ eventId: record.eventId, error: cause.message });
      log.error({ err: cause, eventId: record.eventId }, 'replay failed');
    }
  }

  log.info({ pending: pending.length, replayed }, 'unhandled webhooks replayed');
  return { replayed };
};

export default handleStripeWebhook;