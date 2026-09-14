import { useMemo } from 'react';
import { useClassroom } from '@classroom/core-client';
import { useMediaStream } from './useMediaStream.js';
import { ReactionLayer } from './ReactionsBar.jsx';
import './classroom.css';

const QUALITY_LABEL = {
  good: null,
  fair: 'Connection is unsteady',
  poor: 'Poor connection — video paused',
};

/**
 * The big box when nobody is sharing a screen.
 *
 * Who gets the box, in order: the peer the host has pinned, then the host or
 * teacher, then the dominant speaker. That order is computed here and nowhere
 * else — ScreenShareStage takes over the whole layout the moment a producer
 * with appData.source === 'screen' appears, so the two never fight.
 *
 * Rewritten in v6 to read from useClassroom() instead of holding its own
 * mediasoup consumers, so the mobile ClassroomScreen can mirror it exactly.
 */
export default function TeacherStage() {
  const { peers, self, room, dominantSpeakerId } = useClassroom();

  const stage = useMemo(() => {
    const pinned = room.pinnedPeerId && peers.find((p) => p.id === room.pinnedPeerId);
    if (pinned) return pinned;
    const host = peers.find((p) => p.role === 'host' || p.role === 'teacher');
    if (host) return host;
    return peers.find((p) => p.id === dominantSpeakerId) ?? peers[0] ?? null;
  }, [peers, room.pinnedPeerId, dominantSpeakerId]);

  const videoRef = useMediaStream(stage?.streams.cam);
  const audioRef = useMediaStream(stage?.streams.mic);

  if (!stage) {
    return (
      <div className="cr cr-share-stage__pin" style={{ display: 'grid', placeItems: 'center' }}>
        <p className="cr-empty">Waiting for the lesson to start.</p>
      </div>
    );
  }

  const isSelf = stage.id === self.id;
  const quality = QUALITY_LABEL[stage.connectionQuality] ?? null;

  return (
    <div className="cr cr-share-stage__pin">
      {stage.streams.cam ? (
        <video
          ref={videoRef}
          className="cr-share-stage__video cr-share-stage__video--fill"
          autoPlay
          playsInline
          muted
          style={isSelf ? { transform: 'scaleX(-1)' } : undefined}
        />
      ) : (
        <div style={{ display: 'grid', placeItems: 'center', height: '100%', background: '#000' }}>
          <img
            src={stage.avatarUrl}
            alt=""
            width={96}
            height={96}
            style={{ borderRadius: '50%' }}
          />
        </div>
      )}

      {/* Remote audio is its own element: a camera that is off must not take the
          voice with it. The local peer is never played back to itself. */}
      {isSelf ? null : <audio ref={audioRef} autoPlay />}

      <p className="cr-share-stage__label">
        {stage.isSpeaking ? <span className="cr-share-stage__dot" aria-hidden="true" /> : null}
        {stage.displayName}
        {isSelf ? ' (you)' : ''}
        {stage.producers.mic ? '' : ' · muted'}
        {stage.handRaisedAt ? ' · hand up' : ''}
      </p>

      {quality ? (
        <p className="cr-share-stage__label" style={{ insetBlockStart: 'auto', insetBlockEnd: 10 }}>
          {quality}
        </p>
      ) : null}

      <ReactionLayer />
    </div>
  );
}