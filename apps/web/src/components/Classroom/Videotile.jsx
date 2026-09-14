import { useEffect, useRef } from 'react';

/**
 * Attaches one track to one media element.
 *
 * The element is never re-created on re-render, which is what stops a video
 * flashing black every time the peer list updates. React owns the props; the
 * effect owns `srcObject`, because a MediaStream is not something JSX can
 * express.
 */
export default function VideoTile({
  track,
  kind = 'video',
  label,
  muted = false,
  mirrored = false,
  speaking = false,
  handRaised = false,
  variant = 'grid',
}) {
  const ref = useRef(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !track) return undefined;

    const stream = new MediaStream([track]);
    element.srcObject = stream;

    // Autoplay is allowed for muted video and for audio the user started by
    // joining; a rejected play() is not worth surfacing.
    void element.play?.().catch(() => {});

    return () => {
      element.srcObject = null;
    };
  }, [track]);

  if (kind === 'audio') {
    return <audio ref={ref} autoPlay playsInline />;
  }

  return (
    <figure
      className={[
        'tile',
        `tile--${variant}`,
        speaking ? 'is-speaking' : '',
        track ? '' : 'is-empty',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {track ? (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted={muted}
          className={mirrored ? 'is-mirrored' : undefined}
        />
      ) : (
        <div className="tile__placeholder" aria-hidden="true">
          {label?.charAt(0).toUpperCase() ?? '?'}
        </div>
      )}

      <figcaption className="tile__label">
        {handRaised && <span className="tile__hand" aria-label="Hand raised">✋</span>}
        {label}
      </figcaption>
    </figure>
  );
}