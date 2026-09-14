/**
 * Billing API
 *
 * Moved from client/src/services with one change: it now returns parsed,
 * contract-typed values instead of raw JSON, and it is callable from the mobile
 * app as well as the web app.
 *
 * No card data ever passes through here. Checkout and plan management are
 * redirects to the provider's hosted pages, which is what keeps PCI scope out
 * of this codebase entirely.
 *
 * `getEntitlements()` is the one call the rest of the product depends on. It is
 * cached server-side for BILLING_ENTITLEMENT_TTL_SEC and carries pre-computed
 * `can.*` answers, so no client ever re-implements a limit comparison and then
 * disagrees with the server about whether a button should work.
 */

import { Billing } from '@classroom/contracts';
import type { z } from 'zod';
import type { HttpClient } from '../http/httpClient.js';

export interface BillingApi {
  listPlans(signal?: AbortSignal): Promise<z.infer<typeof Billing.PlanListSchema>>;
  getSubscription(signal?: AbortSignal): Promise<z.infer<typeof Billing.SubscriptionSchema> | null>;
  getEntitlements(signal?: AbortSignal): Promise<z.infer<typeof Billing.EntitlementsSchema>>;
  checkLimit(
    query: z.infer<typeof Billing.CheckLimitQuerySchema>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Billing.LimitCheckResultSchema>>;
  startCheckout(
    input: z.infer<typeof Billing.CreateCheckoutSessionSchema>,
  ): Promise<z.infer<typeof Billing.CheckoutSessionSchema>>;
  openPortal(
    input: z.infer<typeof Billing.CreatePortalSessionSchema>,
  ): Promise<z.infer<typeof Billing.CheckoutSessionSchema>>;
  previewPlanChange(
    input: z.infer<typeof Billing.ChangePlanSchema>,
  ): Promise<z.infer<typeof Billing.PlanChangePreviewSchema>>;
  changePlan(
    input: z.infer<typeof Billing.ChangePlanSchema>,
  ): Promise<z.infer<typeof Billing.SubscriptionSchema>>;
  cancel(
    input: z.infer<typeof Billing.CancelSubscriptionSchema>,
  ): Promise<z.infer<typeof Billing.SubscriptionSchema>>;
  listInvoices(
    query?: { cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Billing.InvoiceListSchema>>;
}

export const createBillingApi = (http: HttpClient): BillingApi => ({
  listPlans: (signal) =>
    http.get('/billing/plans', { schema: Billing.PlanListSchema, signal }),

  /** Null on a free tenant that has never subscribed — not an error. */
  getSubscription: async (signal) => {
    const result = await http.get('/billing/subscription', {
      schema: Billing.SubscriptionSchema.nullable(),
      signal,
    });
    return result;
  },

  getEntitlements: (signal) =>
    http.get('/billing/entitlements', { schema: Billing.EntitlementsSchema, signal }),

  /**
   * Asked before showing a paywall, not after a failure. The server answers
   * from the same LimitResolver the enforcing route uses, so the dialog and
   * the rejection can never disagree.
   */
  checkLimit: (query, signal) =>
    http.get('/billing/limits/check', {
      schema: Billing.LimitCheckResultSchema,
      query: { action: query.action, sizeBytes: query.sizeBytes },
      signal,
    }),

  startCheckout: (input) =>
    http.post('/billing/checkout', input, { schema: Billing.CheckoutSessionSchema }),

  openPortal: (input) =>
    http.post('/billing/portal', input, { schema: Billing.CheckoutSessionSchema }),

  /** Same route as changePlan, with previewOnly forced on. */
  previewPlanChange: (input) =>
    http.post(
      '/billing/subscription/change',
      { ...input, previewOnly: true },
      { schema: Billing.PlanChangePreviewSchema },
    ),

  changePlan: (input) =>
    http.post(
      '/billing/subscription/change',
      { ...input, previewOnly: false },
      { schema: Billing.SubscriptionSchema },
    ),

  cancel: (input) =>
    http.post('/billing/subscription/cancel', input, { schema: Billing.SubscriptionSchema }),

  listInvoices: (query = {}, signal) =>
    http.get('/billing/invoices', {
      schema: Billing.InvoiceListSchema,
      query: { cursor: query.cursor, limit: query.limit },
      signal,
    }),
});