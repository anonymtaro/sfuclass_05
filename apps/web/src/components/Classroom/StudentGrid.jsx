import VideoTile from './VideoTile.jsx';

/**
 * The default layout: everybody the same size, self-view first.
 *
 * Peers without a camera track still get a tile. Somebody who joined with
 * their camera off is in the room and the layout should say so, rather than
 * making them invisible until they turn it on.
 */
export default function StudentGrid({
  peers,
  streams,
  selfPeerId,
  selfLabel,
  localVideoTrack,
  cameraEnabled,
}) {
  const videoByPeer = new Map(
    streams
      .filter((stream) => stream.kind === 'video' && stream.source === 'camera')
      .map((stream) => [stream.peerId, stream]),
  );

  const others = peers.filter((peer) => peer.peerId !== selfPeerId);

  return (
    <div className="grid" data-count={others.length + 1}>
      <VideoTile
        track={cameraEnabled ? localVideoTrack : null}
        label={`${selfLabel} (you)`}
        muted
        mirrored
      />

      {others.map((peer) => (
        <VideoTile
          key={peer.peerId}
          track={videoByPeer.get(peer.peerId)?.track ?? null}
          label={peer.user.displayName}
          handRaised={peer.handRaised}
        />
      ))}
    </div>
  );
}