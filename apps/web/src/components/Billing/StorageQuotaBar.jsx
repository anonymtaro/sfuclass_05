import { useMemo, useState } from 'react';
import { useBilling } from '@classroom/core-client';
import UpgradePlanModal from './UpgradePlanModal.jsx';
import './billing.css';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function humanSize(bytes = 0) {
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${UNITS[i]}`;
}

const SEGMENTS = [
  { key: 'recordings', label: 'Lesson recordings', cls: 'bl-meter__fill--recordings' },
  { key: 'courseMedia', label: 'Course media', cls: 'bl-meter__fill' },
  { key: 'attachments', label: 'Chat and assignment files', cls: 'bl-meter__fill--attachments' },
  { key: 'other', label: 'Everything else', cls: 'bl-meter__fill--other' },
];

/**
 * What the tenant has used of the storage the plan includes.
 *
 * The numbers come from the same counter StorageGuard reads before it signs an
 * upload URL, so what this bar shows is exactly what will let an upload through
 * or refuse it — not a second, friendlier estimate. `recomputeStorageUsage.js`
 * repairs drift nightly; the "storage quota drift" alarm exists because these
 * two can disagree.
 *
 * Placement: the full variant belongs on the billing page and in the media
 * library; the compact one sits above an uploader, where the number is about to
 * matter. Pass `showUpgrade={false}` where an upgrade prompt would be noise.
 */
export default function StorageQuotaBar({
  variant = 'full',
  showUpgrade = true,
  className = '',
}) {
  const { usage, limits, plan, loading, canManageBilling } = useBilling();
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const quota = limits?.storageBytes ?? 0;
  const used = usage?.storageBytes ?? 0;

  const { pct, level, segments } = useMemo(() => {
    const ratio = quota > 0 ? Math.min(1, used / quota) : 0;
    const breakdown = SEGMENTS.map((s) => ({
      ...s,
      bytes: usage?.storageByKind?.[s.key] ?? 0,
      width: quota > 0 ? ((usage?.storageByKind?.[s.key] ?? 0) / quota) * 100 : 0,
    })).filter((s) => s.bytes > 0);

    return {
      pct: Math.round(ratio * 100),
      level: ratio >= 1 ? 'full' : ratio >= 0.85 ? 'warn' : 'ok',
      segments: breakdown,
    };
  }, [usage, quota]);

  if (loading && !usage) {
    return <p className={`bl bl-note ${className}`}>Checking storage…</p>;
  }

  if (!quota) {
    return variant === 'compact' ? null : (
      <p className={`bl bl-note ${className}`}>This plan has no storage limit.</p>
    );
  }

  const compact = variant === 'compact';

  return (
    <div className={`bl ${className}`}>
      <div
        className={`bl-meter${compact ? ' bl-meter--compact' : ''}`}
        data-level={level}
        role="group"
        aria-label="Storage used"
      >
        <div className="bl-meter__head">
          <span className="bl-meter__label">{compact ? 'Storage' : 'Storage used'}</span>
          <span className="bl-meter__value">
            {humanSize(used)} of {humanSize(quota)} · {pct}%
          </span>
        </div>

        <div
          className="bl-meter__track"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${humanSize(used)} of ${humanSize(quota)}`}
        >
          {segments.length ? (
            segments.map((s) => (
              <div
                key={s.key}
                className={s.cls}
                style={{ width: `${s.width}%` }}
                title={`${s.label}: ${humanSize(s.bytes)}`}
              />
            ))
          ) : (
            <div className="bl-meter__fill" style={{ width: `${pct}%` }} />
          )}
        </div>

        {!compact && segments.length ? (
          <ul className="bl-legend">
            {segments.map((s) => (
              <li key={s.key}>
                <i className={s.cls} style={{ display: 'inline-block' }} aria-hidden="true" />
                {s.label} — {humanSize(s.bytes)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {level === 'full' ? (
        <p className="bl-note bl-note--danger">
          Storage is full. New uploads are refused until you free space or move to a larger plan.
        </p>
      ) : level === 'warn' ? (
        <p className="bl-note bl-note--warn">
          {humanSize(quota - used)} left. Old recordings are the usual place to reclaim space.
        </p>
      ) : null}

      {showUpgrade && level !== 'ok' && canManageBilling ? (
        <button
          type="button"
          className="bl-btn bl-btn--primary"
          style={{ marginTop: 8 }}
          onClick={() => setUpgradeOpen(true)}
        >
          Get more storage
        </button>
      ) : null}

      {showUpgrade && level !== 'ok' && !canManageBilling ? (
        <p className="bl-note">Ask an owner to change the plan.</p>
      ) : null}

      {upgradeOpen ? (
        <UpgradePlanModal
          reason="storage"
          currentPlanId={plan?.id}
          onClose={() => setUpgradeOpen(false)}
        />
      ) : null}
    </div>
  );
}