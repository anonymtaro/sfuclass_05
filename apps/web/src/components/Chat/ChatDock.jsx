import { useEffect, useState } from 'react';
import {
  useChat,
  useClassroomUser,
  useConversations,
  useSocketStatus,
} from '@classroom/core-client';
import ConversationList from './ConversationList.jsx';
import PublicChannelView from './PublicChannelView.jsx';
import MessageThread from './MessageThread.jsx';
import MessageComposer from './MessageComposer.jsx';
import TypingIndicator from './TypingIndicator.jsx';
import ReportBlockMenu from './ReportBlockMenu.jsx';
import './chat.css';

/**
 * The dock is mounted once, in the app shell, and is the reason a "Message"
 * button on a profile card can work from any page: it listens for the
 * `chat:open` event that UserProfileCard dispatches after
 * ConversationService.openOrCreateDirect() resolves, and opens that conversation.
 *
 * Hidden inside a live lesson — LiveChatPanel is the same store in a layout that
 * fits the classroom, and two floating chats on one screen is one too many.
 */
export default function ChatDock({ hidden = false }) {
  const { unreadTotal } = useConversations();
  const status = useSocketStatus();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(null); // { type, id, title }

  // Opened from anywhere: window.dispatchEvent(new CustomEvent('chat:open', {...}))
  useEffect(() => {
    const onOpen = (e) => {
      setTarget(e.detail);
      setOpen(true);
    };
    window.addEventListener('chat:open', onOpen);
    return () => window.removeEventListener('chat:open', onOpen);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (target) setTarget(null);
      else setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, target]);

  if (hidden) return null;

  return (
    <div className="ch ch-dock">
      {open ? (
        <div
          className={`ch-dock__panel${target?.type === 'channel' ? ' ch-dock__panel--wide' : ''}`}
          role="dialog"
          aria-label="Messages"
        >
          <header className="ch-head">
            {target ? (
              <button
                type="button"
                className="ch-btn ch-btn--ghost"
                onClick={() => setTarget(null)}
                aria-label="Back to conversations"
              >
                ←
              </button>
            ) : null}

            <p className="ch-head__title">
              {target ? target.title : 'Messages'}
              {status !== 'connected' ? (
                <span className="ch-head__sub">
                  {status === 'connecting' ? 'Reconnecting…' : 'Offline — messages will send later'}
                </span>
              ) : null}
            </p>

            <button
              type="button"
              className="ch-btn ch-btn--ghost"
              onClick={() => setOpen(false)}
              aria-label="Close messages"
            >
              ×
            </button>
          </header>

          {!target ? (
            <ConversationList activeId={null} onSelect={setTarget} />
          ) : target.type === 'channel' ? (
            <PublicChannelView channelId={target.id} />
          ) : (
            <DirectConversation conversationId={target.id} />
          )}
        </div>
      ) : null}

      <button
        type="button"
        className="ch-dock__launcher"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Messages
        {unreadTotal > 0 ? (
          <span className="ch-badge">{unreadTotal > 99 ? '99+' : unreadTotal}</span>
        ) : null}
      </button>
    </div>
  );
}

function DirectConversation({ conversationId }) {
  const me = useClassroomUser();
  const chat = useChat({ scope: 'conversation', conversationId });
  const { conversation, typingUsers, send, sendTyping, blocked } = chat;

  const other = conversation?.participants?.find((p) => p.id !== me.id) ?? null;

  return (
    <>
      {other ? (
        <p className="ch-notice" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: '1 1 auto' }}>{other.role} · {other.sharedContext ?? 'No shared course'}</span>
          <ReportBlockMenu targetUser={other} compact />
        </p>
      ) : null}

      <MessageThread
        chat={chat}
        me={me}
        emptyText={other ? `This is the start of your conversation with ${other.displayName}.` : ''}
      />

      <TypingIndicator users={typingUsers} />

      <div className="ch-foot">
        <MessageComposer
          scope={{ type: 'conversation', id: conversationId }}
          placeholder={other ? `Message ${other.displayName}` : 'Write a message'}
          onSend={send}
          onTyping={sendTyping}
          allowAttachments
          disabled={Boolean(blocked)}
          disabledReason={
            blocked === 'by-them'
              ? 'This person is not accepting messages from you.'
              : blocked === 'by-me'
                ? 'You blocked this person. Unblock them in your privacy settings to write.'
                : ''
          }
        />
      </div>
    </>
  );
}