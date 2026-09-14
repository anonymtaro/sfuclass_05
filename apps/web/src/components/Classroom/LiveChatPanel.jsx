import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useChat, useClassroom } from '@classroom/core-client';
import MessageComposer from '../Chat/MessageComposer.jsx';
import AttachmentTile from '../Chat/AttachmentTile.jsx';
import './classroom.css';

const STACK_WINDOW_MS = 5 * 60 * 1000;
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * In-lesson chat. Not a second chat system.
 *
 * `useChat({ scope: 'lesson', roomId })` resolves to the course-bound channel
 * that LiveChat.js persists into, which is the same conversation the docked
 * ChatDock shows. Messages sent here are readable after the lesson ends, are
 * searchable in OpenSearch, and count towards the same unread badge — there is
 * one store, one outbox and one dedupe key.
 *
 * Sending is at-least-once: the composer hands the message to the outbox, which
 * renders it immediately as pending and retries after a reconnect. A message
 * that fails for good keeps its text and offers a retry instead of vanishing.
 */
export default function LiveChatPanel({ onClose }) {
  const { room, self } = useClassroom();
  const {
    messages,
    hasMore,
    loadOlder,
    loading,
    send,
    retry,
    typingUsers,
    sendTyping,
    markRead,
  } = useChat({ scope: 'lesson', roomId: room.id, lessonId: room.lessonId });

  const listRef = useRef(null);
  const bottomRef = useRef(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);

  const rows = useMemo(() => {
    let previous = null;
    return messages.map((m) => {
      const stacked =
        previous &&
        previous.authorId === m.authorId &&
        new Date(m.createdAt) - new Date(previous.createdAt) < STACK_WINDOW_MS;
      previous = m;
      return { ...m, stacked };
    });
  }, [messages]);

  // Keep the newest message in view unless the reader has scrolled up to read
  // history — jumping someone away from what they are reading is worse than a
  // missed message, so we count instead and offer a jump.
  useLayoutEffect(() => {
    if (pinnedToBottom) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
      setUnseen(0);
    } else {
      setUnseen((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  useEffect(() => {
    if (!pinnedToBottom || document.visibilityState !== 'visible') return;
    const last = messages[messages.length - 1];
    if (last) markRead(last.id);
  }, [messages, pinnedToBottom, markRead]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setPinnedToBottom(atBottom);
    if (atBottom) setUnseen(0);

    // Keyset pagination by (conversation_id, created_at, id) — the cursor lives
    // in the hook, so scrolling never re-sends an offset that has shifted.
    if (el.scrollTop < 120 && hasMore && !loading) {
      const before = el.scrollHeight;
      loadOlder().then(() => {
        const after = listRef.current;
        if (after) after.scrollTop += after.scrollHeight - before;
      });
    }
  }, [hasMore, loading, loadOlder]);

  const jumpToLatest = () => {
    setPinnedToBottom(true);
    setUnseen(0);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };

  const typingLabel = typingUsers.length
    ? typingUsers.length === 1
      ? `${typingUsers[0].displayName} is typing…`
      : `${typingUsers.length} people are typing…`
    : '';

  return (
    <section className="cr cr-panel" aria-label="Lesson chat" style={{ position: 'relative' }}>
      <header className="cr-panel__head">
        <span>Chat</span>
        {onClose ? (
          <button type="button" className="cr-btn cr-btn--ghost" onClick={onClose}>
            Close
          </button>
        ) : null}
      </header>

      <div className="cr-panel__body" ref={listRef} onScroll={onScroll}>
        {hasMore ? (
          <p className="cr-empty" aria-live="polite">
            {loading ? 'Loading earlier messages…' : 'Scroll up for earlier messages'}
          </p>
        ) : null}

        {rows.length === 0 && !hasMore ? (
          <p className="cr-empty">Nothing yet. Say hello, or drop a link for the class.</p>
        ) : null}

        <div className="cr-chat__list">
          {rows.map((m) => (
            <article
              key={m.id}
              className={[
                'cr-msg',
                m.stacked ? 'cr-msg--stacked' : '',
                m.status === 'pending' ? 'cr-msg--pending' : '',
                m.status === 'failed' ? 'cr-msg--failed' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {m.stacked ? (
                <span aria-hidden="true" />
              ) : (
                <img className="cr-msg__avatar" src={m.author.avatarUrl} alt="" />
              )}

              <div>
                {m.stacked ? null : (
                  <p className="cr-msg__head">
                    <strong>
                      {m.author.displayName}
                      {m.authorId === self.userId ? ' (you)' : ''}
                    </strong>
                    <time className="cr-msg__time" dateTime={m.createdAt}>
                      {time.format(new Date(m.createdAt))}
                    </time>
                  </p>
                )}

                {m.deletedAt ? (
                  <p className="cr-msg__body cr-note">Message removed by a moderator.</p>
                ) : (
                  <p className="cr-msg__body">{m.body}</p>
                )}

                {m.attachments?.map((a) => (
                  <AttachmentTile key={a.id} attachment={a} compact />
                ))}

                {m.status === 'failed' ? (
                  <button type="button" className="cr-btn cr-btn--ghost" onClick={() => retry(m.id)}>
                    Not sent — try again
                  </button>
                ) : null}
              </div>
            </article>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {unseen > 0 && !pinnedToBottom ? (
        <button type="button" className="cr-btn cr-btn--primary cr-chat__jump" onClick={jumpToLatest}>
          {unseen} new
        </button>
      ) : null}

      <p className="cr-chat__typing" aria-live="polite">
        {typingLabel}
      </p>

      <div className="cr-panel__foot">
        {/* Same composer as the dock: paste, drag-drop, @mention, emoji.
            Attachments go through media/ presign → quarantine → CDN. */}
        <MessageComposer
          placeholder="Message the class"
          onSend={send}
          onTyping={sendTyping}
          allowAttachments
          className="cr-chat__composer"
        />
      </div>
    </section>
  );
}