import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useClassroom, useCore } from '@classroom/core-client';

import { useSfuClient } from '../lib/useSfuClient.js';
import StudentGrid from '../components/Classroom/StudentGrid.jsx';
import ScreenShareStage from '../components/Classroom/ScreenShareStage.jsx';
import ControlBar from '../components/Classroom/ControlBar.jsx';
import ParticipantList from '../components/Classroom/ParticipantList.jsx';
import VideoTile from '../components/Classroom/VideoTile.jsx';

/**
 * Classroom  (F1)
 *
 * Sits outside AppLayout deliberately: no nav, no chat dock, nothing competing
 * with the lesson for the screen.
 *
 * This page renders; it does not decide. Every media decision belongs to
 * SfuClient, every piece of state to useClassroom. If a rule appears here, it
 * is in the wrong file.
 */
export default function ClassroomPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { session, status } = useCore();

  const { sfu, deviceAdapter, screenShareAdapter } = useSfuClient();
  const [reactions, setReactions] = useState([]);
  const [showParticipants, setShowParticipants] = useState(true);

  const classroom = useClassroom({
    sfu,
    deviceAdapter,
    roomId,
    // Nothing is attempted until there is a session; joining anonymously would
    // only fail the socket handshake.
    autoJoin: status === 'authenticated',
    // Above ten people, arriving unmuted is a room full of keyboard noise.
    startMuted: true,
    onReaction: ({ peerId, emoji }) => {
      const id = `${peerId}-${Date.now()}-${Math.random()}`;
      setReactions((current) => [...current, { id, emoji }]);
      // Ephemeral by design: the burst clears itself and never touches history.
      setTimeout(() => setReactions((current) => current.filter((r) => r.id !== id)), 3_000);
    },
  });

  const {
    status: connection,
    peers,
    streams,
    screenShare,
    selfPeerId,
    selfRole,
    cameraEnabled,
    microphoneEnabled,
    handRaised,
    error,
    actions,
    localVideoTrack,
  } = classroom;

  const handleLeave = useCallback(async () => {
    await actions.leave();
    navigate('/');
  }, [actions, navigate]);

  const isScreenSharing = screenShare?.peerId === selfPeerId;

  const handleToggleScreenShare = useCallback(async () => {
    if (isScreenSharing) await sfu.stopScreenShare('user');
    else await sfu.startScreenShare({ withAudio: false });
  }, [isScreenSharing, sfu]);

  // Closing the tab must still release the seat and the presenter lock, or the
  // room keeps a ghost participant and nobody else can share.
  useEffect(() => {
    const onHide = () => void sfu.leave();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [sfu]);

  if (status === 'restoring') {
    return (
      <main className="room room--pending">
        <p>Checking your session…</p>
      </main>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: `/rooms/${roomId}` }} />;
  }

  if (connection === 'idle' || connection === 'resolving' || connection === 'connecting') {
    return (
      <main className="room room--pending">
        <p>Joining the lesson…</p>
      </main>
    );
  }

  if (error && connection === 'closed') {
    return (
      <main className="room room--pending">
        <h1>Could not join</h1>
        <p>{error.detail ?? error.message}</p>
        <button type="button" className="btn" onClick={() => actions.join()}>
          Try again
        </button>
        <button type="button" className="btn btn--danger" onClick={() => navigate('/')}>
          Back
        </button>
      </main>
    );
  }

  const selfLabel = session?.displayName ?? 'You';
  const canModerate = selfRole === 'host' || selfRole === 'cohost';
  const audioStreams = streams.filter((stream) => stream.kind === 'audio');

  return (
    <main className="room">
      <header className="room__header">
        <h1 className="room__title">Lesson</h1>
        <span className={`badge badge--${connection}`}>{connection}</span>
        <button
          type="button"
          className="btn btn--tiny"
          onClick={() => setShowParticipants((visible) => !visible)}
        >
          {peers.length} participant{peers.length === 1 ? '' : 's'}
        </button>
      </header>

      {connection === 'reconnecting' && (
        <p className="banner banner--warn">
          Connection lost — moving this session to another server.
        </p>
      )}
      {error && connection !== 'closed' && (
        <p className="banner banner--warn">{error.detail ?? error.message}</p>
      )}

      <div className="room__body">
        <section className="room__stage">
          {screenShare ? (
            <ScreenShareStage
              screenShare={screenShare}
              streams={streams}
              peers={peers}
              selfPeerId={selfPeerId}
              selfLabel={selfLabel}
              localVideoTrack={localVideoTrack}
              cameraEnabled={cameraEnabled}
            />
          ) : (
            <StudentGrid
              peers={peers}
              streams={streams}
              selfPeerId={selfPeerId}
              selfLabel={selfLabel}
              localVideoTrack={localVideoTrack}
              cameraEnabled={cameraEnabled}
            />
          )}

          {reactions.length > 0 && (
            <div className="reactions" aria-live="polite">
              {reactions.map((reaction) => (
                <span key={reaction.id} className="reactions__burst">
                  {reaction.emoji}
                </span>
              ))}
            </div>
          )}
        </section>

        {showParticipants && (
          <ParticipantList
            peers={peers}
            selfPeerId={selfPeerId}
            canModerate={canModerate}
            onHostAction={actions.hostAction}
          />
        )}
      </div>

      {/* Remote audio is played, never displayed. One element per track, so a
          single peer dropping does not interrupt everybody else's audio. */}
      {audioStreams.map((stream) => (
        <VideoTile key={stream.consumerId} track={stream.track} kind="audio" />
      ))}

      <ControlBar
        microphoneEnabled={microphoneEnabled}
        cameraEnabled={cameraEnabled}
        handRaised={handRaised}
        isScreenSharing={isScreenSharing}
        canScreenShare={screenShareAdapter.isSupported()}
        screenTakenBy={
          screenShare && !isScreenSharing ? (screenShare.user?.displayName ?? 'Someone') : null
        }
        onToggleMicrophone={actions.toggleMicrophone}
        onToggleCamera={actions.toggleCamera}
        onToggleHand={() => actions.raiseHand(!handRaised)}
        onToggleScreenShare={handleToggleScreenShare}
        onReact={actions.react}
        onLeave={handleLeave}
      />
    </main>
  );
}