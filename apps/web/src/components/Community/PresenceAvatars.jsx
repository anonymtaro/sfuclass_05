import { useState } from 'react';
import { usePresence } from '@classroom/core-client';
import UserProfileCard from '../Profile/UserProfileCard.jsx';
import './community.css';

const ORDER = { 'in-class': 0, online: 1, away: 2, offline: 3 };

/**
 * Who is around, wherever "around" is: a space, a thread, a course roster.
 *
 * Presence is one Redis source of truth shared by the community, chat and the
 * classroom (PresenceService.js), so a person in a live lesson shows as
 * in-class here rather than as plainly online — the same state the chat dock
 * reads. Nothing in this component polls; presenceGateway pushes.
 *
 * Clicking a face opens the profile card, which means this is another entry
 * point into a direct message without knowing anything about messaging.
 */
export default function PresenceAvatars({
  people = [],
  max = 6,
  showLabel = true,
  context = null,
  className = '',
}) {
  const { statusOf } = usePresence();
  const [openUserId, setOpenUserId] = useState(null);

  const ranked = people
    .map((p) => ({ ...p, presence: statusOf(p.id) }))
    .filter((p) => p.presence !== 'offline')
    .sort(
      (a, b) => (ORDER[a.presence] ?? 3) - (ORDER[b.presence] ?? 3) ||
        a.displayName.localeCompare(b.displayName),
    );

  if (ranked.length === 0) {
    return showLabel ? <span className={`cm cm-note ${className}`}>Nobody here right now</span> : null;
  }

  const shown = ranked.slice(0, max);
  const extra = ranked.length - shown.length;

  return (
    <span className={`cm cm-presence ${className}`}>
      {shown.map((p) => (
        <button
          key={p.id}
          type="button"
          className="cm-presence__person"
          title={`${p.displayName} — ${p.presence === 'in-class' ? 'in a lesson' : p.presence}`}
          aria-label={`${p.displayName}, ${p.presence}`}
          onClick={() => setOpenUserId(p.id)}
        >
          <img src={p.avatarUrl} alt="" loading="lazy" />
          <span className="cm-presence__dot" data-presence={p.presence} aria-hidden="true" />
        </button>
      ))}

      {extra > 0 ? (
        <span className="cm-presence__more" title={ranked.slice(max).map((p) => p.displayName).join(', ')}>
          +{extra}
        </span>
      ) : null}

      {showLabel ? (
        <span className="cm-presence__label">
          {ranked.length} online
          {ranked.some((p) => p.presence === 'in-class')
            ? `, ${ranked.filter((p) => p.presence === 'in-class').length} in a lesson`
            : ''}
        </span>
      ) : null}

      {openUserId ? (
        <UserProfileCard userId={openUserId} context={context} onClose={() => setOpenUserId(null)} />
      ) : null}
    </span>
  );
}