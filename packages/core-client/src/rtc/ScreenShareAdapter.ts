/**
 * Screen capture  (F1)
 *
 * Screen sharing is the one media source with genuinely different mechanics per
 * platform, which is why it gets its own adapter rather than a flag on
 * DeviceAdapter:
 *
 *   browser   navigator.mediaDevices.getDisplayMedia — the picker is the
 *             browser's own, and the user may stop the share from a browser
 *             UI this code never sees
 *   iOS       a ReplayKit broadcast extension, which is a separate process;
 *             starting it opens a system sheet and the app cannot cancel it
 *   Android   MediaProjection, which requires a foreground service and a
 *             system consent dialog per session
 *
 * What they share is small and is exactly what this interface exposes: ask for
 * a capture, receive a track, learn when it ended. `SfuClient` publishes that
 * track as a second producer tagged `source: 'screen'` — never as a second
 * connection.
 *
 * The mobile implementation lives in apps/mobile/src/native/screenShareAdapter.ts.
 */

import type { MediaStreamLike, MediaStreamTrackLike } from './DeviceAdapter.js';

// ---------------------------------------------------------------------------
// Options and handle
// ---------------------------------------------------------------------------

export interface ScreenShareOptions {
  /**
   * Tab or system audio alongside the video. Browser support is uneven — Chrome
   * offers it for a tab, Firefox does not offer it at all — so a caller must
   * treat a missing audio track as normal rather than as a failure.
   */
  withAudio?: boolean;
  /** Capped rather than requested exactly; the source decides what it can give. */
  maxHeight?: number;
  maxFrameRate?: number;
  /**
   * 'detail' tells the encoder that sharp text matters more than smooth motion.
   * 'motion' is right when someone is sharing a video, and almost never
   * otherwise.
   */
  contentHint?: 'detail' | 'text' | 'motion';
  /** Hides the local window from its own capture, where supported. */
  selfBrowserSurface?: 'include' | 'exclude';
}

export interface ScreenShareHandle {
  stream: MediaStreamLike;
  videoTrack: MediaStreamTrackLike;
  /** Null whenever audio was not requested, not offered, or not granted. */
  audioTrack: MediaStreamTrackLike | null;
  /**
   * What is being shared, for the participant list: 'Entire screen',
   * 'Slides.key', 'Tab: docs'. The browser rarely tells us, so this is often a
   * generic label.
   */
  label: string;
  /**
   * Fires when the capture ends for any reason, including the user pressing the
   * browser's own "Stop sharing" bar. Missing this listener is the classic
   * screen-share bug: the UI keeps claiming a share that stopped minutes ago.
   */
  onEnded(listener: (reason: ScreenShareEndReason) => void): () => void;
  stop(): void;
}

export type ScreenShareEndReason = 'user' | 'platform' | 'revoked' | 'error';

export interface ScreenShareAdapter {
  readonly platform: 'web' | 'ios' | 'android';
  /** False on iOS below 14, in an insecure context, and inside most webviews. */
  isSupported(): boolean;
  /**
   * Opens the platform picker and resolves once the user has chosen. Rejects
   * with a `cancelled` error when they dismiss it — which is a normal outcome,
   * not an error to report.
   */
  start(options?: ScreenShareOptions): Promise<ScreenShareHandle>;
}

export class ScreenShareCancelledError extends Error {
  constructor() {
    super('The user dismissed the screen share picker');
    this.name = 'ScreenShareCancelledError';
  }
}

export class ScreenShareUnsupportedError extends Error {
  constructor(detail = 'Screen sharing is not available on this device') {
    super(detail);
    this.name = 'ScreenShareUnsupportedError';
  }
}

export const DEFAULT_SCREEN_SHARE_OPTIONS: Required<
  Pick<ScreenShareOptions, 'maxHeight' | 'maxFrameRate' | 'contentHint'>
> = {
  maxHeight: 1080,
  // Low on purpose. Fifteen frames of readable text beat thirty of mush, and
  // it matches SCREENSHARE_MAX_FRAMERATE on the server.
  maxFrameRate: 15,
  contentHint: 'detail',
};

// ---------------------------------------------------------------------------
// Browser implementation
// ---------------------------------------------------------------------------

interface DisplayMediaProvider {
  getDisplayMedia?(constraints: unknown): Promise<unknown>;
}

interface BrowserScreenShareOptions {
  /** Injectable for tests; defaults to navigator.mediaDevices. */
  mediaDevices?: DisplayMediaProvider;
}

