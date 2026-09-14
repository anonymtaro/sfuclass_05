import { useCallback, useState } from 'react';
import { useClassroom, useScreenShare } from '@classroom/core-client';
import { SignalingEvents } from '@classroom/contracts';
import SourcePickerDialog from './SourcePickerDialog.jsx';
import './classroom.css';

/**
 * One button, three states, driven entirely by server truth.
 *
 *   idle            → opens SourcePickerDialog, then useScreenShare().start(opts)
 *   sharing (me)    → stop
 *   sharing (other) → "Ask to present", which emits screenShare.request; the
 *                     current presenter or the host answers with a handover.
 *
 * The presenter lock lives in server/src/classroom/ScreenShareManager.js. This
 * component never decides who may share — it only renders what the room says
 * and disables itself while a decision is in flight.
 */
export default function ScreenShareButton({ className = '' }) {
  const { self, emit } = useClassroom();
  const {
    isSupported,
    isSharing,
    presenter,
    lockedByOther,
    start,
    stop,
    error,
  } = useScreenShare();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);

  const isHost = self.role === 'host' || self.role === 'teacher';

  const handleStart = useCallback(
    async (options) => {
      setPickerOpen(false);
      setBusy(true);
      try {
        // start() performs the mediasoup produce() with appData.source = 'screen'
        // and only resolves once the SFU has acknowledged the producer.
        await start(options);
      } finally {
        setBusy(false);
      }
    },
    [start],
  );

  const handleStop = useCallback(async () => {
    setBusy(true);
    try {
      await stop();
    } finally {
      setBusy(false);
    }
  }, [stop]);

  const handleAsk = useCallback(() => {
    emit(SignalingEvents.screenShare.request, { peerId: self.id });
    setRequested(true);
    // The host's answer arrives as screenShare.state; the flag is only there to
    // stop someone hammering the request into the moderation queue.
    window.setTimeout(() => setRequested(false), 20_000);
  }, [emit, self.id]);

  if (!isSupported) {
    return (
      <button type="button" className={`cr cr-btn ${className}`} disabled title="This browser cannot capture a screen">
        Share screen
      </button>
    );
  }

  if (isSharing) {
    return (
      <button
        type="button"
        className={`cr cr-btn cr-btn--active ${className}`}
        onClick={handleStop}
        disabled={busy}
      >
        Stop sharing
      </button>
    );
  }

  if (lockedByOther && !isHost) {
    return (
      <button
        type="button"
        className={`cr cr-btn ${className}`}
        onClick={handleAsk}
        disabled={requested}
        title={`${presenter?.displayName ?? 'Someone'} is sharing`}
      >
        {requested ? 'Waiting for the presenter' : 'Ask to present'}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`cr cr-btn ${className}`}
        onClick={() => setPickerOpen(true)}
        disabled={busy}
        aria-haspopup="dialog"
      >
        {busy ? 'Starting…' : 'Share screen'}
      </button>

      {/* A host who shares while someone else is live takes the presenter slot;
          the server ends the previous producer and tells the room why. */}
      <SourcePickerDialog
        open={pickerOpen}
        takingOver={lockedByOther && isHost}
        currentPresenter={presenter}
        error={error}
        onCancel={() => setPickerOpen(false)}
        onConfirm={handleStart}
      />
    </>
  );
}