import { useEffect, useMemo, useRef, useState } from 'react';
import { billingApi, useBilling } from '@classroom/core-client';
import './billing.css';

const UNITS = ['GB', 'TB'];

function planStorage(gb) {
  return gb >= 1024 ? `${(gb / 1024).toFixed(gb % 1024 ? 1 : 0)} ${UNITS[1]}` : `${gb} ${UNITS[0]}`;
}

function money(cents, currency = 'EUR') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 })
    .format(cents / 100);
}

/**
 * The upgrade path. Opened from three places, and each one says why:
 *
 *   reason="seats"    a room hit the seat limit (RoomFullNotice)
 *   reason="storage"  an upload would exceed the quota (StorageQuotaBar)
 *   reason="courses"  the course limit is reached (CourseBuilder)
 *   reason=null       the person came here deliberately
 *
 * The limit that was hit is put first in each plan's feature list, because
 * someone who arrived from a blocked upload is looking for one number.
 *
 * Checkout is a redirect to Stripe — no card fields ever exist in this app, so
 * nothing here is in PCI scope. The session comes back from the API and the
 * subscription only changes when stripeWebhook.js processes the event, which is
 * why returning from checkout refreshes rather than assumes.
 */
export default function UpgradePlanModal({ reason = null, currentPlanId, onClose }) {
  const { plan: activePlan, subscription, refresh } = useBilling();
  const dialogRef = useRef(null);

  const [plans, setPlans] = useState([]);
  const [cycle, setCycle] = useState('monthly');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (el && !el.open) el.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    billingApi
      .listPlans()
      .then((list) => !cancelled && setPlans(list))
      .catch(() => !cancelled && setError('Plans could not be loaded. Try again in a moment.'));
    return () => {
      cancelled = true;
    };
  }, []);

  // Coming back from Stripe: the webhook may land a second after the redirect,
  // so refresh rather than trusting the query string.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('checkout') === 'success') refresh();
  }, [refresh]);

  const headline = {
    seats: 'This room is at its seat limit',
    storage: 'You are out of storage',
    courses: 'You have reached the course limit',
  }[reason];

  const ordered = useMemo(
    () => [...plans].sort((a, b) => (a.prices?.[cycle]?.amount ?? 0) - (b.prices?.[cycle]?.amount ?? 0)),
    [plans, cycle],
  );

  const checkout = async (planItem) => {
    setBusy(planItem.id);
    setError(null);
    try {
      const { url } = await billingApi.createCheckoutSession({
        priceId: planItem.prices[cycle].id,
        returnPath: `${window.location.pathname}?checkout=success`,
      });
      window.location.assign(url);
    } catch {
      setError('Checkout could not be started. Try again in a moment.');
      setBusy(null);
    }
  };

  const featureList = (p) => {
    const items = [
      { key: 'seats', text: `${p.seatLimit} people in a room` },
      { key: 'storage', text: `${planStorage(p.storageQuotaGb)} of storage` },
      { key: 'courses', text: p.courseLimit ? `${p.courseLimit} courses` : 'Unlimited courses' },
      { key: 'recording', text: p.recording ? 'Lesson recording' : 'No recording' },
    ];
    if (!reason) return items;
    return [...items.filter((i) => i.key === reason), ...items.filter((i) => i.key !== reason)];
  };

  return (
    <dialog
      ref={dialogRef}
      className="bl bl-dialog"
      aria-label="Change plan"
      onClose={() => onClose?.()}
      onCancel={(e) => {
        e.preventDefault();
        onClose?.();
      }}
    >
      <div className="bl-card__head">
        <p className="bl-card__title">{headline ?? 'Plans'}</p>

        <span className="bl-cycle" role="group" aria-label="Billing cycle">
          <button type="button" aria-pressed={cycle === 'monthly'} onClick={() => setCycle('monthly')}>
            Monthly
          </button>
          <button type="button" aria-pressed={cycle === 'yearly'} onClick={() => setCycle('yearly')}>
            Yearly
          </button>
        </span>

        <button type="button" className="bl-btn bl-btn--ghost" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="bl-card__body">
        {headline ? (
          <p className="bl-note">
            {reason === 'seats'
              ? 'Nobody was removed — the room simply cannot admit more people on this plan.'
              : reason === 'storage'
                ? 'Existing files are untouched. Only new uploads are refused.'
                : 'Your published courses keep working.'}
          </p>
        ) : null}

        {error ? <p className="bl-alert">{error}</p> : null}

        {!plans.length && !error ? <p className="bl-muted">Loading plans…</p> : null}

        <div className="bl-plans">
          {ordered.map((p) => {
            const isCurrent = p.id === (currentPlanId ?? activePlan?.id);
            const price = p.prices?.[cycle];
            return (
              <div key={p.id} className="bl-plan" data-current={isCurrent}>
                <p className="bl-plan__name">{p.name}</p>
                <p className="bl-plan__price">
                  {price ? money(price.amount, price.currency) : '—'}
                  <span> / {cycle === 'monthly' ? 'month' : 'year'}</span>
                </p>

                <ul className="bl-plan__features">
                  {featureList(p).map((f) => (
                    <li key={f.key}>{f.text}</li>
                  ))}
                </ul>

                <button
                  type="button"
                  className={`bl-btn${isCurrent ? '' : ' bl-btn--primary'}`}
                  disabled={isCurrent || busy === p.id || !price}
                  onClick={() => checkout(p)}
                >
                  {isCurrent ? 'Your plan' : busy === p.id ? 'Opening checkout…' : `Move to ${p.name}`}
                </button>
              </div>
            );
          })}
        </div>

        {subscription?.cancelAtPeriodEnd ? (
          <p className="bl-note bl-note--warn">
            Your subscription is set to end on{' '}
            {new Date(subscription.currentPeriodEnd).toLocaleDateString()}. Changing plan keeps it
            running.
          </p>
        ) : null}
      </div>

      <div className="bl-dialog__foot">
        <button type="button" className="bl-btn" onClick={onClose}>
          Not now
        </button>
      </div>
    </dialog>
  );
}