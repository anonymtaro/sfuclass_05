/**
 * useBilling
 *
 * Moved from client/src/services, now shared by web and mobile.
 *
 * The point of this hook is `can()`. Every gate in the product — the record
 * button, the upload picker, the publish action — asks it, and it answers from
 * the server's pre-computed entitlements rather than comparing numbers locally.
 * A client that does its own arithmetic will eventually enable a button the
 * server then refuses, which is the worst of both worlds.
 *
 * Entitlements are cached server-side for BILLING_ENTITLEMENT_TTL_SEC. This
 * hook refreshes them when the cached copy expires and after any action that
 * could have changed them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type Billing } from '@classroom/contracts';
import type { BillingApi } from '../api/billingApi.js';

export type GatedAction = keyof Billing.Entitlements['can'];

export interface UseBillingOptions {
  api: BillingApi;
  /** Load plans as well. Only the upgrade screen needs them. */
  withPlans?: boolean;
}

export interface UseBillingResult {
  entitlements: Billing.Entitlements | null;
  subscription: Billing.Subscription | null;
  plans: Billing.Plan[];
  loading: boolean;
  error: ApiError | null;

  /** Synchronous gate. False while entitlements are still loading. */
  can(action: GatedAction): boolean;
  /** Percentage of the storage pool in use, 0–100. */
  storagePercent: number;
  /** True when the subscription needs attention: past due, or a failed payment. */
  needsAttention: boolean;

  /** Server-side check with a size, for uploads. Use before a large transfer. */
  checkLimit(
    action: Billing.CheckLimitQuery['action'],
    sizeBytes?: number,
  ): Promise<Billing.LimitCheckResult>;
  refresh(): Promise<void>;
  startCheckout(input: Billing.CreateCheckoutSession): Promise<string>;
  openPortal(returnUrl: string): Promise<string>;
}

export const useBilling = (options: UseBillingOptions): UseBillingResult => {
  const { api, withPlans = false } = options;

  const [entitlements, setEntitlements] = useState<Billing.Entitlements | null>(null);
  const [subscription, setSubscription] = useState<Billing.Subscription | null>(null);
  const [plans, setPlans] = useState<Billing.Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [ent, sub] = await Promise.all([
          api.getEntitlements(signal),
          api.getSubscription(signal),
        ]);
        setEntitlements(ent);
        setSubscription(sub);
        setError(null);

        if (withPlans) {
          const list = await api.listPlans(signal);
          setPlans(list.items);
        }
      } catch (cause) {
        if (!signal?.aborted) setError(ApiError.is(cause) ? cause : null);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [api, withPlans],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /**
   * Refresh exactly when the server's cached copy goes stale, rather than
   * polling. A gate answered from an expired entitlement is a gate that will
   * disagree with the next request.
   */
  useEffect(() => {
    if (!entitlements) return;
    const msUntilStale = Date.parse(entitlements.expiresAt) - Date.now();
    if (expiryTimer.current) clearTimeout(expiryTimer.current);
    expiryTimer.current = setTimeout(
      () => void load(),
      Math.max(msUntilStale, 5_000),
    );
    return () => {
      if (expiryTimer.current) clearTimeout(expiryTimer.current);
    };
  }, [entitlements, load]);

  const can = useCallback(
    (action: GatedAction): boolean => entitlements?.can[action] ?? false,
    [entitlements],
  );

  const storagePercent = useMemo(() => {
    if (!entitlements) return 0;
    const { storageBytes, storageQuotaBytes } = entitlements.usage;
    if (storageQuotaBytes <= 0) return 0;
    return Math.min(100, Math.round((storageBytes / storageQuotaBytes) * 100));
  }, [entitlements]);

  const needsAttention = useMemo(() => {
    const status = entitlements?.status;
    return status === 'past_due' || status === 'incomplete';
  }, [entitlements]);

  return {
    entitlements,
    subscription,
    plans,
    loading,
    error,
    can,
    storagePercent,
    needsAttention,

    checkLimit: (action, sizeBytes) => api.checkLimit({ action, sizeBytes }),

    refresh: () => load(),

    /** Returns the URL to redirect to; navigation belongs to the app layer. */
    startCheckout: async (input) => {
      const session = await api.startCheckout(input);
      return session.url;
    },

    openPortal: async (returnUrl) => {
      const session = await api.openPortal({ returnUrl });
      return session.url;
    },
  };
};