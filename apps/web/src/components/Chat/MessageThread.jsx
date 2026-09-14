import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import AttachmentTile from './AttachmentTile.jsx';
import ReportBlockMenu from './ReportBlockMenu.jsx';
import './chat.css';

const STACK_WINDOW_MS = 5 * 60 * 1000;
const ESTIMATED_ROW = 68;
const OVERSCAN = 6;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

function dayKey(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const diff = Math.round((today.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return dayFmt.format(d);
}

/**
 * The message list. Two problems, one component.
 *
 * 1. Length. A public channel reaches six figures, so rows are windowed: only
 *    what fits the viewport plus an overscan is in the DOM. Heights are measured
 *    rather than assumed, because a message with an image is not the height of a
 *    message with three words.
 *
 * 2. Position. History is keyset-paginated by (conversation_id, created_at, id).
 *    Prepending an older page changes scrollHeight, so the scroll offset is
 *    re-anchored in the same frame — the reader never gets thrown.
 *
 * Everything else — the store, the outbox, the dedupe key — belongs to
 * useChat(); this component takes it as a prop so a page only ever subscribes
 * once, no matter how many views render the same conversation.
 */
export default function MessageThread({
  chat,
  me,
  canModerate = false,
  highlight = '',
  emptyText = 'No messages yet.',
}) {
  const { messages, hasMore, loading, loadOlder, retry, markRead } = chat;

  const scrollerRef = useRef(null);
  const heights = useRef(new Map());
  const pendingAnchor = useRef(null);
  const [, forceMeasure] = useState(0);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 30 });

  /* ---- rows: messages plus day separators, flattened for the window ---- */

  const rows = useMemo(() => {
    const out = [];
    let previous = null;
    for (const m of messages) {
      if (!previous || dayKey(previous.createdAt) !== dayKey(m.createdAt)) {
        out.push({ kind: 'day', key: `day-${dayKey(m.createdAt)}`, at: m.createdAt });
      }
      const stacked =
        previous &&
        previous.authorId === m.authorId &&
        dayKey(previous.createdAt) === dayKey(m.createdAt) &&
        new Date(m.createdAt) - new Date(previous.createdAt) < STACK_WINDOW_MS;
      out.push({ kind: 'message', key: m.id, message: m, stacked });
      previous = m;
    }
    return out;
  }, [messages]);

  const offsets = useMemo(() => {
    const acc = new Array(rows.length + 1);
    acc[0] = 0;
    for (let i = 0; i < rows.length; i += 1) {
      acc[i + 1] = acc[i] + (heights.current.get(rows[i].key) ?? ESTIMATED_ROW);
    }
    return acc;
    // forceMeasure is the measurement version; recomputing offsets is cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, forceMeasure]);

  const totalHeight = offsets[rows.length] ?? 0;

  const computeRange = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;

    // Binary search the cumulative offsets rather than walking them.
    const find = (value) => {
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] < value) lo = mid + 1;
        else hi = mid;
      }
      return Math.max(0, lo - 1);
    };

    setRange({
      start: Math.max(0, find(top) - OVERSCAN),
      end: Math.min(rows.length, find(bottom) + OVERSCAN + 1),
    });
  }, [rows.length, offsets]);

  /* ---- measurement ---- */

  const measureRef = useCallback((node) => {
    if (!node) return;
    const key = node.dataset.key;
    const h = node.getBoundingClientRect().height;
    if (h && heights.current.get(key) !== h) {
      heights.current.set(key, h);
      forceMeasure((n) => n + 1);
    }
  }, []);

  /* ---- scrolling ---- */

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    computeRange();

    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    setPinnedToBottom(atBottom);
    if (atBottom) setUnseen(0);

    if (el.scrollTop < 240 && hasMore && !loading) {
      pendingAnchor.current = el.scrollHeight - el.scrollTop;
      loadOlder();
    }
  }, [computeRange, hasMore, loading, loadOlder]);

  // Restore the reading position after an older page is prepended, and keep the
  // newest message in view only for a reader who was already at the bottom.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    if (pendingAnchor.current != null) {
      el.scrollTop = el.scrollHeight - pendingAnchor.current;
      pendingAnchor.current = null;
      computeRange();
      return;
    }

    if (pinnedToBottom) {
      el.scrollTop = el.scrollHeight;
      setUnseen(0);
      computeRange();
    } else {
      setUnseen((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, totalHeight]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(computeRange);
    ro.observe(el);
    computeRange();
    return () => ro.disconnect();
  }, [computeRange]);

  // Read state is only claimed when the tab is actually in front of someone.
  useEffect(() => {
    if (!pinnedToBottom || document.visibilityState !== 'visible') return;
    const last = messages[messages.length - 1];
    if (last && last.authorId !== me.id) markRead(last.id);
  }, [messages, pinnedToBottom, markRead, me.id]);

  const jumpToLatest = () => {
    const el = scrollerRef.current;
    setPinnedToBottom(true);
    setUnseen(0);
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const visible = rows.slice(range.start, range.end);
  const padTop = offsets[range.start] ?? 0;
  const padBottom = Math.max(0, totalHeight - (offsets[range.end] ?? totalHeight));

  return (
    <div className="ch ch-body" style={{ position: 'relative' }}>
      <div className="ch-thread" ref={scrollerRef} onScroll={onScroll}>
        {hasMore ? (
          <p className="ch-empty" aria-live="polite">
            {loading ? 'Loading earlier messages…' : 'Scroll up for earlier messages'}
          </p>
        ) : null}

        {rows.length === 0 && !hasMore ? <p className="ch-empty">{emptyText}</p> : null}

        <div className="ch-thread__spacer" style={{ height: padTop }} />

        <div className="ch-thread__rows">
          {visible.map((row) =>
            row.kind === 'day' ? (
              <p key={row.key} className="ch-day" data-key={row.key} ref={measureRef}>
                {dayLabel(row.at)}
              </p>
            ) : (
              <Row
                key={row.key}
                row={row}
                me={me}
                canModerate={canModerate}
                highlight={highlight}
                onRetry={retry}
                measureRef={measureRef}
              />
            ),
          )}
        </div>

        <div className="ch-thread__spacer" style={{ height: padBottom }} />
      </div>

      {unseen > 0 && !pinnedToBottom ? (
        <button type="button" className="ch-btn ch-btn--primary ch-jump" onClick={jumpToLatest}>
          {unseen} new
        </button>
      ) : null}
    </div>
  );
}