export const createBrowserScreenShareAdapter = (
  options: BrowserScreenShareOptions = {},
): ScreenShareAdapter => {
  const mediaDevices =
    options.mediaDevices ??
    ((globalThis as unknown as { navigator?: { mediaDevices?: DisplayMediaProvider } }).navigator
      ?.mediaDevices as DisplayMediaProvider | undefined);

  const isSupported = (): boolean => typeof mediaDevices?.getDisplayMedia === 'function';

  return {
    platform: 'web',
    isSupported,

    async start(userOptions: ScreenShareOptions = {}): Promise<ScreenShareHandle> {
      if (!isSupported() || !mediaDevices?.getDisplayMedia) {
        throw new ScreenShareUnsupportedError(
          'This browser cannot share a screen. Chrome, Edge, Firefox and Safari 13+ can.',
        );
      }

      const settings = { ...DEFAULT_SCREEN_SHARE_OPTIONS, ...userOptions };

      let stream: MediaStreamLike;
      try {
        stream = (await mediaDevices.getDisplayMedia({
          video: {
            height: { max: settings.maxHeight },
            frameRate: { max: settings.maxFrameRate },
          },
          // Requesting audio the browser will not give is harmless; requesting
          // it and then treating its absence as a failure is not.
          audio: userOptions.withAudio ?? false,
          selfBrowserSurface: userOptions.selfBrowserSurface ?? 'exclude',
          // Nudges Chrome's picker toward the tab list, which is what people
          // usually want when they are teaching from slides.
          surfaceSwitching: 'include',
          systemAudio: userOptions.withAudio ? 'include' : 'exclude',
        })) as MediaStreamLike;
      } catch (cause) {
        // Chrome and Firefox both report a dismissed picker as NotAllowedError,
        // indistinguishable from a denied permission. Treating it as a
        // cancellation is the kinder default: nothing is broken.
        const name = (cause as { name?: string })?.name;
        if (name === 'NotAllowedError' || name === 'AbortError') {
          throw new ScreenShareCancelledError();
        }
        throw cause;
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) {
        throw new ScreenShareUnsupportedError('The capture produced no video track');
      }

      // The hint has to be set on the track, before it is published.
      if ('contentHint' in videoTrack) {
        videoTrack.contentHint = settings.contentHint;
      }

      const audioTrack = stream.getAudioTracks()[0] ?? null;

      const label = describeSurface(videoTrack);
      const listeners = new Set<(reason: ScreenShareEndReason) => void>();
      let ended = false;

      const finish = (reason: ScreenShareEndReason) => {
        if (ended) return;
        ended = true;
        for (const listener of listeners) listener(reason);
        listeners.clear();
      };

      // The browser's own stop bar ends the track without telling anyone else.
      videoTrack.addEventListener?.('ended', () => finish('user'));

      return {
        stream,
        videoTrack,
        audioTrack,
        label,

        onEnded(listener) {
          if (ended) {
            listener('user');
            return () => undefined;
          }
          listeners.add(listener);
          return () => listeners.delete(listener);
        },

        stop() {
          for (const track of stream.getTracks()) {
            try {
              track.stop();
            } catch {
              // Already stopped by the browser.
            }
          }
          finish('user');
        },
      };
    },
  };
};

/**
 * Best-effort description of what was picked. `displaySurface` is the only
 * standard signal, and the track label is browser-specific, so this stays
 * generic rather than guessing wrong.
 */
const describeSurface = (track: MediaStreamTrackLike): string => {
  const surface = track.getSettings?.().displaySurface as string | undefined;
  switch (surface) {
    case 'monitor':
      return 'Entire screen';
    case 'window':
      return 'Application window';
    case 'browser':
      return 'Browser tab';
    default:
      return 'Screen';
  }
};

// ---------------------------------------------------------------------------
// Null implementation
// ---------------------------------------------------------------------------

/**
 * For platforms that cannot capture at all. Returning this instead of leaving
 * the adapter undefined means callers have one code path: ask `isSupported()`
 * and hide the button, rather than checking for null everywhere.
 */
export const createUnsupportedScreenShareAdapter = (
  platform: ScreenShareAdapter['platform'],
): ScreenShareAdapter => ({
  platform,
  isSupported: () => false,
  async start(): Promise<ScreenShareHandle> {
    throw new ScreenShareUnsupportedError();
  },
});