/**
 * billing.routes — plans · subscription · checkout · webhook. [UNCHANGED — reference fassung]
 *
 * The one route in the whole API that must NOT have a parsed JSON body: Stripe signs the
 * raw bytes, and `express.json()` reassembles them into something whose signature no longer
 * verifies. That is why the webhook is mounted with `express.raw()` here and why this
 * router has to be registered before the global body parser in app.js.
 *
 * Everything else about billing is deliberately dull: the client never tells the server
 * what plan it has. It asks Stripe for a Checkout session, Stripe tells us through the
 * webhook, and the entitlement cache is invalidated. A client-supplied plan id is a free
 * upgrade button.
 */

import { Router } from 'express';
import express from 'express';
import { z } from 'zod';

import * as SubscriptionService from '../billing/SubscriptionService.js';
import * as LimitResolver from '../billing/LimitResolver.js';
import * as EntitlementCache from '../billing/EntitlementCache.js';
import { constructEvent } from '../billing/stripeClient.js';
import { handleStripeWebhook } from '../billing/webhooks/stripeWebhook.js';
import { env } from '../config/env.js';
import { route, validate, requireAuth, requireRole, tenantOf, noStore, badRequest } from './_helpers.js';

const router = Router();

/* ------------------------------------------------------------------ *
 * Webhook — raw body, no auth, signature verified
 * ------------------------------------------------------------------ */

/**
 * Registered before `requireAuth` and with its own body parser. Stripe is not a logged-in
 * user, and the signature is the authentication.
 */
router.post(
  '/billing/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req, res) => {
    const signature = req.get('stripe-signature');
    if (!signature) return res.status(400).send('Missing signature');

    let event;
    try {
      event = await constructEvent(req.body, signature);
    } catch (error) {
      // Never log the body here: it is a signed payload we could not verify.
      return res.status(400).send(`Signature verification failed: ${error.message}`);
    }

    // Acknowledge fast, then process. Stripe retries for days if we are slow, and a retry
    // storm during a deploy is how a webhook handler runs twenty times.
    res.status(200).json({ received: true });
    await handleStripeWebhook(event);
  },
);

router.use(requireAuth);

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

router.get(
  '/billing/plans',
  route(async () => ({ plans: await SubscriptionService.listPlans() })),
);

router.get(
  '/billing/subscription',
  route(async (req, res) => {
    noStore(res);
    return SubscriptionService.forTenant(tenantOf(req));
  }),
);

/** What the UI greys out: seats, storage, courses, and how much of each is used. */
router.get(
  '/billing/entitlements',
  route(async (req) => LimitResolver.describe(tenantOf(req))),
);

/* ------------------------------------------------------------------ *
 * Changing a plan — always through Stripe, never through a request body
 * ------------------------------------------------------------------ */

router.post(
  '/billing/checkout',
  requireRole('owner'),
  validate({
    body: z.object({
      planCode: z.string().min(1).max(40),
      seats: z.number().int().min(1).max(10_000).default(1),
      successUrl: z.string().url().optional(),
      cancelUrl: z.string().url().optional(),
    }),
  }),
  route(async (req) => {
    const plan = await SubscriptionService.getPlanByCode(req.body.planCode);
    if (!plan?.stripePriceId) throw badRequest('Unknown plan');

    return SubscriptionService.createCheckoutSession({
      tenantId: tenantOf(req),
      actorId: req.user.id,
      plan,
      seats: req.body.seats,
      successUrl: req.body.successUrl ?? `${env.APP_URL}/settings/billing?status=success`,
      cancelUrl: req.body.cancelUrl ?? `${env.APP_URL}/settings/billing?status=cancelled`,
    });
  }),
);

/** The customer portal owns cancellation, card changes and invoices. We do not rebuild it. */
router.post(
  '/billing/portal',
  requireRole('owner'),
  route(async (req) =>
    SubscriptionService.createPortalSession({
      tenantId: tenantOf(req),
      returnUrl: `${env.APP_URL}/settings/billing`,
    }),
  ),
);

/**
 * Seat count is the one thing that changes often enough to deserve its own route. It is
 * still Stripe that decides: this updates the subscription item and waits for the webhook
 * to move our own row.
 */
router.put(
  '/billing/seats',
  requireRole('owner'),
  validate({ body: z.object({ seats: z.number().int().min(1).max(10_000) }) }),
  route(async (req) => {
    const result = await SubscriptionService.updateSeats({
      tenantId: tenantOf(req),
      seats: req.body.seats,
      actorId: req.user.id,
    });
    // 60-second cache; without this the capacity guard refuses joins the owner just paid for.
    await EntitlementCache.invalidate(tenantOf(req));
    return result;
  }),
);

router.get(
  '/billing/invoices',
  requireRole('owner'),
  route(async (req) => ({ invoices: await SubscriptionService.listInvoices(tenantOf(req)) })),
);

export default router;