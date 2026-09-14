import { useEffect, useRef, useState } from 'react';
import { getDeviceAdapter, useClassroom } from '@classroom/core-client';
import { SignalingEvents } from '@classroom/contracts';
import './classroom.css';

function waitedFor(since) {
  const secs = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m`;
}

/**
 * One component, two audiences, because it is one server state.
 *
 * A peer that joins a room with `waitingRoom` enabled is parked by
 * ModerationControls.js: no transports are created and no media flows until a
 * host admits them. Until then the client holds a *local* preview only — that
 * stream never reaches the SFU, so a person in the lobby cannot be seen or heard.
 *
 * The host side is the admit queue, with the same admit / deny events.
 */
export default function WaitingRoom() {
  const { room, self, waitingRoom, emit, connection } = useClassroom();
  const isHost = self.role === 'host' || self.role === 'teacher';

  if (isHost) return <AdmitQueue room={room} queue={waitingRoom} emit={emit} />;
  return <Lobby room={room} self={self} emit={emit} connection={connection} />;
}

function Lobby({ room, self, emit, connection }) {
  const videoRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let local = null;

    getDeviceAdapter()
      .getUserMedia({ video: true, audio: true })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        local = s;
        setStream(s);
      })
      .catch(() => setDenied(true));

    return () => {
      cancelled = true;
      local?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    if (videoRef.current && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream ?? null;
    }
  }, [stream]);

  // Toggles here are remembered and applied the moment the peer is admitted,
  // so nobody joins a lesson with a camera they thought they had turned off.
  const toggle = (kind) => {
    const track = kind === 'cam' ? stream?.getVideoTracks()[0] : stream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    if (kind === 'cam') setCamOn(track.enabled);
    else setMicOn(track.enabled);
    emit(SignalingEvents.waitingRoom.preferences, {
      roomId: room.id,
      camera: kind === 'cam' ? track.enabled : camOn,
      microphone: kind === 'mic' ? track.enabled : micOn,
    });
  };

  return (
    <div className="cr cr-waiting">
      <div className="cr-waiting__card">
        <h1 className="cr-waiting__title">
          {room.locked ? 'This lesson is locked' : 'Waiting for the host to let you in'}
        </h1>
        <p className="cr-note">
          {room.locked
            ? 'The host closed the room. Ask them to unlock it, then reload this page.'
            : `You'll join as ${self.displayName}. Check your camera and microphone while you wait.`}
        </p>

        {denied ? (
          <p className="cr-error">
            Your browser is blocking the camera and microphone. Allow them in the address bar to
            see yourself before joining.
          </p>
        ) : (
          <video ref={videoRef} className="cr-waiting__preview" autoPlay playsInline muted />
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className={`cr-btn${camOn ? ' cr-btn--active' : ''}`}
            onClick={() => toggle('cam')}
            disabled={!stream}
          >
            {camOn ? 'Camera on' : 'Camera off'}
          </button>
          <button
            type="button"
            className={`cr-btn${micOn ? ' cr-btn--active' : ''}`}
            onClick={() => toggle('mic')}
            disabled={!stream}
          >
            {micOn ? 'Microphone on' : 'Microphone off'}
          </button>
        </div>

        {connection.status !== 'connected' ? (
          <p className="cr-note">Reconnecting… you keep your place in the queue.</p>
        ) : null}
      </div>
    </div>
  );
}

function AdmitQueue({ room, queue, emit }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const admit = (peerId) => emit(SignalingEvents.moderation.admit, { roomId: room.id, peerId });
  const deny = (peerId) => emit(SignalingEvents.moderation.deny, { roomId: room.id, peerId });

  return (
    <section className="cr cr-panel" aria-label="Waiting room">
      <header className="cr-panel__head">
        <span>
          Waiting to join <span className="cr-count">{queue.length}</span>
        </span>
        {queue.length > 1 ? (
          <button
            type="button"
            className="cr-btn cr-btn--ghost"
            onClick={() => emit(SignalingEvents.moderation.admit, { roomId: room.id, all: true })}
          >
            Admit all
          </button>
        ) : null}
      </header>

      <div className="cr-panel__body">
        {queue.length === 0 ? (
          <p className="cr-empty">Nobody is waiting.</p>
        ) : (
          queue.map((person) => (
            <div key={person.id} className="cr-waiting__queue-item">
              <img className="cr-person__avatar" src={person.avatarUrl} alt="" />
              <span className="cr-person__main">
                <span className="cr-person__name">{person.displayName}</span>
                <span className="cr-person__meta">
                  {person.enrolled ? 'Enrolled' : 'Not on the roster'} · waiting{' '}
                  {waitedFor(person.knockedAt)}
                </span>
              </span>
              <button type="button" className="cr-btn cr-btn--primary" onClick={() => admit(person.id)}>
                Admit
              </button>
              <button type="button" className="cr-btn cr-btn--danger" onClick={() => deny(person.id)}>
                Deny
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}