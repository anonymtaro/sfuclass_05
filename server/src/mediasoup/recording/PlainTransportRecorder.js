// classroom-app/server/src/mediasoup/recording/PlainTransportRecorder.js
/**
 * RTP tap and ffmpeg sidecar  (F1, F4)  [NEW]
 *
 * Records a live session by doing what any other participant does: subscribing
 * to the room's producers. The difference is that the subscriber is a plain
 * transport pointed at a local ffmpeg process instead of a browser.
 *
 *   router ──PlainTransport──▶ 127.0.0.1:port ──▶ ffmpeg ──▶ .mp4 on disk
 *
 * Plain rather than WebRTC because there is no browser at the other end: no
 * ICE to negotiate, no DTLS to handshake, no encryption to strip. The traffic
 * never leaves the loopback interface.
 *
 * Why this lives in the SFU and not in the worker service: the tap has to be
 * local to the router, and a router lives in one worker process on one machine.
 * Sending raw RTP across the network to a recording service would double the
 * bandwidth of every recorded lesson. The consequence is that Dockerfile.sfu
 * needs ffmpeg installed — see the note at the end of this file.
 *
 * A screen share needs no special handling here. It is a producer like any
 * other, so the recording picks it up automatically; the layout decision —
 * whether to compose it beside the speaker or record it as a separate track —
 * is made in recordingPipeline.js.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { plainTransportOptions } from '../../config/mediasoup.config.js';
import { logger } from '../../observability/logger.js';

const log = logger.child({ component: 'recorder' });

/** Where ffmpeg writes while it runs. Nothing durable lives here. */
const WORK_DIR = process.env.RECORDING_DIR ?? path.join(os.tmpdir(), 'classroom-recordings');

/**
 * ffmpeg needs to be told what is arriving on those ports. This builds the SDP
 * that describes it — payload types and clock rates have to match what
 * mediasoup is actually sending, or ffmpeg records silence and no video.
 */
const buildSdp = ({ audio, video }) => {
  const lines = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=classroom-recording',
    'c=IN IP4 127.0.0.1',
    't=0 0',
  ];

  if (audio) {
    const codec = audio.rtpParameters.codecs[0];
    const payload = codec.payloadType;
    lines.push(
      `m=audio ${audio.port} RTP/AVP ${payload}`,
      `a=rtpmap:${payload} opus/${codec.clockRate}/${codec.channels ?? 2}`,
      'a=recvonly',
    );
  }

  if (video) {
    const codec = video.rtpParameters.codecs[0];
    const payload = codec.payloadType;
    // 'VP8' from 'video/VP8'.
    const name = codec.mimeType.split('/')[1];
    lines.push(
      `m=video ${video.port} RTP/AVP ${payload}`,
      `a=rtpmap:${payload} ${name}/${codec.clockRate}`,
      'a=recvonly',
    );
  }

  return `${lines.join('\n')}\n`;
};

export class PlainTransportRecorder {
  constructor({ roomId, router, sessionId }) {
    this.roomId = roomId;
    this.router = router;
    this.sessionId = sessionId;
    this.transports = [];
    this.consumers = [];
    this.process = null;
    this.outputPath = null;
    this.startedAt = null;
    this.stopped = false;
  }

