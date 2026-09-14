// classroom-app/server/src/billing/stripeClient.js
/**
 * Stripe client  [UNCHANGED]
 *
 * Reference implementation; keep yours if it differs.
 *
 * The only file that imports the Stripe SDK, for the same reason StorageClient
 * is the only one that imports the S3 SDK: one place to stub in a test, one
 * place to change when the API version moves.
 *
 * No card data ever reaches this process. Checkout and card management are
 * hosted pages on Stripe's side, and this client only ever creates sessions and
 * reads back what happened — which is what keeps PCI scope out of the codebase
 * entirely.
 */

import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'stripe' });

/** Pinned. An unpinned version changes the shape of a webhook without warning. */
const API_VERSION = '2025-04-30.basil';

let stripe = null;

export const getStripe = async () => {
  if (stripe) return stripe;

  if (!env.STRIPE_SECRET_KEY) {
    throw Object.assign(new Error('billing is not configured'), { code: 'not_implemented' });
  }

  const { default: Stripe } = await import('stripe');
  stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: API_VERSION,
    // Two retries on a network failure. Stripe's own idempotency makes a
    // retried create safe, so this cannot double-charge.
    maxNetworkRetries: 2,
    timeout: 15_000,
    telemetry: false,
  });

  return stripe;
};

export const isConfigured = () => Boolean(env.STRIPE_SECRET_KEY);

/** Internal plan code → Stripe price id, from STRIPE_PRICE_MAP. */
export const priceFor = (planCode, interval = 'month') => {
  const map = env.STRIPE_PRICE_MAP ?? {};
  const entry = map[planCode];

  if (!entry) return null;
  // The map allows either a bare price id or one per interval.
  return typeof entry === 'string' ? entry : (entry[interval] ?? null);
};

/** The reverse, for turning a webhook back into something we recognise. */
export const planCodeFor = (priceId) => {
  const map = env.STRIPE_PRICE_MAP ?? {};

  for (const [code, entry] of Object.entries(map)) {
    if (typeof entry === 'string' && entry === priceId) return code;
    if (typeof entry === 'object' && Object.values(entry).includes(priceId)) return code;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const createCheckoutSession = async ({ ownerId, planCode, interval, quantity, successUrl, cancelUrl, customerRef }) => {
  const client = await getStripe();
  const price = priceFor(planCode, interval);

  if (!price) {
    throw Object.assign(new Error(`no price configured for ${planCode}`), { code: 'not_implemented' });
  }

  const session = await client.checkout.sessions.create(
    {
      mode: 'subscription',
      line_items: [{ price, quantity }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      ...(customerRef ? { customer: customerRef } : { client_reference_id: ownerId }),
      // Carried through to the subscription, so a webhook can find the tenant
      // without a lookup table.
      subscription_data: { metadata: { ownerId, planCode } },
      metadata: { ownerId, planCode },
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
    },
    // Keyed per owner and plan: a double-click produces one session.
    { idempotencyKey: `checkout:${ownerId}:${planCode}:${interval}` },
  );

  log.info({ ownerId, planCode, sessionId: session.id }, 'checkout session created');
  return { url: session.url, expiresAt: new Date(session.expires_at * 1000).toISOString() };
};

/** The hosted page where a customer manages cards, invoices and cancellation. */
export const createPortalSession = async ({ customerRef, returnUrl }) => {
  const client = await getStripe();
  const session = await client.billingPortal.sessions.create({
    customer: customerRef,
    return_url: returnUrl,
  });
  return { url: session.url, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
};

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export const retrieveSubscription = async (providerRef) => {
  const client = await getStripe();
  return client.subscriptions.retrieve(providerRef, { expand: ['items.data.price'] });
};

/**
 * Previews what a plan change would cost before it happens, so the dialog can
 * show a real number rather than "your card will be charged something".
 */
export const previewChange = async ({ providerRef, planCode, interval, quantity }) => {
  const client = await getStripe();
  const price = priceFor(planCode, interval);
  const subscription = await client.subscriptions.retrieve(providerRef);

  const preview = await client.invoices.createPreview({
    customer: subscription.customer,
    subscription: providerRef,
    subscription_details: {
      items: [{ id: subscription.items.data[0].id, price, quantity }],
      proration_behavior: 'create_prorations',
    },
  });

  return {
    immediateCharge: preview.amount_due > 0
      ? { amountMinor: preview.amount_due, currency: preview.currency.toUpperCase() }
      : null,
    nextInvoiceTotal: { amountMinor: preview.total, currency: preview.currency.toUpperCase() },
    effectiveAt: new Date().toISOString(),
  };
};

export const changePlan = async ({ providerRef, planCode, interval, quantity }) => {
  const client = await getStripe();
  const price = priceFor(planCode, interval);
  const subscription = await client.subscriptions.retrieve(providerRef);

  return client.subscriptions.update(providerRef, {
    items: [{ id: subscription.items.data[0].id, price, quantity }],
    // Prorate: charging a full month for an upgrade on the 28th is the kind of
    // thing people notice and remember.
    proration_behavior: 'create_prorations',
    metadata: { planCode },
  });
};

export const cancelSubscription = async ({ providerRef, immediately = false }) => {
  const client = await getStripe();

  return immediately
    ? client.subscriptions.cancel(providerRef)
    // The default: access continues until the period they have paid for ends.
    : client.subscriptions.update(providerRef, { cancel_at_period_end: true });
};

export const listInvoices = async ({ customerRef, limit = 25, startingAfter = null }) => {
  const client = await getStripe();
  const result = await client.invoices.list({
    customer: customerRef,
    limit,
    ...(startingAfter ? { starting_after: startingAfter } : {}),
  });

  return {
    items: result.data.map((invoice) => ({
      invoiceId: invoice.id,
      number: invoice.number ?? invoice.id,
      status: invoice.status,
      total: { amountMinor: invoice.total, currency: invoice.currency.toUpperCase() },
      periodStart: new Date(invoice.period_start * 1000).toISOString(),
      periodEnd: new Date(invoice.period_end * 1000).toISOString(),
      issuedAt: new Date(invoice.created * 1000).toISOString(),
      paidAt: invoice.status_transitions?.paid_at
        ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
        : null,
      hostedUrl: invoice.hosted_invoice_url,
      pdfUrl: invoice.invoice_pdf,
    })),
    hasMore: result.has_more,
    nextCursor: result.has_more ? result.data.at(-1)?.id ?? null : null,
  };
};

/** Verifies a webhook signature. Throws when it does not match. */
export const constructEvent = async (rawBody, signature) => {
  const client = await getStripe();
  return client.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
};

/** Tests only. */
export const resetStripeClient = () => {
  stripe = null;
};

export default { getStripe, priceFor, planCodeFor, createCheckoutSession, createPortalSession, changePlan, cancelSubscription, constructEvent };