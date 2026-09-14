import { useEffect, useId, useRef, useState } from 'react';
import { chatApi, profileApi, useClassroomUser } from '@classroom/core-client';
import './chat.css';

const REASONS = [
  { id: 'harassment', label: 'Harassment or bullying' },
  { id: 'spam', label: 'Spam or advertising' },
  { id: 'explicit', label: 'Sexual or explicit content' },
  { id: 'violence', label: 'Violence or threats' },
  { id: 'other', label: 'Something else' },
];

/**
 * The single way a person reports or blocks, wherever they are: a message in the
 * public channel, a DM, a profile card.
 *
 * Blocking is a server-side fact. Block.js is checked on send, not on render, so
 * a blocked person is not "hidden in the UI" — their message is refused. That is
 * why this component does nothing optimistic: it calls, waits, and reports what
 * actually happened.
 *
 * Reports land in the moderation queue (ChatModerationService.js) with the
 * message id, so a moderator sees the message even if it is later soft-deleted.
 */
export default function ReportBlockMenu({
  targetUser,
  message = null,
  canModerate = false,
  onDone,
  compact = false,
}) {
  const me = useClassroomUser();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(null); // 'report' | 'block' | null
  const [reason, setReason] = useState(REASONS[0].id);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const wrapRef = useRef(null);
  const dialogRef = useRef(null);
  const titleId = useId();

  const isSelf = targetUser?.id === me.id;

  useEffect(() => {
    if (!open) return undefined;
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
  }, [open]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (dialog && !el.open) el.showModal();
    if (!dialog && el.open) el.close();
  }, [dialog]);

  const run = async (fn, successText) => {
    setBusy(true);
    setResult(null);
    try {
      await fn();
      setResult({ ok: true, text: successText });
      onDone?.();
    } catch {
      setResult({ ok: false, text: 'That did not go through. Try again in a moment.' });
    } finally {
      setBusy(false);
    }
  };

  const submitReport = () =>
    run(
      () =>
        chatApi.report({
          messageId: message?.id ?? null,
          userId: targetUser.id,
          reason,
          detail: detail.trim() || undefined,
        }),
      'Reported. A moderator will look at it.',
    );

  const submitBlock = () =>
    run(
      () => profileApi.block(targetUser.id),
      `${targetUser.displayName} can no longer message you.`,
    );

  return (
    <span className="ch ch-menu" ref={wrapRef}>
      <button
        type="button"
        className="ch-btn ch-btn--ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => setOpen((v) => !v)}
      >
        {compact ? '⋯' : 'More'}
      </button>

      {open ? (
        <div className="ch-menu__items" role="menu">
          {message ? (
            <button
              type="button"
              role="menuitem"
              className="ch-menu__item"
              onClick={() => {
                navigator.clipboard?.writeText(message.body ?? '');
                setOpen(false);
              }}
            >
              Copy message
            </button>
          ) : null}

          {!isSelf ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="ch-menu__item"
                onClick={() => {
                  setDialog('report');
                  setOpen(false);
                }}
              >
                Report {message ? 'this message' : targetUser.displayName}
              </button>
              <button
                type="button"
                role="menuitem"
                className="ch-menu__item ch-menu__item--danger"
                onClick={() => {
                  setDialog('block');
                  setOpen(false);
                }}
              >
                Block {targetUser.displayName}
              </button>
            </>
          ) : null}

          {canModerate ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="ch-menu__item"
                disabled={!message}
                onClick={() => {
                  run(() => chatApi.softDelete(message.id), 'Message removed.');
                  setOpen(false);
                }}
              >
                Remove message
              </button>
              <button
                type="button"
                role="menuitem"
                className="ch-menu__item"
                onClick={() => {
                  run(
                    () => chatApi.muteUser(targetUser.id, { minutes: 15 }),
                    `${targetUser.displayName} is muted for 15 minutes.`,
                  );
                  setOpen(false);
                }}
              >
                Mute for 15 minutes
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <dialog
        ref={dialogRef}
        className="ch-dialog"
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          setDialog(null);
        }}
      >
        <div className="ch-head">
          <h2 id={titleId} className="ch-head__title">
            {dialog === 'block' ? `Block ${targetUser?.displayName}` : 'Report to a moderator'}
          </h2>
        </div>

        <div className="ch-dialog__body">
          {dialog === 'block' ? (
            <p style={{ margin: 0 }}>
              They won't be able to message you, and you won't see their messages in shared
              channels. They are not told. You can undo this in your privacy settings.
            </p>
          ) : (
            <>
              <label>
                What's wrong?
                <select value={reason} onChange={(e) => setReason(e.target.value)}>
                  {REASONS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Anything a moderator should know? (optional)
                <textarea
                  rows={3}
                  value={detail}
                  maxLength={1000}
                  onChange={(e) => setDetail(e.target.value)}
                />
              </label>

              {message ? (
                <p className="ch-muted" style={{ margin: 0, fontSize: 12 }}>
                  The message is attached to the report, so removing it later won't hide it from
                  the moderator.
                </p>
              ) : null}
            </>
          )}

          {result ? (
            <p style={{ margin: 0, color: result.ok ? 'inherit' : 'var(--ch-danger)' }}>
              {result.text}
            </p>
          ) : null}
        </div>

        <div className="ch-dialog__foot">
          <button type="button" className="ch-btn" onClick={() => setDialog(null)}>
            {result?.ok ? 'Close' : 'Cancel'}
          </button>
          {result?.ok ? null : (
            <button
              type="button"
              className="ch-btn ch-btn--primary"
              disabled={busy}
              onClick={dialog === 'block' ? submitBlock : submitReport}
            >
              {busy ? 'Sending…' : dialog === 'block' ? 'Block' : 'Send report'}
            </button>
          )}
        </div>
      </dialog>
    </span>
  );
}