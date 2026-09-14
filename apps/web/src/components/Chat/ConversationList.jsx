import { useMemo, useState } from 'react';
import { useConversations, usePresence } from '@classroom/core-client';
import './chat.css';

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function shortTime(iso) {
  if (!iso) return '';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'now';
  if (secs < 3600) return relative.format(-Math.floor(secs / 60), 'minute');
  if (secs < 86400) return relative.format(-Math.floor(secs / 3600), 'hour');
  return relative.format(-Math.floor(secs / 86400), 'day');
}

/**
 * Channels first, then direct messages, then people you can start a conversation
 * with. A DM and a small group chat are the same object — a Conversation is a
 * participant set — so there is no separate "groups" section to maintain.
 *
 * Unread counts come from UnreadService (Redis counters, fanned out by
 * chatFanoutWorker), never from counting messages on the client. A person who
 * reads on their phone sees the badge clear on their laptop.
 *
 * Starting a conversation is idempotent: openOrCreateDirect() returns the
 * existing one or creates it, which is why "new message" is not its own flow.
 */
export default function ConversationList({ activeId, onSelect }) {
  const { channels, conversations, suggestions, loading, error, openOrCreateDirect, searchPeople } =
    useConversations();
  const { statusOf } = usePresence();

  const [query, setQuery] = useState('');
  const [people, setPeople] = useState([]);
  const [opening, setOpening] = useState(null);

  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    const match = (name) => !q || name.toLowerCase().includes(q);
    return {
      channels: channels.filter((c) => match(c.name)),
      conversations: conversations.filter((c) => match(c.title)),
    };
  }, [channels, conversations, q]);

  const onQueryChange = async (value) => {
    setQuery(value);
    if (value.trim().length < 2) return setPeople([]);
    try {
      setPeople(await searchPeople(value.trim()));
    } catch {
      setPeople([]);
    }
  };

  const startDirect = async (user) => {
    setOpening(user.id);
    try {
      const conversation = await openOrCreateDirect(user.id);
      setQuery('');
      setPeople([]);
      onSelect({ type: 'conversation', id: conversation.id, title: user.displayName });
    } finally {
      setOpening(null);
    }
  };

  if (error) {
    return (
      <p className="ch ch-empty">
        Conversations could not be loaded. Check your connection and try again.
      </p>
    );
  }

  return (
    <div className="ch ch-body">
      <input
        className="ch-list__search"
        type="search"
        value={query}
        placeholder="Search conversations or find someone"
        aria-label="Search conversations or find someone"
        onChange={(e) => onQueryChange(e.target.value)}
      />

      <div className="ch-list">
        {loading ? <p className="ch-empty">Loading…</p> : null}

        {filtered.channels.length ? (
          <>
            <p className="ch-list__group">Channels</p>
            {filtered.channels.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`ch-row${c.unread ? ' ch-row--unread' : ''}`}
                aria-current={activeId === c.id}
                onClick={() => onSelect({ type: 'channel', id: c.id, title: c.name })}
              >
                <span className="ch-row__avatar" aria-hidden="true" style={{ display: 'grid', placeItems: 'center' }}>
                  #
                </span>
                <span className="ch-row__main">
                  <span className="ch-row__name">{c.name}</span>
                  <span className="ch-row__preview">
                    {c.lastMessage
                      ? `${c.lastMessage.authorName}: ${c.lastMessage.preview}`
                      : c.description ?? 'Nothing posted yet'}
                  </span>
                </span>
                <span className="ch-row__time">{shortTime(c.lastMessage?.createdAt)}</span>
                {c.unread ? (
                  <span className={`ch-badge${c.muted ? ' ch-badge--muted' : ''}`}>
                    {c.unread > 99 ? '99+' : c.unread}
                  </span>
                ) : null}
              </button>
            ))}
          </>
        ) : null}

        {filtered.conversations.length ? (
          <>
            <p className="ch-list__group">Direct messages</p>
            {filtered.conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`ch-row${c.unread ? ' ch-row--unread' : ''}`}
                aria-current={activeId === c.id}
                onClick={() => onSelect({ type: 'conversation', id: c.id, title: c.title })}
              >
                <img className="ch-row__avatar" src={c.avatarUrl} alt="" loading="lazy" />
                <span className="ch-row__main">
                  <span className="ch-row__name">
                    {c.participantUserId ? (
                      <span
                        className="ch-presence"
                        data-presence={statusOf(c.participantUserId)}
                        aria-hidden="true"
                      />
                    ) : null}{' '}
                    {c.title}
                  </span>
                  <span className="ch-row__preview">
                    {c.lastMessage?.preview ?? 'Say hello'}
                  </span>
                </span>
                <span className="ch-row__time">{shortTime(c.lastMessage?.createdAt)}</span>
                {c.unread ? (
                  <span className={`ch-badge${c.muted ? ' ch-badge--muted' : ''}`}>
                    {c.unread > 99 ? '99+' : c.unread}
                  </span>
                ) : null}
              </button>
            ))}
          </>
        ) : null}

        {people.length ? (
          <>
            <p className="ch-list__group">Start a conversation</p>
            {people.map((u) => (
              <button
                key={u.id}
                type="button"
                className="ch-row"
                disabled={opening === u.id || u.dmPolicy === 'nobody'}
                onClick={() => startDirect(u)}
              >
                <img className="ch-row__avatar" src={u.avatarUrl} alt="" loading="lazy" />
                <span className="ch-row__main">
                  <span className="ch-row__name">{u.displayName}</span>
                  <span className="ch-row__preview">
                    {u.dmPolicy === 'nobody'
                      ? 'Not accepting messages'
                      : u.sharedContext ?? u.role}
                  </span>
                </span>
              </button>
            ))}
          </>
        ) : null}

        {!loading &&
        !filtered.channels.length &&
        !filtered.conversations.length &&
        !people.length ? (
          <p className="ch-empty">
            {q
              ? `Nothing matches “${query}”.`
              : 'No conversations yet. Search for someone to start one.'}
          </p>
        ) : null}

        {suggestions?.length && !q ? (
          <>
            <p className="ch-list__group">People from your courses</p>
            {suggestions.map((u) => (
              <button
                key={u.id}
                type="button"
                className="ch-row"
                disabled={opening === u.id}
                onClick={() => startDirect(u)}
              >
                <img className="ch-row__avatar" src={u.avatarUrl} alt="" loading="lazy" />
                <span className="ch-row__main">
                  <span className="ch-row__name">{u.displayName}</span>
                  <span className="ch-row__preview">{u.sharedContext}</span>
                </span>
              </button>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}