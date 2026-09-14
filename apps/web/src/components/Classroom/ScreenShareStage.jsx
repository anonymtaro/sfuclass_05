import VideoTile from './VideoTile.jsx';

/**
 * Layout while somebody is sharing: the share takes the room, faces shrink to
 * a strip along the bottom.
 *
 * `object-fit: contain` on the share is deliberate — cropping a slide to fill
 * the frame cuts off exactly the text the share exists to show.
 */
export default function ScreenShareStage({
  screenShare,
  streams,
  peers,
  selfPeerId,
  selfLabel,
  localVideoTrack,
  cameraEnabled,
}) {
  const screenStream = streams.find(
    (stream) => stream.source === 'screen' && stream.peerId === screenShare.peerId,
  );

  const cameraStreams = streams.filter(
    (stream) => stream.kind === 'video' && stream.source === 'camera',
  );

  const isOwnShare = screenShare.peerId === selfPeerId;
  const presenterName = screenShare.user?.displayName ?? 'Someone';

  return (
    <div className="stage">
      <div className="stage__main">
        {isOwnShare ? (
          // Never render your own share back to yourself: it is a hall of
          // mirrors and it costs a decode for no benefit.
          <div className="stage__self-share">
            <p>You are sharing your screen.</p>
            {screenShare.label && <p className="stage__self-share-label">{screenShare.label}</p>}
          </div>
        ) : (
          <VideoTile
            track={screenStream?.track ?? null}
            label={`${presenterName} — ${screenShare.label ?? 'screen'}`}
            variant="stage"
          />
        )}
      </div>

      <div className="stage__strip">
        <VideoTile
          track={cameraEnabled ? localVideoTrack : null}
          label={`${selfLabel} (you)`}
          muted
          mirrored
          variant="strip"
        />
        {cameraStreams.map((stream) => (
          <VideoTile
            key={stream.consumerId}
            track={stream.track}
            label={
              peers.find((peer) => peer.peerId === stream.peerId)?.user.displayName ?? 'Participant'
            }
            variant="strip"
          />
        ))}
      </div>
    </div>
  );
}