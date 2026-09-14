import { useEffect, useState } from 'react';
import { billingApi, useBilling } from '@classroom/core-client';
import CurrentPlanBadge from './CurrentPlanBadge.jsx';
import StorageQuotaBar from './StorageQuotaBar.jsx';
import UpgradePlanModal from './UpgradePlanModal.jsx';
import './billing.css';

function money(cents, currency = 'EUR') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** A limit meter for the countable entitlements. Storage has its own component. */
function LimitMeter({ label, used = 0, limit, unit }) {
  if (!limit) {
    return (
      <div className="bl-meter">
        <div className="bl-meter__head">
          <span className="bl-meter__label">{label}</span>
          <span className="bl-meter__value">{used} used · no limit</span>
        </div>
      </div>
    );
  }

  const ratio = Math.min(1, used / limit);
  const level = ratio >= 1 ? 'full' : ratio >= 0.85 ? 'warn' : 'ok';

  return (
    <div className="bl-meter" data-level={level}>
      <div className="bl-meter__head">
        <span className="bl-meter__label">{label}</span>
        <span className="bl-meter__value">
          {used} of {limit} {unit}
        </span>
      </div>
      <div
        className="bl-meter__track"
        role="progressbar"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className="bl-meter__fill" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * Everything about the money in one place: the plan, what is actually being used
 * of it, and the invoices.
 *
 * No card fields exist here or anywhere else in this app — payment details live
 * in the Stripe customer portal, which is a redirect. That keeps the whole
 * frontend out of PCI scope and means a card update never has to round-trip
 * through our API.
 *
 * The usage numbers are the same ones LimitResolver enforces, so what this page
 * shows is what will let the next room, upload or course through.
 */
export default function BillingSettingsPage() {
  const { plan, subscription, limits, usage, loading, error, refresh, canManageBilling } =
    useBilling();

  const [invoices, setInvoices] = useState(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!canManageBilling) return undefined;
    let cancelled = false;
    billingApi
      .listInvoices()
      .then((list) => !cancelled && setInvoices(list))
      .catch(() => !cancelled && setInvoices([]));
    return () => {
      cancelled = true;
    };
  }, [canManageBilling]);

  // Returning from checkout or the portal: the subscription only changes once
  // stripeWebhook.js has processed the event, so re-read rather than assume.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'success' || params.get('portal') === 'return') {
      refresh();
      setNotice('Your plan is being updated. This page refreshes itself once it lands.');
    }
  }, [refresh]);

  const openPortal = async () => {
    setPortalBusy(true);
    try {
      const { url } = await billingApi.createPortalSession({
        returnPath: `${window.location.pathname}?portal=return`,
      });
      window.location.assign(url);
    } catch {
      setNotice('The billing portal could not be opened. Try again in a moment.');
      setPortalBusy(false);
    }
  };

  if (loading && !plan) {
    return <p className="bl bl-page bl-muted">Loading your plan…</p>;
  }

  if (error) {
    return (
      <div className="bl bl-page">
        <p className="bl-alert">
          Billing information could not be loaded. Your lessons are unaffected — this page will work
          again once the connection recovers.
        </p>
      </div>
    );
  }

  if (!canManageBilling) {
    return (
      <div className="bl bl-page">
        <h1 className="bl-full__title">Billing</h1>
        <p className="bl-note">
          Only a workspace owner can see invoices and change the plan. You are on{' '}
          {plan?.name ?? 'a plan'} — ask an owner if you need a higher limit.
        </p>
      </div>
    );
  }

  const status = subscription?.status ?? 'active';

  return (
    <div className="bl bl-page">
      <h1 className="bl-full__title">Billing</h1>

      {status === 'past_due' ? (
        <p className="bl-alert">
          The last payment did not go through. Lessons and uploads keep working for now; update the
          card in the billing portal to avoid an interruption.
        </p>
      ) : null}

      {notice ? <p className="bl-alert bl-alert--info">{notice}</p> : null}

      <section className="bl-card">
        <div className="bl-card__head">
          <p className="bl-card__title">Your plan</p>
          <CurrentPlanBadge onOpenBilling={() => setPlanOpen(true)} />
        </div>

        <div className="bl-card__body">
          <p className="bl-note">
            {subscription?.cancelAtPeriodEnd
              ? `Ends ${dateFmt.format(new Date(subscription.currentPeriodEnd))}. Until then nothing changes.`
              : subscription?.currentPeriodEnd
                ? `Renews ${dateFmt.format(new Date(subscription.currentPeriodEnd))}.`
                : 'No renewal date on file.'}
          </p>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="bl-btn bl-btn--primary" onClick={() => setPlanOpen(true)}>
              Change plan
            </button>
            <button type="button" className="bl-btn" disabled={portalBusy} onClick={openPortal}>
              {portalBusy ? 'Opening…' : 'Payment details and receipts'}
            </button>
          </div>
        </div>
      </section>

      <section className="bl-card">
        <div className="bl-card__head">
          <p className="bl-card__title">What you're using</p>
        </div>

        <div className="bl-card__body">
          <LimitMeter
            label="People in a room"
            used={usage?.peakRoomSeats ?? 0}
            limit={limits?.seatsPerRoom}
            unit="seats at once"
          />

          <LimitMeter
            label="Published courses"
            used={usage?.courses ?? 0}
            limit={limits?.courses}
            unit="courses"
          />

          {/* Storage has its own component because the breakdown by kind is what
              people act on — recordings are almost always the thing to prune. */}
          <StorageQuotaBar showUpgrade={false} />
        </div>
      </section>

      <section className="bl-card">
        <div className="bl-card__head">
          <p className="bl-card__title">Invoices</p>
        </div>

        {invoices === null ? (
          <div className="bl-card__body">
            <p className="bl-muted">Loading…</p>
          </div>
        ) : invoices.length === 0 ? (
          <div className="bl-card__body">
            <p className="bl-note">No invoices yet.</p>
          </div>
        ) : (
          <div className="bl-rows">
            {invoices.map((inv) => (
              <div key={inv.id} className="bl-row">
                <span className="bl-row__main">
                  {dateFmt.format(new Date(inv.createdAt))}
                  <span className="bl-note"> · {inv.status}</span>
                </span>
                <span className="bl-row__amount">{money(inv.amountDue, inv.currency)}</span>
                {inv.pdfUrl ? (
                  <a
                    className="bl-btn bl-btn--ghost"
                    href={inv.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    PDF
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {planOpen ? (
        <UpgradePlanModal currentPlanId={plan?.id} onClose={() => setPlanOpen(false)} />
      ) : null}
    </div>
  );
}