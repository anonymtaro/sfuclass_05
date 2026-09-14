import { useEffect, useRef } from 'react';

/**
 * Attaches a MediaStream to a <video> or <audio> element and detaches it on
 * unmount, without re-assigning `srcObject` on every render.
 *
 * Re-assigning the same stream restarts decoding — in a 30-tile room that shows
 * up as a wave of black frames every time React re-renders the grid. The
 * identity check below is the whole point of this file.
 *
 *   const ref = useMediaStream(peer.streams.cam);
 *   <video ref={ref} autoPlay playsInline />
 */
export function useMediaStream(stream) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || el.srcObject === stream) return undefined;
    el.srcObject = stream ?? null;
    return () => {
      if (el) el.srcObject = null;
    };
  }, [stream]);

  return ref;
}

export default useMediaStream;