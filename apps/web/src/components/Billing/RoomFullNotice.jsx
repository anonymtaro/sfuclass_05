import { useState } from 'react';
import { useBilling } from '@classroom/core-client';
import UpgradePlanModal from './UpgradePlanModal.jsx';
import './billing.css';

/**
 * Shown when CapacityGuard refuses a seat.
 *
 * The refusal is atomic — reserveSeat.lua either takes a seat or does not — so
 * this screen means the room genuinely has none left, not that something might
 * be slow. Retry is offered because seats come back the moment somebody leaves.
 *
 * Who sees what: a learner is told the room is full and offered a retry. A host
 * gets the same message plus the upgrade path, because they are the only one who
 * can do anything about it. Nobody is shown a price they cannot act on.
 */
export default function RoomFullNotice({ seatLimit, onRetry, onLeave }) {
  const { plan, canManageBilling } = useBilling();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry?.();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="bl bl-full">
      <div className="bl-full__card">
        <h1 className="bl-full__title">This lesson is full</h1>

        <p className="bl-note">
          {seatLimit
            ? `The room is at its limit of ${seatLimit} people.`
            : 'The room is at its seat limit.'}{' '}
          A seat opens as soon as somebody leaves.
        </p>

        <div className="bl-actions" style={{ display: 'flex', gap: 8 }}>
          {onRetry ? (
            <button type="button" className="bl-btn bl-btn--primary" disabled={retrying} onClick={retry}>
              {retrying ? 'Checking…' : 'Try again'}
            </button>
          ) : null}

          {onLeave ? (
            <button type="button" className="bl-btn" onClick={onLeave}>
              Back to the course
            </button>
          ) : null}
        </div>

        {canManageBilling ? (
          <>
            <p className="bl-note">
              {plan?.name ? `The ${plan.name} plan caps room size.` : 'Your plan caps room size.'}{' '}
              A larger plan raises it for every lesson.
            </p>
            <button type="button" className="bl-btn" onClick={() => setUpgradeOpen(true)}>
              See plans
            </button>
          </>
        ) : (
          <p className="bl-note">Your teacher can raise the limit for future lessons.</p>
        )}
      </div>

      {upgradeOpen ? (
        <UpgradePlanModal reason="seats" currentPlanId={plan?.id} onClose={() => setUpgradeOpen(false)} />
      ) : null}
    </div>
  );
}