/**
 * useScreenShare  (F1)
 *
 * Separate from useClassroom because sharing has its own lifecycle, its own
 * failure modes and its own UI, and folding it into the classroom hook would
 * mean every re-render of a participant tile re-evaluates share logic.
 *
 * Two things this hook exists to get right:
 *
 *   The presenter lock. Only one person shares at a time by default. The lock
 *   is held server-side, so `canShare` is derived from what the server told us,
 *   never from local optimism — a second teacher pressing the button at the
 *   same moment must lose cleanly, not fight over a local flag.
 *
 *   The stop that did not come from us. A browser ends a share from its own
 *   floating bar, iOS from Control Centre. SfuClient turns both into
 *   `localScreenShareEnded`, and forgetting to listen for it is the classic bug
 *   where the UI insists you are still sharing minutes after you stopped.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, type SignalingEvents } from '@classroom/contracts';
import type { SfuClient } from '../rtc/SfuClient.js';
import type { ScreenShareAdapter } from '../rtc/ScreenShareAdapter.js';
import { ScreenShareCancelledError } from '../rtc/ScreenShareAdapter.js';

/** Live encoder numbers, polled while sharing. Null until the first sample. */
export interface ScreenShareStats {
  bitrateKbps: number;
  frameRate: number;
  width: number;
  height: number;
}

export interface UseScreenShareOptions {
  sfu: SfuClient;
  adapter: ScreenShareAdapter;
  /** The peer id of the local user, to tell our share from someone else's. */
  selfPeerId: string | null;
  /** Poll interval for stats. 0 disables polling entirely. */
  statsIntervalMs?: number;
}

export interface UseScreenShareResult {
  /** This device is capable of sharing at all. */
  supported: boolean;
  /** We are the one sharing. */
  isSharing: boolean;
  /** Somebody else holds the lock. */
  remotePresenter: SignalingEvents.ScreenShareStarted | null;
  /** The button should be enabled. */
  canShare: boolean;
  starting: boolean;
  error: ApiError | null;
  stats: ScreenShareStats | null;
  start(options?: { withAudio?: boolean }): Promise<void>;
  stop(): Promise<void>;
  /** Clears an error after the user has read it. */
  dismissError(): void;
}

export const useScreenShare = (options: UseScreenShareOptions): UseScreenShareResult => {
  const { sfu, adapter, selfPeerId, statsIntervalMs = 3_000 } = options;

  const [isSharing, setIsSharing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [presenter, setPresenter] = useState<SignalingEvents.ScreenShareStarted | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [stats, setStats] = useState<ScreenShareStats | null>(null);

  const supported = adapter.isSupported();

  // -------------------------------------------------------------------------
  // Server truth
  // -------------------------------------------------------------------------

  useEffect(() => {
    const unsubscribers = [
      sfu.on('screenShareStarted', (event) => {
        setPresenter(event);
        if (event.peerId === selfPeerId) setIsSharing(true);
      }),

      sfu.on('screenShareStopped', (event) => {
        setPresenter((current) => (current?.peerId === event.peerId ? null : current));
        if (event.peerId === selfPeerId) {
          setIsSharing(false);
          setStats(null);
          // A host revoking the share is worth telling the user about; their
          // own stop is not.
          if (event.reason === 'revoked') {
            setError(
              new ApiError('forbidden', { detail: 'The host stopped your screen share.' }),
            );
          }
        }
      }),

      // Covers the browser's stop bar, a lost display, and a reconnect that
      // could not restore the capture.
      sfu.on('localScreenShareEnded', (reason) => {
        setIsSharing(false);
        setStats(null);
        if (reason === 'reconnected') {
          setError(
            new ApiError('dependency_unavailable', {
              detail: 'Sharing stopped while reconnecting. Start it again when you are ready.',
            }),
          );
        }
      }),

      sfu.on('closed', () => {
        setIsSharing(false);
        setPresenter(null);
        setStats(null);
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [sfu, selfPeerId]);

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!isSharing || statsIntervalMs <= 0) return;

    let lastBytes = 0;
    let lastAt = Date.now();
    let cancelled = false;

    const poll = async () => {
      const producer = sfu.localProducers.screen;
      if (!producer) return;
      try {
        const report = await producer.getStats();
        for (const entry of report.values() as Iterable<Record<string, number | string>>) {
          if (entry.type !== 'outbound-rtp') continue;
          const bytes = Number(entry.bytesSent ?? 0);
          const now = Date.now();
          const elapsed = (now - lastAt) / 1000;
          if (lastBytes > 0 && elapsed > 0 && !cancelled) {
            setStats({
              bitrateKbps: Math.round(((bytes - lastBytes) * 8) / 1000 / elapsed),
              frameRate: Math.round(Number(entry.framesPerSecond ?? 0)),
              width: Number(entry.frameWidth ?? 0),
              height: Number(entry.frameHeight ?? 0),
            });
          }
          lastBytes = bytes;
          lastAt = now;
        }
      } catch {
        // Stats are diagnostics. A failure here must never affect the share.
      }
    };

    const timer = setInterval(() => void poll(), statsIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isSharing, sfu, statsIntervalMs]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const start = useCallback(
    async (startOptions: { withAudio?: boolean } = {}) => {
      if (starting || isSharing) return;
      setStarting(true);
      setError(null);
      try {
        await sfu.startScreenShare(startOptions);
        setIsSharing(true);
      } catch (cause) {
        // A dismissed picker is a decision, not a failure. Showing an error for
        // it trains people to ignore errors.
        if (cause instanceof ScreenShareCancelledError) return;
        setError(
          ApiError.is(cause)
            ? cause
            : new ApiError('internal_error', {
                detail: cause instanceof Error ? cause.message : 'Screen sharing failed',
              }),
        );
      } finally {
        setStarting(false);
      }
    },
    [sfu, starting, isSharing],
  );

  const stop = useCallback(async () => {
    await sfu.stopScreenShare('user');
    setIsSharing(false);
    setStats(null);
  }, [sfu]);

  const canShare = useMemo(() => {
    if (!supported || starting) return false;
    if (isSharing) return true; // the button becomes "Stop"
    // Someone else holds the lock.
    return presenter === null;
  }, [supported, starting, isSharing, presenter]);

  return {
    supported,
    isSharing,
    remotePresenter: presenter && presenter.peerId !== selfPeerId ? presenter : null,
    canShare,
    starting,
    error,
    stats,
    start,
    stop,
    dismissError: () => setError(null),
  };
};