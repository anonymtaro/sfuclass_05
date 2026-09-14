import { useEffect, useMemo, useState } from 'react';
import { useClassroom } from '@classroom/core-client';
import { SignalingEvents } from '@classroom/contracts';
import './classroom.css';

function since(ts, now) {
  const secs = Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  return `${m}m ${secs % 60}s`;
}

/**
 * The queue is ordered by `handRaisedAt`, which the server stamps — not the
 * client — so two people raising at the same moment get a stable, fair order
 * that everyone in the room sees identically.
 *
 * Hands survive a reconnect: they live on Peer, not in this component.
 */
export default function HandRaiseTray({ onClose }) {
  const { peers, self, room, emit } = useClassroom();
  const [now, setNow] = useState(() => Date.now());

  const isHost = self.role === 'host' || self.role === 'teacher';
  const myHand = peers.find((p) => p.id === self.id)?.handRaisedAt ?? null;

  const raised = useMemo(
    () =>
      peers
        .filter((p) => p.handRaisedAt)
        .sort((a, b) => new Date(a.handRaisedAt) - new Date(b.handRaisedAt)),
    [peers],
  );

  useEffect(() => {
    if (!raised.length) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [raised.length]);

  const toggleMine = () =>
    emit(myHand ? SignalingEvents.handRaise.lower : SignalingEvents.handRaise.raise, {
      roomId: room.id,
      peerId: self.id,
    });

  return (
    <section className="cr cr-panel cr-hands" aria-label="Raised hands">
      <header className="cr-panel__head">
        <span>
          Hands up <span className="cr-count">{raised.length}</span>
        </span>
        {isHost && raised.length > 1 ? (
          <button
            type="button"
            className="cr-btn cr-btn--ghost"
            onClick={() => emit(SignalingEvents.handRaise.lower, { roomId: room.id, all: true })}
          >
            Lower all
          </button>
        ) : null}
        {onClose ? (
          <button type="button" className="cr-btn cr-btn--ghost" onClick={onClose}>
            Close
          </button>
        ) : null}
      </header>

      <div className="cr-panel__body">
        {raised.length === 0 ? (
          <p className="cr-empty">No hands yet.</p>
        ) : (
          raised.map((peer, i) => (
            <div key={peer.id} className="cr-hands__item">
              <span className="cr-hands__order" aria-hidden="true">
                {i + 1}
              </span>
              <img className="cr-person__avatar" src={peer.avatarUrl} alt="" />
              <span className="cr-person__main">
                <span className="cr-person__name">
                  {peer.displayName}
                  {peer.id === self.id ? ' (you)' : ''}
                </span>
                <span className="cr-hands__waited">waiting {since(peer.handRaisedAt, now)}</span>
              </span>

              {isHost ? (
                <>
                  <button
                    type="button"
                    className="cr-btn"
                    onClick={() =>
                      emit(SignalingEvents.moderation.allowSpeak, {
                        roomId: room.id,
                        peerId: peer.id,
                      })
                    }
                  >
                    Let them speak
                  </button>
                  <button
                    type="button"
                    className="cr-btn cr-btn--ghost"
                    onClick={() =>
                      emit(SignalingEvents.handRaise.lower, { roomId: room.id, peerId: peer.id })
                    }
                  >
                    Lower
                  </button>
                </>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="cr-panel__foot">
        <button
          type="button"
          className={`cr-btn${myHand ? ' cr-btn--active' : ''}`}
          onClick={toggleMine}
        >
          {myHand ? 'Lower my hand' : 'Raise my hand'}
        </button>
      </div>
    </section>
  );
}