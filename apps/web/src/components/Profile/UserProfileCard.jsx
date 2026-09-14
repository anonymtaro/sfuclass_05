import { useEffect, useId, useRef, useState } from 'react';
import {
  profileApi,
  useClassroomUser,
  useConversations,
  usePresence,
} from '@classroom/core-client';
import ReportBlockMenu from '../Chat/ReportBlockMenu.jsx';
import ProfileModal from './ProfileModal.jsx';
import './profile.css';

/**
 * The anchor of F6. Clicking a person anywhere — participant list, community
 * thread, public channel, course roster — opens this card, and the card carries
 * the Message action.
 *
 * That action is one idempotent call: openOrCreateDirect(a, b) returns the
 * existing conversation or creates it. The card then dispatches `chat:open`,
 * which ChatDock (mounted once in the app shell) listens for. So the same card
 * works on every page without knowing anything about routing, and there is no
 * separate "new message" flow to keep in sync.
 *
 * Whether the viewer may write is decided by the server from the target's DM
 * policy and the block list; `canMessage` arrives with the profile. This card
 * never infers it.
 */
export default function UserProfileCard({ userId, context = null, onClose, actions = [] }) {
  const me = useClassroomUser();
  const { openOrCreateDirect } = useConversations();
  const { statusOf } = usePresence();

  const dialogRef = useRef(null);
  const titleId = useId();

  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [opening, setOpening] = useState(false);
  const [full, setFull] = useState(false);
  const [running, setRunning] = useState(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (el && !el.open) el.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setError(null);

    profileApi
      .get(userId, { context })
      .then((p) => !cancelled && setProfile(p))
      .catch(() => !cancelled && setError('This profile could not be loaded.'));

    return () => {
      cancelled = true;
    };
    // `context` is a fresh object each render at the call site; the id is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const isSelf = userId === me.id;

  const message = async () => {
    setOpening(true);
    try {
      const conversation = await openOrCreateDirect(userId);
      window.dispatchEvent(
        new CustomEvent('chat:open', {
          detail: {
            type: 'conversation',
            id: conversation.id,
            title: profile.displayName,
          },
        }),
      );
      onClose?.();
    } catch {
      setError('The conversation could not be opened. Try again in a moment.');
    } finally {
      setOpening(false);
    }
  };

  const runAction = async (action) => {
    if (action.confirm && !window.confirm(action.confirm)) return;
    setRunning(action.id);
    try {
      await action.run(userId);
      onClose?.();
    } finally {
      setRunning(null);
    }
  };

  const presence = profile ? statusOf(userId) : 'offline';

  return (
    <>
      <dialog
        ref={dialogRef}
        className="pf pf-dialog"
        aria-labelledby={titleId}
        onClose={() => onClose?.()}
        onCancel={(e) => {
          e.preventDefault();
          onClose?.();
        }}
      >
        <div className="pf-head">
          <p className="pf-head__title" id={titleId}>
            {profile?.displayName ?? 'Profile'}
          </p>
          {profile && !isSelf ? <ReportBlockMenu targetUser={profile} compact /> : null}
          <button type="button" className="pf-btn pf-btn--ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="pf-body">
          {error ? <p className="pf-status pf-status--error">{error}</p> : null}

          {!profile && !error ? <p className="pf-muted">Loading…</p> : null}

          {profile ? (
            <>
              <div className="pf-identity">
                <img className="pf-avatar" src={profile.avatarUrl} alt="" />
                <div>
                  <p className="pf-name">{profile.displayName}</p>
                  <p className="pf-meta">
                    <span className="pf-presence" data-presence={presence} aria-hidden="true" />
                    {presence === 'in-class' ? 'In a lesson' : presence}
                    <span aria-hidden="true">·</span>
                    {profile.role}
                    {profile.timezone ? (
                      <>
                        <span aria-hidden="true">·</span>
                        {profile.localTime}
                      </>
                    ) : null}
                  </p>
                </div>
              </div>

              {profile.bio ? <p className="pf-bio">{profile.bio}</p> : null}

              {profile.sharedCourses?.length ? (
                <div className="pf-section">
                  <p className="pf-section__label">You're both in</p>
                  <ul className="pf-tags">
                    {profile.sharedCourses.slice(0, 4).map((c) => (
                      <li key={c.id} className="pf-tag">
                        {c.title}
                      </li>
                    ))}
                    {profile.sharedCourses.length > 4 ? (
                      <li className="pf-tag pf-muted">
                        +{profile.sharedCourses.length - 4} more
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}

              {actions.length ? (
                <div className="pf-section">
                  <p className="pf-section__label">Host actions</p>
                  <div className="pf-uploader__actions">
                    {actions.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className={`pf-btn${a.tone === 'danger' ? ' pf-btn--danger' : ''}`}
                        disabled={running === a.id}
                        onClick={() => runAction(a)}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        {profile ? (
          <div className="pf-foot">
            {isSelf ? (
              <button type="button" className="pf-btn" onClick={() => setFull(true)}>
                Edit your profile
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="pf-btn pf-btn--primary"
                  style={{ flex: '1 1 auto' }}
                  disabled={opening || !profile.canMessage}
                  onClick={message}
                  title={profile.canMessage ? undefined : profile.cannotMessageReason}
                >
                  {opening ? 'Opening…' : 'Message'}
                </button>
                <button type="button" className="pf-btn" onClick={() => setFull(true)}>
                  Full profile
                </button>
              </>
            )}
          </div>
        ) : null}

        {profile && !profile.canMessage && !isSelf ? (
          <p className="pf-status pf-muted" style={{ padding: '0 16px 12px' }}>
            {profile.cannotMessageReason ?? 'This person is not accepting direct messages.'}
          </p>
        ) : null}
      </dialog>

      {full ? (
        <ProfileModal userId={userId} context={context} onClose={() => setFull(false)} />
      ) : null}
    </>
  );
}