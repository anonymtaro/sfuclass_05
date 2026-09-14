/**
 * Device abstraction  (F1, F5)
 *
 * The browser and React Native disagree about almost everything below the
 * mediasoup API: how a camera is opened, what a MediaStream is, whether device
 * enumeration exists, how permissions are requested, and whether an audio
 * session has to be configured before playback works at all.
 *
 * `SfuClient` must not know any of that. It talks to this interface, and two
 * implementations satisfy it:
 *
 *   createBrowserDeviceAdapter()          here, for apps/web
 *   apps/mobile/src/native/rtcAdapter.ts  react-native-webrtc
 *
 * The structural types below are deliberate. Typing against lib.dom would make
 * this package unusable from React Native, and typing against
 * react-native-webrtc would make it unusable from the browser. What both
 * runtimes genuinely share is described here and nothing more.
 */

import type { types as MediasoupTypes } from 'mediasoup-client';

// ---------------------------------------------------------------------------
// Structural media types — the common subset of both runtimes
// ---------------------------------------------------------------------------

export interface MediaStreamTrackLike {
  readonly id: string;
  readonly kind: string;
  enabled: boolean;
  readonly readyState: string;
  stop(): void;
  addEventListener?(type: 'ended', listener: () => void): void;
  removeEventListener?(type: 'ended', listener: () => void): void;
  /** Browser only; React Native ignores it. */
  contentHint?: string;
  getSettings?(): Record<string, unknown>;
  applyConstraints?(constraints: unknown): Promise<void>;
}

