import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chatApi, useUpload } from '@classroom/core-client';
import UploadProgressRow from './UploadProgressRow.jsx';
import './chat.css';

const EMOJI = [
  '😀', '😄', '😅', '😂', '🙂', '😉', '😊', '😍',
  '🤔', '😐', '🙄', '😴', '😭', '😱', '👍', '👎',
  '👏', '🙌', '🙏', '💪', '🔥', '✅', '❌', '⚠️',
  '❤️', '🎉', '🚀', '💡', '📌', '📎', '☕', '👀',
];

const TYPING_THROTTLE_MS = 2500;

/**
 * One composer for every surface: the dock, the public channel, the lesson panel.
 *
 * Sending is optimistic by design — `onSend` hands the message to the outbox,
 * which owns the client-generated dedupe key and the retry. This component
 * clears the box immediately because the outbox, not the composer, is
 * responsible for the message from that point on.
 *
 * Attachments never touch the API: useUpload() presigns, uploads straight to S3
 * in parts, and resolves once the asset is scanned and ready. Only ready asset
 * ids are attached, so a message can never reference a file still in quarantine.
 */
export default function MessageComposer({
  placeholder = 'Write a message',
  onSend,
  onTyping,
  allowAttachments = false,
  disabled = false,
  disabledReason = '',
  maxLength = 4000,
  scope,
  onMentionSearch,
  className = '',
}) {
  const [body, setBody] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [mention, setMention] = useState(null); // { query, at, results, index }

  const inputRef = useRef(null);
  const lastTyping = useRef(0);
  const { uploads, enqueue, cancel, retry, clear } = useUpload({ scope });

  const ready = uploads.filter((u) => u.state === 'ready');
  const busy = uploads.some((u) => !['ready', 'failed', 'rejected', 'quota'].includes(u.state));
  const canSend = !disabled && !busy && (body.trim().length > 0 || ready.length > 0);

  /* ---- auto-grow ---- */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [body]);

  /* ---- typing ---- */
  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTyping.current < TYPING_THROTTLE_MS) return;
    lastTyping.current = now;
    onTyping?.();
  }, [onTyping]);

  /* ---- mentions ---- */
  const search = useMemo(
    () => onMentionSearch ?? ((q) => chatApi.searchMentionables({ scope, query: q })),
    [onMentionSearch, scope],
  );

  const updateMention = useCallback(
    async (value, caret) => {
      const upTo = value.slice(0, caret);
      const match = /(^|\s)@([\p{L}\p{N}_.-]{0,30})$/u.exec(upTo);
      if (!match) return setMention(null);

      const query = match[2];
      const at = caret - query.length - 1;
      setMention((prev) => ({ query, at, results: prev?.results ?? [], index: 0 }));
      try {
        const results = await search(query);
        setMention((prev) => (prev && prev.at === at ? { ...prev, results, index: 0 } : prev));
      } catch {
        /* a failed lookup just means no suggestions */
      }
    },
    [search],
  );

  const applyMention = (user) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? body.length;
    const before = body.slice(0, mention.at);
    const after = body.slice(caret);
    const inserted = `@${user.handle ?? user.displayName} `;
    setBody(`${before}${inserted}${after}`);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = before.length + inserted.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  /* ---- files ---- */
  const addFiles = (files) => {
    if (!allowAttachments || !files?.length) return;
    enqueue(Array.from(files));
  };

  const onPaste = (e) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  /* ---- send ---- */
  const submit = () => {
    if (!canSend) return;
    onSend({
      body: body.trim(),
      attachmentIds: ready.map((u) => u.assetId),
    });
    setBody('');
    setMention(null);
    clear();
    lastTyping.current = 0;
  };

  const onKeyDown = (e) => {
    if (mention?.results.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setMention((m) => ({
          ...m,
          index:
            (m.index + (e.key === 'ArrowDown' ? 1 : m.results.length - 1)) % m.results.length,
        }));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyMention(mention.results[mention.index]);
        return;
      }
      if (e.key === 'Escape') return setMention(null);
    }

    // Enter sends, Shift+Enter breaks the line. Mobile keyboards send a plain
    // newline instead, which is why the send button is always visible.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className={`ch ch-composer${dropping ? ' ch-composer--drop' : ''} ${className}`}
      style={{ position: 'relative' }}
      onDragOver={(e) => {
        if (!allowAttachments) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        if (!allowAttachments) return;
        e.preventDefault();
        setDropping(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {uploads.length ? (
        <div style={{ display: 'grid', gap: 6 }}>
          {uploads.map((u) => (
            <UploadProgressRow key={u.id} upload={u} onCancel={cancel} onRetry={retry} />
          ))}
        </div>
      ) : null}

      {mention?.results.length ? (
        <div className="ch-mentions" role="listbox" aria-label="Mention someone">
          {mention.results.map((u, i) => (
            <button
              key={u.id}
              type="button"
              role="option"
              aria-selected={i === mention.index}
              className="ch-row"
              onClick={() => applyMention(u)}
            >
              <img className="ch-row__avatar" src={u.avatarUrl} alt="" />
              <span className="ch-row__main">
                <span className="ch-row__name">{u.displayName}</span>
                {u.handle ? <span className="ch-row__preview">@{u.handle}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {emojiOpen ? (
        <div className="ch-emoji" role="group" aria-label="Insert an emoji">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                setBody((b) => b + e);
                setEmojiOpen(false);
                inputRef.current?.focus();
              }}
            >
              {e}
            </button>
          ))}
        </div>
      ) : null}

      <div className="ch-composer__row">
        {allowAttachments ? (
          <>
            <input
              id="ch-file-input"
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <label htmlFor="ch-file-input" className="ch-btn" title="Attach a file">
              📎
            </label>
          </>
        ) : null}

        <textarea
          ref={inputRef}
          className="ch-composer__input"
          rows={1}
          value={body}
          maxLength={maxLength}
          disabled={disabled}
          placeholder={disabled ? disabledReason || 'You cannot post here' : placeholder}
          aria-label={placeholder}
          onChange={(e) => {
            setBody(e.target.value);
            notifyTyping();
            updateMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        <button
          type="button"
          className="ch-btn"
          aria-label="Insert an emoji"
          aria-expanded={emojiOpen}
          onClick={() => setEmojiOpen((v) => !v)}
        >
          🙂
        </button>

        <button type="button" className="ch-btn ch-btn--primary" disabled={!canSend} onClick={submit}>
          {busy ? 'Uploading…' : 'Send'}
        </button>
      </div>

      {disabled && disabledReason ? (
        <span className="ch-composer__hint">{disabledReason}</span>
      ) : body.length > maxLength - 200 ? (
        <span className="ch-composer__hint">
          {maxLength - body.length} characters left
        </span>
      ) : null}
    </div>
  );
}