function Row({ row, me, canModerate, highlight, onRetry, measureRef }) {
  const m = row.message;
  const mine = m.authorId === me.id;

  return (
    <article
      data-key={row.key}
      ref={measureRef}
      className={[
        'ch-msg',
        m.status === 'pending' ? 'ch-msg--pending' : '',
        m.status === 'failed' ? 'ch-msg--failed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ position: 'relative' }}
    >
      {row.stacked ? (
        <span aria-hidden="true" />
      ) : (
        <img className="ch-msg__avatar" src={m.author.avatarUrl} alt="" loading="lazy" />
      )}

      <div>
        {row.stacked ? null : (
          <p className="ch-msg__head">
            <strong>
              {m.author.displayName}
              {mine ? ' (you)' : ''}
            </strong>
            <time className="ch-msg__time" dateTime={m.createdAt}>
              {timeFmt.format(new Date(m.createdAt))}
            </time>
          </p>
        )}

        {m.deletedAt ? (
          <p className="ch-msg__body ch-muted">Removed by a moderator.</p>
        ) : (
          <p className="ch-msg__body">
            <Highlighted text={m.body} term={highlight} />
            {m.editedAt ? <span className="ch-msg__time"> (edited)</span> : null}
          </p>
        )}

        {m.attachments?.map((a) => (
          <AttachmentTile key={a.id} attachment={a} />
        ))}

        {m.status === 'failed' ? (
          <button type="button" className="ch-btn ch-btn--ghost" onClick={() => onRetry(m.id)}>
            Not sent — try again
          </button>
        ) : null}

        {mine && m.readBy?.length ? (
          <span className="ch-receipt">Read by {m.readBy.length}</span>
        ) : null}
      </div>

      {m.deletedAt ? null : (
        <span className="ch-msg__tools">
          <ReportBlockMenu
            targetUser={m.author}
            message={m}
            canModerate={canModerate}
            compact
          />
        </span>
      )}
    </article>
  );
}

/** Marks search hits without running HTML through dangerouslySetInnerHTML. */
function Highlighted({ text = '', term = '' }) {
  const needle = term.trim();
  if (!needle) return text;

  const parts = [];
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  let i = 0;

  while (i < text.length) {
    const hit = lower.indexOf(target, i);
    if (hit === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(<mark key={hit}>{text.slice(hit, hit + needle.length)}</mark>);
    i = hit + needle.length;
  }

  return parts;
}