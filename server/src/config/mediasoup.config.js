// classroom-app/server/src/config/mediasoup.config.js
/**
 * mediasoup configuration  (F1)  [EXT]
 *
 * Extended in version 6 with a screen-share profile. The rest is unchanged.
 *
 * The screen-share addition is small but load-bearing. A shared screen is
 * mostly static text, and encoding it like a webcam produces the effect
 * everyone recognises: sharp when nothing moves, unreadable the moment someone
 * scrolls. The profile below spends the bitrate on resolution instead of frame
 * rate, and disables simulcast so the budget is not split across layers nobody
 * subscribes to.
 */

import os from 'node:os';
import { env } from './env.js';

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

export const workerSettings = {
  /** 0 means one worker per core. A worker is a process, not a thread. */
  count: env.MEDIASOUP_WORKERS || os.availableParallelism(),
  logLevel: env.NODE_ENV === 'production' ? 'warn' : 'debug',
  logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp', 'bwe', 'score'],
  /** Must match the security group and the NLB target group exactly. */
  rtcMinPort: env.MEDIASOUP_MIN_PORT,
  rtcMaxPort: env.MEDIASOUP_MAX_PORT,
  /** A worker that dies takes its rooms with it; health.js watches for this. */
  disableLiburing: false,
};

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

/**
 * Order matters: clients pick the first codec they support.
 *
 * VP8 leads because every browser and both mobile platforms encode it in
 * hardware or cheaply in software. H264 follows for Safari and older Android.
 * VP9 is offered last — better quality per bit, but the encoder cost on a
 * mid-range phone in a thirty-person room is not worth it.
 */
export const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48_000,
    channels: 2,
    parameters: {
      // Discontinuous transmission: a muted participant sends almost nothing.
      usedtx: 1,
      useinbandfec: 1,
      'sprop-stereo': 0,
      minptime: 10,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90_000,
    parameters: { 'x-google-start-bitrate': 300 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90_000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 300,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90_000,
    parameters: { 'profile-id': 2, 'x-google-start-bitrate': 300 },
  },
];

export const routerOptions = { mediaCodecs };

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

export const webRtcTransportOptions = {
  listenInfos: [
    {
      protocol: 'udp',
      ip: '0.0.0.0',
      announcedAddress: env.ANNOUNCED_IP,
      portRange: { min: env.MEDIASOUP_MIN_PORT, max: env.MEDIASOUP_MAX_PORT },
    },
    // TCP is the fallback for networks that block UDP entirely. Slower and
    // worse under loss, and still far better than a lesson nobody can join.
    {
      protocol: 'tcp',
      ip: '0.0.0.0',
      announcedAddress: env.ANNOUNCED_IP,
      portRange: { min: env.MEDIASOUP_MIN_PORT, max: env.MEDIASOUP_MAX_PORT },
    },
  ],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  /** Per-transport ceiling. The room decides how it is shared. */
  initialAvailableOutgoingBitrate: 1_000_000,
  maxSctpMessageSize: 262_144,
  enableSctp: true,
  numSctpStreams: { OS: 1024, MIS: 1024 },
};

/** Recording taps the router with a plain transport; no ICE, no DTLS. */
export const plainTransportOptions = {
  listenInfo: {
    protocol: 'udp',
    ip: '127.0.0.1',
    portRange: { min: env.MEDIASOUP_MIN_PORT, max: env.MEDIASOUP_MAX_PORT },
  },
  rtcpMux: false,
  comedia: false,
};

// ---------------------------------------------------------------------------
// Encoding profiles
// ---------------------------------------------------------------------------

/**
 * Webcam. Three spatial layers so the SFU can drop a learner on a weak
 * connection to 180p instead of dropping them out of the lesson.
 */
export const cameraEncodings = [
  { rid: 'r0', maxBitrate: 100_000, scaleResolutionDownBy: 4, scalabilityMode: 'S1T3' },
  { rid: 'r1', maxBitrate: 300_000, scaleResolutionDownBy: 2, scalabilityMode: 'S1T3' },
  { rid: 'r2', maxBitrate: 900_000, scaleResolutionDownBy: 1, scalabilityMode: 'S1T3' },
];

/**
 * Screen share (F1). One layer, high bitrate, low frame rate.
 *
 * Simulcast is off deliberately: a downscaled layer of a slide is illegible,
 * so a subscriber who cannot afford the full stream is better served by
 * temporal degradation — which S1T2 gives — than by a blurry spatial layer.
 */
export const screenShareEncodings = [
  {
    maxBitrate: env.SCREENSHARE_MAX_BITRATE_KBPS * 1_000,
    maxFramerate: env.SCREENSHARE_MAX_FRAMERATE,
    scalabilityMode: 'S1T2',
    dtx: true,
  },
];

export const screenShareProfile = {
  encodings: screenShareEncodings,
  codecOptions: {
    videoGoogleStartBitrate: Math.round(env.SCREENSHARE_MAX_BITRATE_KBPS * 0.4),
    videoGoogleMaxBitrate: env.SCREENSHARE_MAX_BITRATE_KBPS,
    videoGoogleMinBitrate: 300,
  },
  /** Enforced by ScreenShareManager; the client is asked to match it. */
  maxPresenters: env.SCREENSHARE_MAX_PRESENTERS,
  maxHeight: 1080,
  maxFramerate: env.SCREENSHARE_MAX_FRAMERATE,
  contentHint: 'detail',
};

/**
 * A consumer of a screen share starts at its top layer rather than ramping up.
 * Ramping is right for a webcam and wrong for a slide, where the first seconds
 * are exactly when someone is reading.
 */
export const consumerOptions = {
  camera: { paused: true, preferredLayers: undefined },
  screen: { paused: true, preferredLayers: { spatialLayer: 0, temporalLayer: 1 } },
};

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export const capacity = {
  maxRoomsPerNode: env.SFU_MAX_ROOMS_PER_NODE,
  /** Producers, not people: a peer sharing a screen counts for three. */
  maxProducersPerNode: env.SFU_MAX_ROOMS_PER_NODE * 60,
  drainTimeoutSec: env.SFU_DRAIN_TIMEOUT_SEC,
  /** An empty room is torn down after this, freeing its router. */
  emptyRoomTtlSec: 120,
};

export const mediasoupConfig = {
  workerSettings,
  routerOptions,
  mediaCodecs,
  webRtcTransportOptions,
  plainTransportOptions,
  cameraEncodings,
  screenShareEncodings,
  screenShareProfile,
  consumerOptions,
  capacity,
};

export default mediasoupConfig;