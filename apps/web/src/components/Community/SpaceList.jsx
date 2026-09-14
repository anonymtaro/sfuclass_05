import { useMemo, useState } from 'react';
import { useCommunity } from '@classroom/core-client';
import PresenceAvatars from './PresenceAvatars.jsx';
import './community.css';

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function shortTime(iso) {
  if (!iso) return '';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'now';
  if (secs < 3600) return relative.format(-Math.floor(secs / 60), 'minute');
  if (secs < 86_400) return relative.format(-Math.floor(secs / 3600), 'hour');
  return relative.format(-Math.floor(secs / 86_400), 'day');
}

/**
 * Spaces, split by where they came from.
 *
 * A course-bound space is provisioned automatically when a course is published
 * (SpaceService.js), so people do not create or name it — it appears, and
 * leaving it is not offered, because leaving the space of a course you are
 * enrolled in would just take the discussion away from you. Standalone spaces
 * are the ones anyone can join or leave.
 *
 * Unread counts come from the same fan-out as chat badges, so a space read on
 * the phone stops being bold on the laptop.
 */
export default function SpaceList({ activeSpaceId, onSelect }) {
  const { spaces, loading, error, joinSpace, leaveSpace, muteSpace, canCreateSpace, createSpace } =
    useCommunity();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = (spaces ?? []).filter((s) => !q || s.name.toLowerCase().includes(q));
    return [
      { key: 'course', label: 'From your courses', items: visible.filter((s) => s.courseId) },
      { key: 'open', label: 'Spaces', items: visible.filter((s) => !s.courseId && s.joined) },
      { key: 'discover', label: 'You could join', items: visible.filter((s) => !s.courseId && !s.joined) },
    ].filter((g) => g.items.length);
  }, [spaces, query]);

  const act = async (id, fn) => {
    setBusy(id);
    try {
      await fn(id);
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return <p className="cm cm-empty">Spaces could not be loaded. Try again in a moment.</p>;
  }

  return (
    <nav className="cm cm-spaces" aria-label="Spaces">
      <header className="cm-spaces__head">
        <p className="cm-spaces__title">Community</p>
        {canCreateSpace ? (
          <button
            type="button"
            className="cm-btn cm-btn--ghost"
            onClick={async () => {
              const name = window.prompt('Name for the new space');
              if (name?.trim()) {
                const space = await createSpace({ name: name.trim() });
                onSelect?.(space.id);
              }
            }}
          >
            New
          </button>
        ) : null}
      </header>

      <input
        className="cm-composer__input"
        style={{ minHeight: 0, margin: '10px 12px', width: 'calc(100% - 24px)' }}
        type="search"
        value={query}
        placeholder="Find a space"
        aria-label="Find a space"
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="cm-spaces__body">
        {loading && !spaces?.length ? <p className="cm-empty">Loading…</p> : null}

        {groups.map((group) => (
          <div key={group.key}>
            <p className="cm-spaces__group">{group.label}</p>

            {group.items.map((space) => (
              <div key={space.id} style={{ position: 'relative' }}>
                <button
                  type="button"
                  className={`cm-space${space.unread ? ' cm-space--unread' : ''}`}
                  aria-current={space.id === activeSpaceId}
                  onClick={() => (space.joined ? onSelect?.(space.id) : act(space.id, joinSpace))}
                >
                  <span className="cm-space__mark" aria-hidden="true">
                    {space.courseId ? '🎓' : '#'}
                  </span>

                  <span className="cm-space__main">
                    <span className="cm-space__name">{space.name}</span>
                    <span className="cm-space__meta">
                      {space.joined
                        ? space.lastActivityAt
                          ? `${space.threadCount ?? 0} threads · active ${shortTime(space.lastActivityAt)}`
                          : 'Nothing posted yet'
                        : `${space.memberCount ?? 0} members`}
                    </span>
                  </span>

                  {space.joined && space.unread ? (
                    <span className={`cm-badge${space.muted ? ' cm-badge--muted' : ''}`}>
                      {space.unread > 99 ? '99+' : space.unread}
                    </span>
                  ) : null}

                  {!space.joined ? (
                    <span className="cm-btn cm-btn--ghost" aria-hidden="true">
                      {busy === space.id ? '…' : 'Join'}
                    </span>
                  ) : null}
                </button>

                {space.id === activeSpaceId && space.joined ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '0 12px 10px 50px',
                    }}
                  >
                    <PresenceAvatars people={space.onlineMembers ?? []} max={5} showLabel={false} />

                    <span className="cm-composer__spacer" />

                    <button
                      type="button"
                      className="cm-btn cm-btn--ghost"
                      disabled={busy === space.id}
                      onClick={() => act(space.id, () => muteSpace(space.id, !space.muted))}
                    >
                      {space.muted ? 'Unmute' : 'Mute'}
                    </button>

                    {/* A course space is part of being enrolled, so it is muted,
                        never left. */}
                    {space.courseId ? null : (
                      <button
                        type="button"
                        className="cm-btn cm-btn--ghost"
                        disabled={busy === space.id}
                        onClick={() => act(space.id, leaveSpace)}
                      >
                        Leave
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ))}

        {!loading && groups.length === 0 ? (
          <p className="cm-empty">
            {query ? `Nothing matches “${query}”.` : 'No spaces yet. Publishing a course creates one.'}
          </p>
        ) : null}
      </div>
    </nav>
  );
}