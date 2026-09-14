import { useMemo, useRef, useState } from 'react';
import { useClassroom, useScreenShare } from '@classroom/core-client';
import { useMediaStream } from './useMediaStream.js';
import { ReactionLayer } from './ReactionsBar.jsx';
import './classroom.css';

function StripTile({ peer }) {
  const ref = useMediaStream(peer.streams.cam);
  return (
    <div
      className={`cr-share-stage__tile${peer.isSpeaking ? ' cr-share-stage__tile--speaking' : ''}`}
    >
      {peer.streams.cam ? (
        <video ref={ref} autoPlay playsInline muted={peer.isSelf} />
      ) : (
        <img className="cr-person__avatar" src={peer.avatarUrl} alt="" width={30} height={30} />
      )}
      <span className="cr-share-stage__name">{peer.displayName}</span>
    </div>
  );
}

/**
 * The layout a room switches to while someone is sharing.
 *
 * The share is an ordinary consumer with appData.source === 'screen', so nothing
 * here is special-cased at the transport level — it is simply the producer that
 * gets the large box. Cameras drop to a strip, ordered by who is speaking, and
 * the presenter is pinned to the top of that strip so they stay reachable.
 *
 * Returns null when no share is live; the classroom page then falls back to
 * TeacherStage / StudentGrid.
 */
export default function ScreenShareStage({ maxStrip = 6 }) {
  const { peers, self, dominantSpeakerId } = useClassroom();
  const { presenter, isSharing, localStream } = useScreenShare();

  const [fill, setFill] = useState(false);
  const containerRef = useRef(null);

  const sharingPeer = useMemo(
    () => peers.find((p) => Boolean(p.streams.screen)) ?? null,
    [peers],
  );

  // A presenter watching their own share consumes the local track, not a
  // round-trip through the SFU.
  const shareStream = isSharing ? localStream : sharingPeer?.streams.screen;
  const shareRef = useMediaStream(shareStream);

  const strip = useMemo(() => {
    const rest = peers
      .filter((p) => p.id !== sharingPeer?.id)
      .sort((a, b) => {
        if (a.id === dominantSpeakerId) return -1;
        if (b.id === dominantSpeakerId) return 1;
        return Number(b.isSpeaking) - Number(a.isSpeaking);
      });
    const presenterPeer = peers.find((p) => p.id === sharingPeer?.id);
    return [presenterPeer, ...rest].filter(Boolean).slice(0, maxStrip);
  }, [peers, sharingPeer, dominantSpeakerId, maxStrip]);

  if (!shareStream) return null;

  const presenterName = isSharing
    ? 'You'
    : presenter?.displayName ?? sharingPeer?.displayName ?? 'A participant';

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  };

  return (
    <div className={`cr cr-share-stage${strip.length ? '' : ' cr-share-stage--strip-hidden'}`}>
      <div className="cr-share-stage__pin" ref={containerRef}>
        <video
          ref={shareRef}
          className={`cr-share-stage__video${fill ? ' cr-share-stage__video--fill' : ''}`}
          autoPlay
          playsInline
          muted={isSharing}
        />

        <p className="cr-share-stage__label">
          <span className="cr-share-stage__dot" aria-hidden="true" />
          {presenterName} is sharing
        </p>

        <div className="cr-share-stage__tools">
          <button
            type="button"
            className="cr-btn cr-btn--icon"
            aria-pressed={fill}
            onClick={() => setFill((v) => !v)}
            title={fill ? 'Show the whole screen' : 'Fill the window'}
          >
            {fill ? 'Fit' : 'Fill'}
          </button>
          <button type="button" className="cr-btn cr-btn--icon" onClick={toggleFullscreen}>
            Full screen
          </button>
        </div>

        {/* Emoji bursts float over the share, not over the chat history. */}
        <ReactionLayer />
      </div>

      {strip.length ? (
        <div className="cr-share-stage__strip" aria-label="Participants">
          {strip.map((peer) => (
            <StripTile key={peer.id} peer={{ ...peer, isSelf: peer.id === self.id }} />
          ))}
        </div>
      ) : null}
    </div>
  );
}