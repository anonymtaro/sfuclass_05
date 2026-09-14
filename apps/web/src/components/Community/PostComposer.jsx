import { useCallback, useMemo, useRef, useState } from 'react';
import { communityApi, useUpload } from '@classroom/core-client';
import UploadProgressRow from '../Chat/UploadProgressRow.jsx';
import './community.css';

/**
 * One composer for both jobs: starting a thread (title + body) and replying to
 * one (body only).
 *
 * Attachments reuse the media domain through useUpload — presign, direct-to-S3
 * multipart, quarantine, scan — so a file posted in a space inherits the same
 * quota, scanning and signed delivery as a chat attachment or a course video.
 * Only assets that report `ready` are submitted.
 *
 * Mentions resolve against the space membership, not the whole tenant: a person
 * who is not in the space cannot be pulled into it by being named. The server
 * checks the same thing again on save — NotificationService only fans out to
 * people who can actually read the thread.
 */
export default function PostComposer({
  mode = 'reply',
  spaceId,
  threadId,
  onSubmit,
  onCancel,
  placeholder = 'Write a reply',
  autoFocus = false,
  disabled = false,
  disabledReason = '',
  maxLength = 8000,
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dropping, setDropping] = useState(false);
  const [mention, setMention] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const inputRef = useRef(null);
  const { uploads, enqueue, cancel, retry, clear } = useUpload({
    scope: { type: 'community', spaceId, threadId },
  });

  const ready = uploads.filter((u) => u.state === 'ready');
  const uploading = uploads.some(
    (u) => !['ready', 'failed', 'rejected', 'quota'].includes(u.state),
  );

  const needsTitle = mode === 'thread';
  const canPost =
    !disabled && !busy && !uploading && body.trim().length > 0 && (!needsTitle || title.trim().length > 0);

  const search = useMemo(
    () => (q) => communityApi.searchMembers({ spaceId, query: q }),
    [spaceId],
  );

  const updateMention = useCallback(
    async (value, caret) => {
      const match = /(^|\s)@([\p{L}\p{N}_.-]{0,30})$/u.exec(value.slice(0, caret));
      if (!match) return setMention(null);

      const query = match[2];
      const at = caret - query.length - 1;
      setMention((prev) => ({ query, at, results: prev?.results ?? [], index: 0 }));
      try {
        const results = await search(query);
        setMention((prev) => (prev && prev.at === at ? { ...prev, results, index: 0 } : prev));
      } catch {
        /* no suggestions is a fine outcome */
      }
    },
    [search],
  );

  const applyMention = (user) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? body.length;
    const before = body.slice(0, mention.at);
    const inserted = `@${user.handle ?? user.displayName} `;
    setBody(`${before}${inserted}${body.slice(caret)}`);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = before.length + inserted.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const submit = async () => {
    if (!canPost) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        title: needsTitle ? title.trim() : undefined,
        body: body.trim(),
        attachmentIds: ready.map((u) => u.assetId),
      });
      setTitle('');
      setBody('');
      clear();
    } catch {
      // The draft stays in the box. Losing somebody's paragraph because a
      // request failed is not an acceptable way to report a failure.
      setError('That did not post. Your text is still here — try again.');
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (mention?.results.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setMention((m) => ({
          ...m,
          index: (m.index + (e.key === 'ArrowDown' ? 1 : m.results.length - 1)) % m.results.length,
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

    // Enter makes a paragraph here — a post is longer than a chat message, so
    // posting is the deliberate key combination, not the reflex one.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className={`cm cm-composer${dropping ? ' cm-composer--drop' : ''}`}
      style={{ position: 'relative' }}
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        enqueue(Array.from(e.dataTransfer.files ?? []));
      }}
    >
      {needsTitle ? (
        <input
          className="cm-composer__title"
          value={title}
          maxLength={160}
          placeholder="What is this about?"
          aria-label="Thread title"
          disabled={disabled}
          onChange={(e) => setTitle(e.target.value)}
        />
      ) : null}

      <textarea
        ref={inputRef}
        className="cm-composer__input"
        value={body}
        maxLength={maxLength}
        placeholder={disabled ? disabledReason || 'You cannot post here' : placeholder}
        aria-label={needsTitle ? 'Post' : 'Reply'}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => {
          setBody(e.target.value);
          updateMention(e.target.value, e.target.selectionStart);
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData?.files ?? []);
          if (files.length) {
            e.preventDefault();
            enqueue(files);
          }
        }}
        onKeyDown={onKeyDown}
      />

      {mention?.results.length ? (
        <div className="cm-mentions" role="listbox" aria-label="Mention someone" style={{ insetBlockEnd: 60 }}>
          {mention.results.map((u, i) => (
            <button
              key={u.id}
              type="button"
              role="option"
              aria-selected={i === mention.index}
              className="cm-mention"
              onClick={() => applyMention(u)}
            >
              <img src={u.avatarUrl} alt="" />
              <span>
                {u.displayName}
                {u.handle ? <span className="cm-muted"> @{u.handle}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {uploads.length ? (
        <div style={{ display: 'grid', gap: 6 }}>
          {uploads.map((u) => (
            <UploadProgressRow key={u.id} upload={u} onCancel={cancel} onRetry={retry} />
          ))}
        </div>
      ) : null}

      <div className="cm-composer__row">
        <input
          id={`cm-files-${threadId ?? spaceId ?? 'new'}`}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            enqueue(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <label htmlFor={`cm-files-${threadId ?? spaceId ?? 'new'}`} className="cm-btn">
          📎 Attach
        </label>

        <span className="cm-composer__hint">⌘/Ctrl + Enter to post · @ to mention</span>

        <span className="cm-composer__spacer" />

        {onCancel ? (
          <button type="button" className="cm-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}

        <button type="button" className="cm-btn cm-btn--primary" disabled={!canPost} onClick={submit}>
          {busy ? 'Posting…' : uploading ? 'Uploading…' : needsTitle ? 'Post thread' : 'Reply'}
        </button>
      </div>

      {error ? <p className="cm-note cm-note--danger">{error}</p> : null}
      {disabled && disabledReason ? <p className="cm-note">{disabledReason}</p> : null}
    </div>
  );
}