import { useState } from 'react';
import { useBilling } from '@classroom/core-client';
import UpgradePlanModal from './UpgradePlanModal.jsx';
import './billing.css';

const STATE_TEXT = {
  trialing: (sub) => {
    const days = Math.max(
      0,
      Math.ceil((new Date(sub.trialEndsAt) - Date.now()) / 86_400_000),
    );
    return days === 0 ? 'Trial ends today' : `Trial · ${days}d left`;
  },
  past_due: () => 'Payment failed',
  canceled: (sub) =>
    sub.currentPeriodEnd ? `Ends ${new Date(sub.currentPeriodEnd).toLocaleDateString()}` : 'Cancelled',
  active: null,
};

/**
 * The plan, in one line, in the app chrome.
 *
 * Its real job is the states nobody asks about: a trial running out and a
 * payment that failed. Both are silent until someone hits a limit, which is the
 * worst possible moment to learn about them, so the badge changes colour early
 * and says why.
 *
 * Entitlements come from EntitlementCache (Redis, 60s TTL), so this reflects
 * what LimitResolver will actually decide — not a value read once at login.
 */
export default function CurrentPlanBadge({ className = '', onOpenBilling }) {
  const { plan, subscription, loading, canManageBilling } = useBilling();
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  if (loading && !plan) return null;
  if (!plan) return null;

  const state = subscription?.status ?? 'active';
  const detail = STATE_TEXT[state]?.(subscription ?? {}) ?? null;

  const label = detail ? `${plan.name} · ${detail}` : plan.name;

  const open = () => {
    if (onOpenBilling) return onOpenBilling();
    if (canManageBilling) setUpgradeOpen(true);
  };

  const interactive = Boolean(onOpenBilling || canManageBilling);

  return (
    <>
      {interactive ? (
        <button
          type="button"
          className={`bl bl-badge ${className}`}
          data-state={state}
          onClick={open}
          title={
            state === 'past_due'
              ? 'The last payment did not go through'
              : `You are on the ${plan.name} plan`
          }
        >
          <span className="bl-badge__dot" aria-hidden="true" />
          {label}
        </button>
      ) : (
        <span className={`bl bl-badge ${className}`} data-state={state}>
          <span className="bl-badge__dot" aria-hidden="true" />
          {label}
        </span>
      )}

      {upgradeOpen ? (
        <UpgradePlanModal currentPlanId={plan.id} onClose={() => setUpgradeOpen(false)} />
      ) : null}
    </>
  );
}