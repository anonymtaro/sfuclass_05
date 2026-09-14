import { useState } from 'react';
import { useChat, useClassroomUser } from '@classroom/core-client';
import MessageThread from './MessageThread.jsx';
import MessageComposer from './MessageComposer.jsx';
import TypingIndicator from './TypingIndicator.jsx';
import './chat.css';

function slowModeNotice(seconds, waitLeft) {
  if (waitLeft > 0) return `Slow mode — you can post again in ${waitLeft}s.`;
  return `Slow mode — one message every ${seconds}s.`;
}

/**
 * The open channel. Same message table as a DM, scoped to a channel instead of a
 * participant set, which is why it reuses MessageThread and MessageComposer
 * unchanged.
 *
 * What a public room needs and a DM does not, all of it enforced server-side and
 * only *displayed* here: a per-user rate limit, slow mode, mutes, and a retention
 * window that pruneChatRetention.js actually applies. Full history is readable by
 * any member, so someone who joins today can scroll back to before they arrived.
 */
export default function PublicChannelView({ channelId, onOpenProfile }) {
  const me = useClassroomUser();
  const chat = useChat({ scope: 'channel', channelId });
  const [search, setSearch] = useState('');

  const { channel, typingUsers, send, sendTyping, restriction } = chat;

  const canModerate = channel?.myRole === 'moderator' || channel?.myRole === 'owner';
  const muted = restriction?.type === 'muted';
  const slow = restriction?.type === 'slow';

  const disabledReason = muted
    ? `You are muted in this channel${restriction.until ? ` until ${new Date(restriction.until).toLocaleTimeString()}` : ''}.`
    : slow && restriction.waitLeft > 0
      ? slowModeNotice(restriction.seconds, restriction.waitLeft)
      : '';

  return (
    <div className="ch ch-body">
      <header className="ch-head">
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <p className="ch-head__title">
            # {channel?.name ?? 'Channel'}
            <span className="ch-head__sub">
              {channel?.memberCount ? `${channel.memberCount} members` : ''}
              {channel?.retentionDays ? ` · messages kept ${channel.retentionDays} days` : ''}
            </span>
          </p>
        </div>

        <input
          className="ch-list__search"
          style={{ width: 160, margin: 0 }}
          type="search"
          value={search}
          placeholder="Search this channel"
          aria-label="Search this channel"
          onChange={(e) => setSearch(e.target.value)}
        />

        {canModerate ? (
          <button
            type="button"
            className="ch-btn ch-btn--ghost"
            onClick={() => chat.setSlowMode(channel.slowModeSeconds ? 0 : 10)}
          >
            {channel?.slowModeSeconds ? 'Turn off slow mode' : 'Slow mode'}
          </button>
        ) : null}
      </header>

      {slow && restriction.waitLeft === 0 ? (
        <p className="ch-notice">{slowModeNotice(restriction.seconds, 0)}</p>
      ) : null}

      {muted ? <p className="ch-notice ch-notice--warn">{disabledReason}</p> : null}

      {/* Searching filters the loaded window and highlights hits; the full search
          across history is served by ChatSearchService from OpenSearch. */}
      <MessageThread
        chat={search.trim() ? { ...chat, messages: chat.search(search) } : chat}
        me={me}
        canModerate={canModerate}
        highlight={search}
        emptyText="This channel is empty. Be the first to post."
        onOpenProfile={onOpenProfile}
      />

      <TypingIndicator users={typingUsers} />

      <div className="ch-foot">
        <MessageComposer
          scope={{ type: 'channel', id: channelId }}
          placeholder={`Message #${channel?.name ?? ''}`}
          onSend={send}
          onTyping={sendTyping}
          allowAttachments={channel?.allowAttachments !== false}
          disabled={muted || (slow && restriction.waitLeft > 0)}
          disabledReason={disabledReason}
          maxLength={channel?.maxMessageLength ?? 4000}
        />
      </div>
    </div>
  );
}