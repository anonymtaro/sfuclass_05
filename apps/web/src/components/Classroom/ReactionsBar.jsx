import { useCallback, useEffect, useRef, useState } from 'react';
import { useClassroom } from '@classroom/core-client';
import { ReactionKinds, SignalingEvents } from '@classroom/contracts';
import './classroom.css';

/** Kept short on purpose: a reaction is a pulse, not a vocabulary. */
const GLYPH = {
  [ReactionKinds.CLAP]: '👏',
  [ReactionKinds.THUMBS_UP]: '👍',
  [ReactionKinds.HEART]: '❤️',
  [ReactionKinds.LAUGH]: '😄',
  [ReactionKinds.SURPRISED]: '😮',
  [ReactionKinds.CONFUSED]: '🤔',
};

const LABEL = {
  [ReactionKinds.CLAP]: 'Applaud',
  [ReactionKinds.THUMBS_UP]: 'Agree',
  [ReactionKinds.HEART]: 'Love it',
  [ReactionKinds.LAUGH]: 'Laugh',
  [ReactionKinds.SURPRISED]: 'Surprised',
  [ReactionKinds.CONFUSED]: 'Lost me',
};

const COOLDOWN_MS = 800;
const LIFETIME_MS = 2600;

/**
 * Reactions never touch the messaging domain. They are pub/sub only — the server
 * fans them out through Reactions.js and forgets them, so nothing has to be
 * pruned later and the chat history stays a record of what was actually said.
 *
 * The bar sends; <ReactionLayer /> renders what comes back, including your own,
 * so everyone sees the same burst at roughly the same moment.
 */
export default function ReactionsBar({ className = '' }) {
  const { room, self, emit } = useClassroom();
  const lastSent = useRef(0);
  const [cooling, setCooling] = useState(false);

  const send = useCallback(
    (kind) => {
      const now = Date.now();
      // socketRateLimit.js drops anything faster than this; refusing locally
      // keeps a keyboard-repeat from burning the connection's event budget.
      if (now - lastSent.current < COOLDOWN_MS) return;
      lastSent.current = now;
      setCooling(true);
      window.setTimeout(() => setCooling(false), COOLDOWN_MS);
      emit(SignalingEvents.reaction.send, { roomId: room.id, peerId: self.id, kind });
    },
    [emit, room.id, self.id],
  );

  return (
    <div className={`cr cr-reactions ${className}`} role="group" aria-label="Send a reaction">
      {Object.values(ReactionKinds).map((kind) => (
        <button
          key={kind}
          type="button"
          className="cr-reactions__btn"
          onClick={() => send(kind)}
          disabled={cooling}
          title={LABEL[kind]}
          aria-label={LABEL[kind]}
        >
          {GLYPH[kind]}
        </button>
      ))}
    </div>
  );
}

/**
 * Drop this inside any positioned container — the share stage, the speaker grid —
 * and bursts float up over it. It renders nothing until something arrives, and
 * it is unmounted-safe: every timer is cleared on teardown.
 */
export function ReactionLayer({ max = 24 }) {
  const { on } = useClassroom();
  const [bursts, setBursts] = useState([]);
  const timers = useRef(new Set());

  useEffect(() => {
    const off = on(SignalingEvents.reaction.burst, ({ id, kind, displayName }) => {
      const burst = {
        id,
        kind,
        displayName,
        left: 8 + Math.random() * 78, // percent, so it survives a resize
      };
      setBursts((prev) => [...prev.slice(-(max - 1)), burst]);

      const timer = window.setTimeout(() => {
        setBursts((prev) => prev.filter((b) => b.id !== id));
        timers.current.delete(timer);
      }, LIFETIME_MS);
      timers.current.add(timer);
    });

    return () => {
      off();
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current.clear();
    };
  }, [on, max]);

  if (!bursts.length) return null;

  return (
    <div className="cr cr-reactions__layer" aria-live="polite" aria-atomic="false">
      {bursts.map((b) => (
        <span key={b.id} className="cr-reactions__float" style={{ insetInlineStart: `${b.left}%` }}>
          <span aria-hidden="true">{GLYPH[b.kind]}</span>
          <small>{b.displayName}</small>
        </span>
      ))}
    </div>
  );
}