export interface MediaStreamLike {
  readonly id: string;
  getTracks(): MediaStreamTrackLike[];
  getAudioTracks(): MediaStreamTrackLike[];
  getVideoTracks(): MediaStreamTrackLike[];
  addTrack?(track: MediaStreamTrackLike): void;
  removeTrack?(track: MediaStreamTrackLike): void;
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

export type DevicePlatform = 'web' | 'ios' | 'android';
export type MediaDeviceKind = 'audioinput' | 'audiooutput' | 'videoinput';

export interface MediaDeviceInfoLike {
  deviceId: string;
  kind: MediaDeviceKind;
  label: string;
  /** Front camera on mobile, or the default input on a laptop. */
  isDefault?: boolean;
}

export interface CaptureConstraints {
  audio?: boolean | { deviceId?: string; echoCancellation?: boolean; noiseSuppression?: boolean };
  video?:
    | boolean
    | {
        deviceId?: string;
        width?: number;
        height?: number;
        frameRate?: number;
        /** Mobile only; ignored in the browser. */
        facingMode?: 'user' | 'environment';
      };
}

export interface PermissionResult {
  camera: 'granted' | 'denied' | 'prompt' | 'unavailable';
  microphone: 'granted' | 'denied' | 'prompt' | 'unavailable';
}

/**
 * What this device can actually do. Read once at join time and used to decide
 * which controls to render — a phone that cannot share its screen should not
 * show the button and then fail.
 */
export interface DeviceCapabilities {
  canScreenShare: boolean;
  canSwitchCamera: boolean;
  canSelectAudioOutput: boolean;
  canEnumerateDevices: boolean;
  /** Simulcast is disabled on devices where the encoder cannot sustain it. */
  supportsSimulcast: boolean;
  maxVideoHeight: number;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface DeviceAdapter {
  readonly platform: DevicePlatform;
  readonly capabilities: DeviceCapabilities;

  /**
   * Builds the mediasoup Device. React Native passes its own handlerFactory
   * here, which is the single reason this cannot be constructed centrally.
   */
  createMediasoupDevice(): MediasoupTypes.Device;

  requestPermissions(need: { camera: boolean; microphone: boolean }): Promise<PermissionResult>;
  getUserMedia(constraints: CaptureConstraints): Promise<MediaStreamLike>;
  enumerateDevices(): Promise<MediaDeviceInfoLike[]>;

  /** Mobile flips between front and back; a laptop reopens with a device id. */
  switchCamera(currentTrack: MediaStreamTrackLike): Promise<MediaStreamTrackLike>;
  /** Speaker vs earpiece on mobile, output device in Chrome. Optional. */
  setAudioOutput?(deviceId: string): Promise<void>;

  /**
   * Configures the platform audio session: speakerphone routing, ducking,
   * staying alive when the screen locks. A no-op in the browser.
   */
  configureAudioSession?(mode: 'call' | 'playback' | 'idle'): Promise<void>;

  /** Fires when a camera or headset is plugged in or removed. */
  onDeviceChange(listener: () => void): () => void;

  /** Stops every track. Forgetting this leaves the camera light on. */
  releaseStream(stream: MediaStreamLike): void;
}

// ---------------------------------------------------------------------------
// Browser implementation
// ---------------------------------------------------------------------------

interface BrowserAdapterOptions {
  /** Lets tests inject a fake, and keeps this file free of global lookups. */
  mediaDevices?: {
    getUserMedia(constraints: unknown): Promise<unknown>;
    enumerateDevices(): Promise<unknown[]>;
    addEventListener?(type: string, listener: () => void): void;
    removeEventListener?(type: string, listener: () => void): void;
  };
  DeviceCtor?: new () => MediasoupTypes.Device;
  maxVideoHeight?: number;
}

export const createBrowserDeviceAdapter = (
  options: BrowserAdapterOptions = {},
): DeviceAdapter => {
  const mediaDevices =
    options.mediaDevices ??
    (globalThis as unknown as { navigator?: { mediaDevices?: never } }).navigator?.mediaDevices;

  if (!mediaDevices) {
    throw new Error('navigator.mediaDevices is unavailable — is this a secure context?');
  }

  const DeviceCtor = options.DeviceCtor;
  const maxVideoHeight = options.maxVideoHeight ?? 720;

  const capabilities: DeviceCapabilities = {
    canScreenShare: typeof (mediaDevices as { getDisplayMedia?: unknown }).getDisplayMedia === 'function',
    // Reopening with a different deviceId, rather than a real flip.
    canSwitchCamera: true,
    canSelectAudioOutput:
      typeof (globalThis as { HTMLMediaElement?: { prototype?: object } }).HTMLMediaElement
        ?.prototype === 'object' && 'setSinkId' in (HTMLMediaElement.prototype as object),
    canEnumerateDevices: typeof mediaDevices.enumerateDevices === 'function',
    supportsSimulcast: true,
    maxVideoHeight,
  };

  return {
    platform: 'web',
    capabilities,

    createMediasoupDevice(): MediasoupTypes.Device {
      if (!DeviceCtor) {
        throw new Error(
          'Pass DeviceCtor from mediasoup-client; core-client does not import it at runtime',
        );
      }
      return new DeviceCtor();
    },

    async requestPermissions(need): Promise<PermissionResult> {
      // The only portable way to ask is to open the devices and close them
      // again. The Permissions API is not implemented consistently enough.
      try {
        const stream = (await mediaDevices.getUserMedia({
          audio: need.microphone,
          video: need.camera,
        })) as MediaStreamLike;
        for (const track of stream.getTracks()) track.stop();
        return {
          camera: need.camera ? 'granted' : 'prompt',
          microphone: need.microphone ? 'granted' : 'prompt',
        };
      } catch {
        return {
          camera: need.camera ? 'denied' : 'prompt',
          microphone: need.microphone ? 'denied' : 'prompt',
        };
      }
    },

    async getUserMedia(constraints: CaptureConstraints): Promise<MediaStreamLike> {
      const video =
        typeof constraints.video === 'object'
          ? {
              deviceId: constraints.video.deviceId
                ? { exact: constraints.video.deviceId }
                : undefined,
              width: constraints.video.width ? { ideal: constraints.video.width } : undefined,
              height: { ideal: constraints.video.height ?? maxVideoHeight },
              frameRate: { ideal: constraints.video.frameRate ?? 30 },
            }
          : constraints.video;

      const audio =
        typeof constraints.audio === 'object'
          ? {
              deviceId: constraints.audio.deviceId
                ? { exact: constraints.audio.deviceId }
                : undefined,
              echoCancellation: constraints.audio.echoCancellation ?? true,
              noiseSuppression: constraints.audio.noiseSuppression ?? true,
              autoGainControl: true,
            }
          : constraints.audio;

      return (await mediaDevices.getUserMedia({ audio, video })) as MediaStreamLike;
    },

    async enumerateDevices(): Promise<MediaDeviceInfoLike[]> {
      const devices = (await mediaDevices.enumerateDevices()) as MediaDeviceInfoLike[];
      return devices.map((device) => ({
        deviceId: device.deviceId,
        kind: device.kind,
        // Labels are empty until permission is granted; say so rather than
        // rendering a row of blanks.
        label: device.label || 'Unnamed device',
        isDefault: device.deviceId === 'default',
      }));
    },

    async switchCamera(currentTrack: MediaStreamTrackLike): Promise<MediaStreamTrackLike> {
      const devices = (await mediaDevices.enumerateDevices()) as MediaDeviceInfoLike[];
      const cameras = devices.filter((device) => device.kind === 'videoinput');
      if (cameras.length < 2) return currentTrack;

      const currentId = currentTrack.getSettings?.().deviceId as string | undefined;
      const nextIndex = Math.max(
        0,
        (cameras.findIndex((camera) => camera.deviceId === currentId) + 1) % cameras.length,
      );
      const next = cameras[nextIndex];
      if (!next) return currentTrack;

      const stream = (await mediaDevices.getUserMedia({
        video: { deviceId: { exact: next.deviceId }, height: { ideal: maxVideoHeight } },
      })) as MediaStreamLike;

      const track = stream.getVideoTracks()[0];
      if (!track) return currentTrack;
      // The caller replaces the sender track; the old one is dead either way.
      currentTrack.stop();
      return track;
    },

    async setAudioOutput(deviceId: string): Promise<void> {
      if (!capabilities.canSelectAudioOutput) return;
      // Applied by the view layer to each <audio> element; recorded here so the
      // choice survives a re-render.
      lastAudioOutput = deviceId;
    },

    onDeviceChange(listener: () => void): () => void {
      mediaDevices.addEventListener?.('devicechange', listener);
      return () => mediaDevices.removeEventListener?.('devicechange', listener);
    },

    releaseStream(stream: MediaStreamLike): void {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // A track already stopped by the browser throws; nothing to do.
        }
      }
    },
  };
};

