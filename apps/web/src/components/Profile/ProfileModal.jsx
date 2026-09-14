import { useEffect, useId, useRef, useState } from 'react';
import { profileApi, useClassroomUser, useConversations } from '@classroom/core-client';
import AvatarUploader from './AvatarUploader.jsx';
import PrivacySettings from './PrivacySettings.jsx';
import './profile.css';

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

/**
 * The long form of a profile: bio, role, shared courses and spaces, and — on
 * your own — the edit surface.
 *
 * What is visible here is decided by Profile.visibility on the server, so this
 * component renders whatever the API returned and never hides a field it was
 * given. A learner who set their profile to "people I share a course with"
 * simply comes back with fewer fields for a stranger.
 *
 * Editing writes the whole draft in one call, so a half-saved profile is not a
 * state anybody can reach.
 */
export default function ProfileModal({ userId, context = null, onClose }) {
  const me = useClassroomUser();
  const { openOrCreateDirect } = useConversations();

  const dialogRef = useRef(null);
  const titleId = useId();

  const [profile, setProfile] = useState(null);
  const [draft, setDraft] = useState(null);
  const [tab, setTab] = useState('about');
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  const isSelf = userId === me.id;

  useEffect(() => {
    const el = dialogRef.current;
    if (el && !el.open) el.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    profileApi
      .get(userId, { context, full: true })
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setDraft({ displayName: p.displayName, bio: p.bio ?? '', pronounsFree: p.headline ?? '' });
      })
      .catch(() => !cancelled && setStatus({ error: true, text: 'Profile could not be loaded.' }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const updated = await profileApi.update({
        displayName: draft.displayName.trim(),
        bio: draft.bio.trim(),
        headline: draft.pronounsFree.trim(),
      });
      setProfile(updated);
      setStatus({ text: 'Saved.' });
    } catch {
      setStatus({ error: true, text: 'Nothing was saved. Check the fields and try again.' });
    } finally {
      setSaving(false);
    }
  };

  const message = async () => {
    const conversation = await openOrCreateDirect(userId);
    window.dispatchEvent(
      new CustomEvent('chat:open', {
        detail: { type: 'conversation', id: conversation.id, title: profile.displayName },
      }),
    );
    onClose?.();
  };

  return (
    <dialog
      ref={dialogRef}
      className="pf pf-dialog pf-dialog--wide"
      aria-labelledby={titleId}
      onClose={() => onClose?.()}
      onCancel={(e) => {
        e.preventDefault();
        onClose?.();
      }}
    >
      <div className="pf-head">
        <p className="pf-head__title" id={titleId}>
          {isSelf ? 'Your profile' : profile?.displayName ?? 'Profile'}
        </p>

        {isSelf ? (
          <span style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              className={`pf-btn pf-btn--ghost${tab === 'about' ? ' pf-btn--primary' : ''}`}
              onClick={() => setTab('about')}
            >
              About you
            </button>
            <button
              type="button"
              className={`pf-btn pf-btn--ghost${tab === 'privacy' ? ' pf-btn--primary' : ''}`}
              onClick={() => setTab('privacy')}
            >
              Privacy
            </button>
          </span>
        ) : null}

        <button type="button" className="pf-btn pf-btn--ghost" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="pf-body">
        {!profile ? <p className="pf-muted">Loading…</p> : null}

        {profile && tab === 'privacy' ? <PrivacySettings /> : null}

        {profile && tab === 'about' ? (
          <>
            <div className="pf-identity pf-identity--large">
              {isSelf ? (
                <AvatarUploader
                  currentUrl={profile.avatarUrl}
                  onUploaded={(p) => setProfile((prev) => ({ ...prev, avatarUrl: p.avatarUrl }))}
                />
              ) : (
                <img className="pf-avatar pf-avatar--large" src={profile.avatarUrl} alt="" />
              )}

              {isSelf ? null : (
                <div>
                  <p className="pf-name">{profile.displayName}</p>
                  <p className="pf-meta">
                    {profile.role}
                    {profile.joinedAt ? (
                      <>
                        <span aria-hidden="true">·</span>
                        joined {dateFmt.format(new Date(profile.joinedAt))}
                      </>
                    ) : null}
                  </p>
                  {profile.headline ? <p className="pf-muted">{profile.headline}</p> : null}
                </div>
              )}
            </div>

            {isSelf && draft ? (
              <>
                <label className="pf-field">
                  Display name
                  <input
                    value={draft.displayName}
                    maxLength={60}
                    onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                  />
                  <span className="pf-field__hint">
                    This is the name on your tile in a lesson and next to your messages.
                  </span>
                </label>

                <label className="pf-field">
                  Headline
                  <input
                    value={draft.pronounsFree}
                    maxLength={80}
                    placeholder="One line — what you do, or what you're here to learn"
                    onChange={(e) => setDraft({ ...draft, pronounsFree: e.target.value })}
                  />
                </label>

                <label className="pf-field">
                  About you
                  <textarea
                    rows={5}
                    value={draft.bio}
                    maxLength={600}
                    onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
                  />
                  <span className="pf-field__hint">
                    {600 - draft.bio.length} characters left. Anyone who can see your profile can
                    read this.
                  </span>
                </label>
              </>
            ) : (
              <>
                {profile.bio ? <p className="pf-bio">{profile.bio}</p> : (
                  <p className="pf-muted">No bio yet.</p>
                )}

                {profile.stats ? (
                  <dl className="pf-stats">
                    <div className="pf-stat">
                      <dt>Courses</dt>
                      <dd>{profile.stats.courses ?? 0}</dd>
                    </div>
                    <div className="pf-stat">
                      <dt>Lessons attended</dt>
                      <dd>{profile.stats.lessonsAttended ?? 0}</dd>
                    </div>
                    <div className="pf-stat">
                      <dt>Posts</dt>
                      <dd>{profile.stats.posts ?? 0}</dd>
                    </div>
                  </dl>
                ) : null}
              </>
            )}

            {profile.sharedCourses?.length ? (
              <div className="pf-section">
                <p className="pf-section__label">{isSelf ? 'Your courses' : 'Courses you share'}</p>
                <ul className="pf-tags">
                  {profile.sharedCourses.map((c) => (
                    <li key={c.id} className="pf-tag">
                      {c.title}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {profile.sharedSpaces?.length ? (
              <div className="pf-section">
                <p className="pf-section__label">{isSelf ? 'Your spaces' : 'Spaces you share'}</p>
                <ul className="pf-tags">
                  {profile.sharedSpaces.map((s) => (
                    <li key={s.id} className="pf-tag">
                      {s.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}

        {status ? (
          <p className={`pf-status${status.error ? ' pf-status--error' : ' pf-muted'}`}>
            {status.text}
          </p>
        ) : null}
      </div>

      {profile && tab === 'about' ? (
        <div className="pf-foot pf-foot--end">
          <button type="button" className="pf-btn" onClick={onClose}>
            Close
          </button>
          {isSelf ? (
            <button
              type="button"
              className="pf-btn pf-btn--primary"
              disabled={saving || !draft?.displayName.trim()}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          ) : (
            <button
              type="button"
              className="pf-btn pf-btn--primary"
              disabled={!profile.canMessage}
              title={profile.canMessage ? undefined : profile.cannotMessageReason}
              onClick={message}
            >
              Message
            </button>
          )}
        </div>
      ) : null}
    </dialog>
  );
}