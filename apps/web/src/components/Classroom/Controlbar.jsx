/**
 * The controls along the bottom of a lesson.
 *
 * Every button reflects state the server confirmed, not what the user clicked:
 * useClassroom rolls an optimistic toggle back if the ack fails, so a mute that
 * the server rejected does not leave the button lying about it.
 */
export default function ControlBar({
  microphoneEnabled,
  cameraEnabled,
  handRaised,
  isScreenSharing,
  canScreenShare,
  screenTakenBy,
  onToggleMicrophone,
  onToggleCamera,
  onToggleHand,
  onToggleScreenShare,
  onReact,
  onLeave,
}) {
  // Disabled rather than hidden: a button that vanishes teaches nothing, a
  // disabled one with a title says who has the lock.
  const shareBlocked = Boolean(screenTakenBy) && !isScreenSharing;

  return (
    <footer className="controls">
      <button
        type="button"
        className={microphoneEnabled ? 'btn' : 'btn btn--off'}
        onClick={onToggleMicrophone}
        aria-pressed={!microphoneEnabled}
      >
        {microphoneEnabled ? 'Mute' : 'Unmute'}
      </button>

      <button
        type="button"
        className={cameraEnabled ? 'btn' : 'btn btn--off'}
        onClick={onToggleCamera}
        aria-pressed={!cameraEnabled}
      >
        {cameraEnabled ? 'Stop video' : 'Start video'}
      </button>

      <button
        type="button"
        className={handRaised ? 'btn btn--active' : 'btn'}
        onClick={onToggleHand}
        aria-pressed={handRaised}
      >
        {handRaised ? 'Lower hand' : 'Raise hand'}
      </button>

      {canScreenShare && (
        <button
          type="button"
          className={isScreenSharing ? 'btn btn--active' : 'btn'}
          onClick={onToggleScreenShare}
          disabled={shareBlocked}
          title={shareBlocked ? `${screenTakenBy} is sharing` : undefined}
        >
          {isScreenSharing ? 'Stop sharing' : 'Share screen'}
        </button>
      )}

      <div className="controls__reactions">
        {['👏', '👍', '❓', '🎉'].map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="btn btn--icon"
            onClick={() => onReact(emoji)}
            aria-label={`React ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>

      <button type="button" className="btn btn--danger" onClick={onLeave}>
        Leave
      </button>
    </footer>
  );
}