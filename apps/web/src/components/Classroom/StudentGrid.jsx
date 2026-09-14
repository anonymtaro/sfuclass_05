import { useEffect, useMemo, useRef, useState } from 'react';
import { useClassroom } from '@classroom/core-client';
import { useMediaStream } from './useMediaStream.js';
import './classroom.css';

/**
 * Tile count per page is a bandwidth decision, not a taste decision: every
 * rendered tile is a consumer the SFU has to send. 12 keeps a 30-person lesson
 * inside a normal home uplink.
 */
const PAGE_SIZE = 12;

function Tile({ peer, isSelf }) {
  const videoRef = useMediaStream(peer.streams.cam);
  const audioRef = useMediaStream(peer.streams.mic);

  return (
    <div
      className={`cr-tile${peer.isSpeaking ? ' cr-tile--speaking' : ''}`}
      data-role={peer.role}
    >
      {peer.streams.cam ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={isSelf ? { transform: 'scaleX(-1)' } : undefined}
        />
      ) : (
        <div className="cr-tile__placeholder">
          <img src={peer.avatarUrl} alt="" width={48} height={48} />
        </div>
      )}

      {isSelf ? null : <audio ref={audioRef} autoPlay />}

      <span className="cr-tile__badges" aria-hidden="true">
        {peer.handRaisedAt ? <span title="Hand up">✋</span> : null}
        {peer.producers.mic ? null : <span title="Muted">🔇</span>}
        {peer.producers.screen ? <span title="Sharing">🖥</span> : null}
      </span>

      <span className="cr-share-stage__name">
        {peer.displayName}
        {isSelf ? ' (you)' : ''}
      </span>
    </div>
  );
}

/**
 * The gallery. Rewritten in v6 so it no longer holds mediasoup consumers itself.
 *
 * The important line is `setVisiblePeers`: the grid tells the room which peers
 * are actually on screen, and SfuClient pauses the consumers for everyone else.
 * Without it, page 3 of a 40-person lesson still costs a full download of pages
 * 1 and 2. Hands raised and active speakers are floated to the front so the
 * people who matter are never the ones paused on another page.
 */
export default function StudentGrid({ pageSize = PAGE_SIZE, excludeIds = [] }) {
  const { peers, self, dominantSpeakerId, setVisiblePeers } = useClassroom();
  const [page, setPage] = useState(0);
  const containerRef = useRef(null);

  const ordered = useMemo(() => {
    const skip = new Set(excludeIds);
    return peers
      .filter((p) => !skip.has(p.id))
      .sort((a, b) => {
        const score = (p) =>
          (p.id === dominantSpeakerId ? 4 : 0) +
          (p.isSpeaking ? 2 : 0) +
          (p.handRaisedAt ? 1 : 0);
        return score(b) - score(a) || a.displayName.localeCompare(b.displayName);
      });
  }, [peers, excludeIds, dominantSpeakerId]);

  const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const visible = ordered.slice(current * pageSize, current * pageSize + pageSize);

  useEffect(() => {
    setVisiblePeers(visible.map((p) => p.id));
    // Leaving the grid entirely (a breakout, a full-screen share) releases them.
    return () => setVisiblePeers([]);
  }, [visible, setVisiblePeers]);

  // A browser tab in the background does not need 12 video decoders running.
  useEffect(() => {
    const onVisibility = () =>
      setVisiblePeers(document.visibilityState === 'visible' ? visible.map((p) => p.id) : []);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [visible, setVisiblePeers]);

  if (ordered.length === 0) {
    return <p className="cr cr-empty">Nobody else has joined yet.</p>;
  }

  return (
    <div className="cr cr-grid" ref={containerRef}>
      <div
        className="cr-grid__tiles"
        style={{ '--cr-tile-min': visible.length > 6 ? '160px' : '240px' }}
      >
        {visible.map((peer) => (
          <Tile key={peer.id} peer={peer} isSelf={peer.id === self.id} />
        ))}
      </div>

      {pageCount > 1 ? (
        <nav className="cr-grid__pager" aria-label="Participant pages">
          <button
            type="button"
            className="cr-btn cr-btn--ghost"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            Previous
          </button>
          <span className="cr-count">
            {current + 1} / {pageCount}
          </span>
          <button
            type="button"
            className="cr-btn cr-btn--ghost"
            disabled={current >= pageCount - 1}
            onClick={() => setPage(current + 1)}
          >
            Next
          </button>
        </nav>
      ) : null}
    </div>
  );
}