  /**
   * Taps one producer. Returns the local port ffmpeg should listen on.
   *
   * The consumer is created paused and resumed only once ffmpeg is listening —
   * otherwise the first seconds of packets arrive at a closed port and the
   * recording opens mid-sentence.
   */
  async #tap(producer) {
    const transport = await this.router.createPlainTransport(plainTransportOptions);
    this.transports.push(transport);

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities: this.router.rtpCapabilities,
      paused: true,
    });
    this.consumers.push(consumer);

    // rtcpMux is off, so RTCP takes the next port up.
    await transport.connect({
      ip: '127.0.0.1',
      port: transport.tuple.localPort,
      rtcpPort: transport.rtcpTuple?.localPort,
    });

    return {
      port: transport.tuple.localPort,
      rtpParameters: consumer.rtpParameters,
      consumer,
    };
  }

  /**
   * @param {{ audioProducer?: object, videoProducer?: object }} producers
   */
  async start({ audioProducer, videoProducer }) {
    if (!audioProducer && !videoProducer) {
      throw new Error('nothing to record: no audio and no video producer');
    }

    await mkdir(WORK_DIR, { recursive: true });

    const audio = audioProducer ? await this.#tap(audioProducer) : null;
    const video = videoProducer ? await this.#tap(videoProducer) : null;

    const sdpPath = path.join(WORK_DIR, `${this.sessionId}.sdp`);
    this.outputPath = path.join(WORK_DIR, `${this.sessionId}.mp4`);
    await writeFile(sdpPath, buildSdp({ audio, video }));

    const args = [
      '-nostdin',
      '-loglevel', 'warning',
      '-protocol_whitelist', 'file,rtp,udp',
      // Without this ffmpeg spends seconds probing and starts the file late.
      '-analyzeduration', '2000000',
      '-probesize', '2000000',
      '-fflags', '+genpts',
      '-i', sdpPath,
      // Copy, never re-encode. Re-encoding here would compete with the SFU for
      // CPU on a machine whose whole job is relaying media. The worker service
      // transcodes later, where CPU is cheap and nobody is waiting.
      '-c:v', 'copy',
      '-c:a', 'copy',
      // Lets a half-written file still be playable if the process is killed.
      '-movflags', '+faststart+frag_keyframe+empty_moov',
      '-y', this.outputPath,
    ];

    this.process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.startedAt = Date.now();

    this.process.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log.debug({ sessionId: this.sessionId, ffmpeg: text }, 'ffmpeg');
    });

    this.process.on('error', (cause) => {
      // Almost always "ffmpeg not found", which is a deployment problem: the
      // SFU image must carry it.
      log.error({ err: cause, sessionId: this.sessionId }, 'ffmpeg failed to start');
    });

    // Give ffmpeg a moment to bind before any packet is sent to it.
    await new Promise((resolve) => setTimeout(resolve, 500));

    for (const consumer of this.consumers) await consumer.resume();

    log.info(
      { roomId: this.roomId, sessionId: this.sessionId, output: this.outputPath },
      'recording started',
    );

    return { sessionId: this.sessionId, outputPath: this.outputPath };
  }

  /**
   * Stops cleanly. SIGINT rather than SIGKILL: ffmpeg then writes the moov atom
   * and the file is playable. A killed ffmpeg leaves a file most players
   * refuse, which is the difference between a recorded lecture and a lost one.
   */
  async stop() {
    if (this.stopped) return { outputPath: this.outputPath, durationSec: 0 };
    this.stopped = true;

    for (const consumer of this.consumers) {
      try {
        consumer.close();
      } catch {
        // Already closed with its transport.
      }
    }

    const durationSec = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;

    if (this.process && !this.process.killed) {
      await new Promise((resolve) => {
        const forceTimer = setTimeout(() => {
          log.warn({ sessionId: this.sessionId }, 'ffmpeg did not exit; killing it');
          this.process.kill('SIGKILL');
          resolve();
        }, 10_000);

        this.process.once('exit', (code) => {
          clearTimeout(forceTimer);
          log.info({ sessionId: this.sessionId, code, durationSec }, 'ffmpeg exited');
          resolve();
        });

        this.process.kill('SIGINT');
      });
    }

    for (const transport of this.transports) {
      try {
        transport.close();
      } catch {
        // Closed with the router.
      }
    }

    return { outputPath: this.outputPath, durationSec };
  }

  /** Removes the working files once the upload has succeeded. */
  async cleanup() {
    const sdpPath = path.join(WORK_DIR, `${this.sessionId}.sdp`);
    await rm(sdpPath, { force: true }).catch(() => undefined);
    await rm(this.outputPath ?? '', { force: true }).catch(() => undefined);
  }

  get isRunning() {
    return Boolean(this.process) && !this.stopped;
  }
}

/**
 * Deployment note. This spawns ffmpeg inside the SFU container, so
 * server/Dockerfile.sfu must install it — the base image in the tree is built
 * for mediasoup only. The alternative is a sidecar container sharing the task's
 * network namespace, which keeps the SFU image small at the cost of one more
 * moving part per task. Either works; what does not work is recording from the
 * worker service, because the RTP tap has to be local to the router.
 */
export default PlainTransportRecorder;