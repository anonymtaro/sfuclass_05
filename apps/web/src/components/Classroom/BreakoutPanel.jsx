import { useEffect, useMemo, useState } from 'react';
import { useClassroom } from '@classroom/core-client';
import { SignalingEvents } from '@classroom/contracts';
import './classroom.css';

/**
 * Breakout rooms are child rooms of the parent lesson (Room.breakoutParent).
 * Moving a peer is a server-side reassignment: the client tears down its
 * transports and rejoins the child room id it is given. This panel therefore
 * only ever sends intent — never a room id it made up.
 *
 * Host view:    create N rooms, shuffle, move a chip, broadcast, recall.
 * Learner view: which room they are in and a way back if the host allows it.
 */
export default function BreakoutPanel({ onClose }) {
  const { room, peers, self, emit, on } = useClassroom();
  const [rooms, setRooms] = useState([]);
  const [count, setCount] = useState(2);
  const [broadcast, setBroadcast] = useState('');
  const [pending, setPending] = useState(false);

  const isHost = self.role === 'host' || self.role === 'teacher';

  useEffect(() => {
    // The room sends a full snapshot on join and after every change; there is
    // no client-side merge to get wrong.
    const off = on(SignalingEvents.breakout.state, (state) => {
      setRooms(state.rooms ?? []);
      setPending(false);
    });
    emit(SignalingEvents.breakout.state, { roomId: room.id });
    return off;
  }, [on, emit, room.id]);

  const unassigned = useMemo(() => {
    const placed = new Set(rooms.flatMap((r) => r.peerIds));
    return peers.filter((p) => !placed.has(p.id));
  }, [rooms, peers]);

  const nameOf = (peerId) => peers.find((p) => p.id === peerId)?.displayName ?? 'Someone';

  const send = (event, payload) => {
    setPending(true);
    emit(event, { roomId: room.id, ...payload });
  };

  if (!isHost) {
    const mine = rooms.find((r) => r.peerIds.includes(self.id));
    return (
      <section className="cr cr-panel" aria-label="Breakout room">
        <header className="cr-panel__head">
          <span>Breakout</span>
          {onClose ? (
            <button type="button" className="cr-btn cr-btn--ghost" onClick={onClose}>
              Close
            </button>
          ) : null}
        </header>
        <div className="cr-panel__body">
          {mine ? (
            <div className="cr-breakout__room">
              <p style={{ margin: '0 0 6px' }}>You're in {mine.name}.</p>
              <ul className="cr-breakout__members">
                {mine.peerIds.map((id) => (
                  <li key={id} className="cr-chip">
                    {nameOf(id)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="cr-empty">The host hasn't opened breakout rooms yet.</p>
          )}
        </div>
        {mine?.canReturn ? (
          <div className="cr-panel__foot">
            <button
              type="button"
              className="cr-btn"
              onClick={() => emit(SignalingEvents.breakout.leave, { roomId: room.id })}
            >
              Back to the main room
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="cr cr-panel" aria-label="Breakout rooms">
      <header className="cr-panel__head">
        <span>
          Breakout rooms <span className="cr-count">{rooms.length}</span>
        </span>
        {onClose ? (
          <button type="button" className="cr-btn cr-btn--ghost" onClick={onClose}>
            Close
          </button>
        ) : null}
      </header>

      <div className="cr-panel__body">
        {rooms.length === 0 ? (
          <p className="cr-empty">
            Split the lesson into small groups. Everyone comes back when you recall them.
          </p>
        ) : null}

        {rooms.map((r) => (
          <div key={r.id} className="cr-breakout__room">
            <div className="cr-breakout__room-head">
              <strong>{r.name}</strong>
              <span className="cr-count">{r.peerIds.length}</span>
            </div>
            <ul className="cr-breakout__members">
              {r.peerIds.map((id) => (
                <li key={id} className="cr-chip">
                  {nameOf(id)}
                  <button
                    type="button"
                    aria-label={`Move ${nameOf(id)} back`}
                    onClick={() => send(SignalingEvents.breakout.assign, { peerId: id, toRoomId: null })}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}

        {unassigned.length ? (
          <div className="cr-breakout__room">
            <div className="cr-breakout__room-head">
              <strong>Still in the main room</strong>
              <span className="cr-count">{unassigned.length}</span>
            </div>
            <ul className="cr-breakout__members">
              {unassigned.map((p) => (
                <li key={p.id} className="cr-chip">
                  {p.displayName}
                  {rooms.length ? (
                    <select
                      aria-label={`Move ${p.displayName} to a room`}
                      defaultValue=""
                      onChange={(e) =>
                        send(SignalingEvents.breakout.assign, {
                          peerId: p.id,
                          toRoomId: e.target.value,
                        })
                      }
                    >
                      <option value="" disabled>
                        Move to…
                      </option>
                      {rooms.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="cr-panel__foot">
        <div className="cr-breakout__controls">
          <label>
            Rooms{' '}
            <input
              type="number"
              min={2}
              max={20}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              style={{ width: 56 }}
            />
          </label>
          <button
            type="button"
            className="cr-btn"
            disabled={pending}
            onClick={() => send(SignalingEvents.breakout.create, { count, assign: 'even' })}
          >
            {rooms.length ? 'Reshuffle' : 'Open rooms'}
          </button>
          <button
            type="button"
            className="cr-btn cr-btn--primary"
            disabled={pending || rooms.length === 0}
            onClick={() => send(SignalingEvents.breakout.recall, {})}
          >
            Bring everyone back
          </button>
        </div>

        {rooms.length ? (
          <form
            className="cr-breakout__broadcast"
            onSubmit={(e) => {
              e.preventDefault();
              const text = broadcast.trim();
              if (!text) return;
              send(SignalingEvents.breakout.broadcast, { text });
              setBroadcast('');
            }}
          >
            <input
              value={broadcast}
              onChange={(e) => setBroadcast(e.target.value)}
              placeholder="Message every room"
              aria-label="Message every room"
              maxLength={280}
            />
            <button type="submit" className="cr-btn">
              Send
            </button>
          </form>
        ) : null}
      </div>
    </section>
  );
}