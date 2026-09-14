import { useEffect, useRef, useState } from 'react';
import { useNotifications } from '@classroom/core-client';
import './community.css';

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function ago(iso) {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return relative.format(-Math.floor(secs / 60), 'minute');
  if (secs < 86_400) return relative.format(-Math.floor(secs / 3600), 'hour');
  return relative.format(-Math.floor(secs / 86_400), 'day');
}

/**
 * The in-app half of NotificationService.
 *
 * Every notification exists in three places at once — in-app, push and, for
 * anyone who batches them, the daily digest — and they are the same record, so
 * reading one here is what stops the other two from arriving. That is why
 * marking read is a server call and not a local flag.
 *
 * Chat gets its own badge on the dock; this bell is for the community and course
 * events: replies, mentions, a lesson about to start, an assignment graded.
 */
export default function NotificationBell({ onNavigate }) {
  const { items, unread, hasMore, loading, loadMore, markRead, markAllRead, refresh } =
    useNotifications();

  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    refresh();
    const onDocClick = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, refresh]);

  const activate = (n) => {
    if (!n.readAt) markRead(n.id);
    setOpen(false);
    // The route lives with the notification, so a new notification type does not
    // need a new branch here.
    if (n.href) onNavigate?.(n.href, n);
  };

  return (
    <div className="cm cm-bell" ref={wrapRef}>
      <button
        type="button"
        className="cm-bell__button"
        aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 ? (
          <span className="cm-badge cm-bell__count">{unread > 99 ? '99+' : unread}</span>
        ) : null}
      </button>

      {open ? (
        <div className="cm-bell__panel" role="dialog" aria-label="Notifications">
          <header className="cm-bell__head">
            <strong style={{ flex: '1 1 auto' }}>Notifications</strong>
            {unread > 0 ? (
              <button type="button" className="cm-btn cm-btn--ghost" onClick={markAllRead}>
                Mark all read
              </button>
            ) : null}
          </header>

          <div className="cm-bell__list">
            {loading && items.length === 0 ? <p className="cm-empty">Loading…</p> : null}

            {!loading && items.length === 0 ? (
              <p className="cm-empty">Nothing yet. Replies and mentions land here.</p>
            ) : null}

            {items.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`cm-notif${n.readAt ? '' : ' cm-notif--unread'}`}
                onClick={() => activate(n)}
              >
                {n.actor ? (
                  <img className="cm-notif__avatar" src={n.actor.avatarUrl} alt="" loading="lazy" />
                ) : (
                  <span className="cm-notif__avatar" aria-hidden="true" />
                )}

                <span className="cm-notif__text">
                  {n.actor ? <strong>{n.actor.displayName}</strong> : null} {n.text}
                  {n.excerpt ? <span className="cm-notif__time">{n.excerpt}</span> : null}
                  <span className="cm-notif__time">{ago(n.createdAt)}</span>
                </span>
              </button>
            ))}

            {hasMore ? (
              <button
                type="button"
                className="cm-btn cm-btn--ghost"
                style={{ width: '100%' }}
                disabled={loading}
                onClick={loadMore}
              >
                {loading ? 'Loading…' : 'Older'}
              </button>
            ) : null}
          </div>

          <footer className="cm-bell__foot">
            <p className="cm-note">
              Quiet hours, email and the daily digest are in notification settings.
            </p>
          </footer>
        </div>
      ) : null}
    </div>
  );
}