/** Selected output device, read by the view layer when attaching audio. */
let lastAudioOutput: string | null = null;
export const getSelectedAudioOutput = (): string | null => lastAudioOutput;

// ---------------------------------------------------------------------------
// Encoding profiles — shared by both platforms
// ---------------------------------------------------------------------------

/**
 * Simulcast layers for a webcam. Three spatial layers let the SFU drop a
 * learner on a weak connection to 180p instead of dropping them entirely.
 */
export const CAMERA_ENCODINGS: MediasoupTypes.RtpEncodingParameters[] = [
  { rid: 'r0', maxBitrate: 100_000, scaleResolutionDownBy: 4, scalabilityMode: 'S1T3' },
  { rid: 'r1', maxBitrate: 300_000, scaleResolutionDownBy: 2, scalabilityMode: 'S1T3' },
  { rid: 'r2', maxBitrate: 900_000, scaleResolutionDownBy: 1, scalabilityMode: 'S1T3' },
];

/**
 * A screen share is one layer, not three. Text stays readable because the
 * bitrate is not divided across resolutions, and because the frame rate is low
 * enough that the encoder spends its budget on detail. See SCREENSHARE_* in
 * .env.example — the server enforces the ceiling these aim at.
 */
export const SCREEN_ENCODINGS: MediasoupTypes.RtpEncodingParameters[] = [
  { maxBitrate: 2_500_000, scalabilityMode: 'S1T2', dtx: true },
];