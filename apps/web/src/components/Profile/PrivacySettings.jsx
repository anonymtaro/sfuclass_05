import { useEffect, useState } from 'react';
import { profileApi } from '@classroom/core-client';
import './profile.css';

const DM_POLICIES = [
  {
    id: 'anyone',
    title: 'Anyone',
    hint: 'Any member of this workspace can start a conversation with you.',
  },
  {
    id: 'shared',
    title: 'People I share a course or space with',
    hint: 'Classmates, teachers and people in the same community space. Everyone else has to post in a channel.',
  },
  {
    id: 'nobody',
    title: 'Nobody',
    hint: 'No new conversations. Ones you already have keep working.',
  },
];

const VISIBILITY = [
  { id: 'everyone', title: 'Everyone', hint: 'Your bio and courses are on your profile card.' },
  { id: 'shared', title: 'People I share a course or space with', hint: 'Others see only your name and avatar.' },
  { id: 'private', title: 'Only me', hint: 'Your card shows your name and avatar and nothing else.' },
];

/**
 * Who may DM me, who may see me, and who I have blocked.
 *
 * None of this is a UI filter. The DM policy is checked in
 * ConversationService.openOrCreateDirect and the block list is checked on send,
 * so a person whose policy is "nobody" is refused at the API, not hidden behind
 * a greyed-out button. That means the settings here take effect immediately and
 * retroactively — there is no cache to wait out.
 *
 * Saving is per setting rather than one big form, because each one is a single
 * decision and a person changing their DM policy should not have to press Save.
 */
export default function PrivacySettings() {
  const [settings, setSettings] = useState(null);
  const [blocked, setBlocked] = useState([]);
  const [status, setStatus] = useState(null);
  const [pending, setPending] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([profileApi.getPrivacy(), profileApi.listBlocked()])
      .then(([s, b]) => {
        if (cancelled) return;
        setSettings(s);
        setBlocked(b);
      })
      .catch(() => !cancelled && setStatus({ error: true, text: 'Settings could not be loaded.' }));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = async (patch, key) => {
    const previous = settings;
    setSettings({ ...settings, ...patch }); // optimistic; reverted below on failure
    setPending(key);
    setStatus(null);
    try {
      const saved = await profileApi.updatePrivacy(patch);
      setSettings(saved);
      setStatus({ text: 'Saved.' });
    } catch {
      setSettings(previous);
      setStatus({ error: true, text: 'That change was not saved.' });
    } finally {
      setPending(null);
    }
  };

  const unblock = async (user) => {
    setPending(user.id);
    try {
      await profileApi.unblock(user.id);
      setBlocked((list) => list.filter((u) => u.id !== user.id));
      setStatus({ text: `${user.displayName} can message you again.` });
    } catch {
      setStatus({ error: true, text: 'That person could not be unblocked.' });
    } finally {
      setPending(null);
    }
  };

  if (!settings) {
    return (
      <p className="pf pf-muted">
        {status?.error ? status.text : 'Loading your privacy settings…'}
      </p>
    );
  }

  return (
    <div className="pf" style={{ display: 'grid', gap: 18 }}>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        <legend className="pf-section__label" style={{ padding: 0 }}>
          Who can send you a direct message
        </legend>

        {DM_POLICIES.map((p) => (
          <label key={p.id} className="pf-choice" data-selected={settings.dmPolicy === p.id}>
            <input
              type="radio"
              name="dm-policy"
              value={p.id}
              checked={settings.dmPolicy === p.id}
              disabled={pending === 'dmPolicy'}
              onChange={() => update({ dmPolicy: p.id }, 'dmPolicy')}
            />
            <span>
              <span className="pf-choice__title">{p.title}</span>
              <span className="pf-field__hint">{p.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        <legend className="pf-section__label" style={{ padding: 0 }}>
          Who can see your profile
        </legend>

        {VISIBILITY.map((v) => (
          <label key={v.id} className="pf-choice" data-selected={settings.visibility === v.id}>
            <input
              type="radio"
              name="visibility"
              value={v.id}
              checked={settings.visibility === v.id}
              disabled={pending === 'visibility'}
              onChange={() => update({ visibility: v.id }, 'visibility')}
            />
            <span>
              <span className="pf-choice__title">{v.title}</span>
              <span className="pf-field__hint">{v.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="pf-section">
        <p className="pf-section__label">Other</p>

        <label className="pf-switch">
          <input
            type="checkbox"
            checked={settings.showPresence}
            disabled={pending === 'showPresence'}
            onChange={(e) => update({ showPresence: e.target.checked }, 'showPresence')}
          />
          <span>
            <span className="pf-choice__title">Show when I'm online</span>
            <span className="pf-field__hint">
              Turning this off hides the green dot everywhere except a lesson you have joined.
            </span>
          </span>
        </label>

        <label className="pf-switch">
          <input
            type="checkbox"
            checked={settings.readReceipts}
            disabled={pending === 'readReceipts'}
            onChange={(e) => update({ readReceipts: e.target.checked }, 'readReceipts')}
          />
          <span>
            <span className="pf-choice__title">Send read receipts</span>
            <span className="pf-field__hint">
              Off means you also stop seeing whether other people read yours.
            </span>
          </span>
        </label>

        <label className="pf-switch">
          <input
            type="checkbox"
            checked={settings.searchable}
            disabled={pending === 'searchable'}
            onChange={(e) => update({ searchable: e.target.checked }, 'searchable')}
          />
          <span>
            <span className="pf-choice__title">Let people find me by name</span>
            <span className="pf-field__hint">
              Off means you only appear to people already in your courses and spaces.
            </span>
          </span>
        </label>
      </div>

      <div className="pf-section">
        <p className="pf-section__label">Blocked people</p>

        {blocked.length === 0 ? (
          <p className="pf-muted">You haven't blocked anyone.</p>
        ) : (
          <div className="pf-blocked">
            {blocked.map((u) => (
              <div key={u.id} className="pf-blocked__row">
                <img src={u.avatarUrl} alt="" />
                <span className="pf-blocked__name">{u.displayName}</span>
                <button
                  type="button"
                  className="pf-btn pf-btn--ghost"
                  disabled={pending === u.id}
                  onClick={() => unblock(u)}
                >
                  Unblock
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {status ? (
        <p className={`pf-status${status.error ? ' pf-status--error' : ' pf-muted'}`} aria-live="polite">
          {status.text}
        </p>
      ) : null}
    </div>
  );
}