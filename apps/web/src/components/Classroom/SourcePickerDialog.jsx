import { useEffect, useId, useRef, useState } from 'react';
import { getScreenShareAdapter } from '@classroom/core-client';
import './classroom.css';

const SURFACES = [
  {
    id: 'monitor',
    label: 'Whole screen',
    hint: 'Everything you see, including notifications',
  },
  {
    id: 'window',
    label: 'A window',
    hint: 'One app only — the safe choice',
  },
  {
    id: 'browser',
    label: 'A tab',
    hint: 'The only surface that can carry its own audio',
  },
];

/**
 * Chooses *what* to capture and *how* to encode it, then hands a plain options
 * object to ScreenShareAdapter (packages/core-client/src/rtc/ScreenShareAdapter.ts).
 *
 * On the web the browser still shows its own picker afterwards — this dialog sets
 * `displaySurface` as a preference and, more importantly, settles the two things
 * the browser never asks about: audio and the content hint. On mobile the same
 * options object drives ReplayKit / MediaProjection, so the flow stays identical.
 *
 * Defaults follow mediasoup.config.js: simulcast off, higher resolution, lower
 * frame rate, contentHint 'detail' — text stays readable instead of being spent
 * on motion.
 */
export default function SourcePickerDialog({
  open,
  takingOver = false,
  currentPresenter = null,
  error = null,
  onCancel,
  onConfirm,
}) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const adapter = getScreenShareAdapter();

  const [surface, setSurface] = useState('window');
  const [audio, setAudio] = useState(false);
  const [motion, setMotion] = useState(false);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // Tab audio is the only capture path most browsers allow; keep the checkbox
  // honest rather than letting it silently do nothing.
  const audioAvailable = adapter.supportsSystemAudio && surface === 'browser';
  useEffect(() => {
    if (!audioAvailable && audio) setAudio(false);
  }, [audioAvailable, audio]);

  const confirm = () => {
    onConfirm({
      surface,
      audio: audioAvailable && audio,
      contentHint: motion ? 'motion' : 'detail',
      frameRate: motion ? 30 : 5,
      maxHeight: 1080,
      simulcast: false,
    });
  };

  return (
    <dialog
      ref={dialogRef}
      className="cr cr-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <div className="cr-panel__head">
        <h2 id={titleId} style={{ margin: 0, fontSize: 15 }}>
          Share your screen
        </h2>
      </div>

      <div className="cr-dialog__body">
        {takingOver && currentPresenter ? (
          <p className="cr-note">
            {currentPresenter.displayName} is sharing right now. Starting yours ends theirs.
          </p>
        ) : null}

        <div className="cr-surface-grid" role="radiogroup" aria-label="What to share">
          {SURFACES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={surface === s.id}
              aria-pressed={surface === s.id}
              className="cr-surface"
              onClick={() => setSurface(s.id)}
            >
              <span>{s.label}</span>
              <span className="cr-surface__hint">{s.hint}</span>
            </button>
          ))}
        </div>

        <label className="cr-field">
          <input
            type="checkbox"
            checked={audio}
            disabled={!audioAvailable}
            onChange={(e) => setAudio(e.target.checked)}
          />
          <span>
            Share the audio too
            <span className="cr-field__hint">
              {audioAvailable
                ? 'Sent as a second track and mixed into the recording.'
                : 'Only available when you share a tab.'}
            </span>
          </span>
        </label>

        <label className="cr-field">
          <input type="checkbox" checked={motion} onChange={(e) => setMotion(e.target.checked)} />
          <span>
            I'm showing video or an animation
            <span className="cr-field__hint">
              Raises the frame rate and softens the text. Leave this off for slides and code.
            </span>
          </span>
        </label>

        {error ? (
          <p className="cr-error">
            {error.name === 'NotAllowedError'
              ? 'Your browser blocked the capture. Pick a source again to retry.'
              : 'The share could not start. Check screen recording permission and try again.'}
          </p>
        ) : null}
      </div>

      <div className="cr-dialog__foot">
        <button type="button" className="cr-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="cr-btn cr-btn--primary" onClick={confirm}>
          {takingOver ? 'Take over and share' : 'Share'}
        </button>
      </div>
    </dialog>
  );
}