/**
 * SFU client  (F1)
 *
 * Owns one live session: the signalling socket, the two mediasoup transports,
 * every producer this peer publishes and every consumer it subscribes to. It is
 * the only place in the client that knows mediasoup exists.
 *
 * Two design decisions worth stating, because everything else follows from
 * them:
 *
 *   1. A screen share is a second producer on this same peer, tagged
 *      `source: 'screen'`. Not a second connection, not a second client
 *      instance. The transport, the socket and the reconnect logic are already
 *      there; reusing them is what keeps screen sharing from doubling the
 *      failure modes of a lesson.
 *
 *   2. This class holds no UI state and no framework types. It emits events;
 *      state/useClassroom.ts turns those into whatever React needs. That is
 *      what lets apps/mobile reuse it unchanged.
 *
 * Reconnection: when the SFU node drains during a deployment the server sends
 * `classroom:node.draining` before it goes. The client rotates to another node
 * through nodeResolver and rejoins, republishing what it was sending. A lesson
 * survives a deploy with a visible pause rather than an ending.
 */

import type { types as MediasoupTypes } from 'mediasoup-client';
import { ApiError, SignalingEvents, type SocketAck } from '@classroom/contracts';
import type {
  DeviceAdapter,
  MediaStreamTrackLike,
} from './DeviceAdapter.js';
import { CAMERA_ENCODINGS, SCREEN_ENCODINGS } from './DeviceAdapter.js';
import type { ScreenShareAdapter, ScreenShareHandle } from './ScreenShareAdapter.js';
import type { NodeResolver } from './nodeResolver.js';

const { SIGNALING_CLIENT_EVENTS: CLIENT, SIGNALING_SERVER_EVENTS: SERVER } = SignalingEvents;

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/**
 * The minimum this class needs from a socket. socket/socketClient.ts implements
 * it over Socket.IO; tests implement it with a stub. Keeping the dependency
 * structural means this file never imports socket.io-client, and neither does a
 * consumer that only wants the types.
 */
export interface SignalingTransport {
  emitWithAck<TResponse = unknown>(event: string, payload: unknown): Promise<SocketAck<TResponse>>;
  on(event: string, listener: (payload: never) => void): void;
  off(event: string, listener?: (payload: never) => void): void;
  connect(url: string, auth: Record<string, unknown>): Promise<void>;
  disconnect(): void;
  readonly connected: boolean;
}

export type SignalingTransportFactory = () => SignalingTransport;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type SfuConnectionState =
  | 'idle'
  | 'resolving'
  | 'connecting'
  | 'joined'
  | 'reconnecting'
  | 'closed';

export interface RemoteStream {
  consumerId: string;
  producerId: string;
  peerId: string;
  userId: string;
  kind: 'audio' | 'video';
  source: SignalingEvents.MediaSource;
  track: MediaStreamTrackLike;
  paused: boolean;
}

export interface LocalProducers {
  camera: MediasoupTypes.Producer | null;
  microphone: MediasoupTypes.Producer | null;
  screen: MediasoupTypes.Producer | null;
  screenAudio: MediasoupTypes.Producer | null;
}

export interface SfuClientEvents {
  stateChanged: (state: SfuConnectionState) => void;
  roomState: (state: SignalingEvents.RoomState) => void;
  peerJoined: (peer: SignalingEvents.Peer) => void;
  peerLeft: (event: { peerId: string; reason: string }) => void;
  peerUpdated: (peer: SignalingEvents.Peer) => void;
  streamAdded: (stream: RemoteStream) => void;
  streamRemoved: (event: { consumerId: string; producerId: string }) => void;
  screenShareStarted: (event: SignalingEvents.ScreenShareStarted) => void;
  screenShareStopped: (event: SignalingEvents.ScreenShareStopped) => void;
  /** The local share ended, including via the browser's own stop bar. */
  localScreenShareEnded: (reason: string) => void;
  handRaised: (event: { peerId: string; raised: boolean }) => void;
  reaction: (event: { peerId: string; emoji: string }) => void;
  recordingChanged: (event: { recording: boolean }) => void;
  error: (error: ApiError) => void;
  closed: (reason: string) => void;
}

type Listener = (...args: never[]) => void;

export interface SfuClientOptions {
  deviceAdapter: DeviceAdapter;
  screenShareAdapter: ScreenShareAdapter;
  nodeResolver: NodeResolver;
  createTransport: SignalingTransportFactory;
  /** Supplies the current access token for the socket handshake. */
  getAccessToken(): string | null | Promise<string | null>;
  /** mediasoup-client's Device constructor, injected to keep this tree-shakable. */
  DeviceCtor: new (options?: unknown) => MediasoupTypes.Device;
  logger?: { debug(...args: unknown[]): void; warn(...args: unknown[]): void };
  /** Attempts before a drained-node rejoin is given up on. */
  rejoinAttempts?: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class SfuClient {
  private readonly options: SfuClientOptions;
  private readonly listeners = new Map<keyof SfuClientEvents, Set<Listener>>();

  private transport: SignalingTransport | null = null;
  private device: MediasoupTypes.Device | null = null;
  private sendTransport: MediasoupTypes.Transport | null = null;
  private recvTransport: MediasoupTypes.Transport | null = null;

  private readonly consumers = new Map<string, MediasoupTypes.Consumer>();
  private readonly producers: LocalProducers = {
    camera: null,
    microphone: null,
    screen: null,
    screenAudio: null,
  };

  private screenHandle: ScreenShareHandle | null = null;
  private stopScreenListener: (() => void) | null = null;

  private roomId: string | null = null;
  private nodeId: string | null = null;
  private peerId: string | null = null;
  private state: SfuConnectionState = 'idle';

  constructor(options: SfuClientOptions) {
    this.options = options;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on<K extends keyof SfuClientEvents>(event: K, listener: SfuClientEvents[K]): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener as Listener);
    this.listeners.set(event, set);
    return () => set.delete(listener as Listener);
  }

  private emit<K extends keyof SfuClientEvents>(
    event: K,
    ...args: Parameters<SfuClientEvents[K]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (cause) {
        this.options.logger?.warn('listener threw', event, cause);
      }
    }
  }

  private setState(next: SfuConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('stateChanged', next);
  }

  get connectionState(): SfuConnectionState {
    return this.state;
  }

  get localProducers(): Readonly<LocalProducers> {
    return this.producers;
  }

  get isScreenSharing(): boolean {
    return this.producers.screen !== null;
  }

  // -------------------------------------------------------------------------
  // Join
  // -------------------------------------------------------------------------

  async join(roomId: string): Promise<SignalingEvents.RoomState> {
    this.roomId = roomId;
    this.setState('resolving');

    const node = await this.options.nodeResolver.resolve(roomId);
    this.nodeId = node.nodeId;

    this.setState('connecting');
    const transport = this.options.createTransport();
    this.transport = transport;
    this.bindServerEvents(transport);

    const token = await this.options.getAccessToken();
    await transport.connect(node.wsUrl, { token, roomId });

    const device = this.options.deviceAdapter.createMediasoupDevice();
    this.device = device;

    const roomState = await this.request<SignalingEvents.RoomState>(CLIENT.join, {
      roomId,
      nodeId: node.nodeId,
      // Empty until the device is loaded; the server sends its router
      // capabilities back in the room state, which is what loads it.
      rtpCapabilities: {},
      device: {
        platform: this.options.deviceAdapter.platform,
        supportsScreenShare: this.options.screenShareAdapter.isSupported(),
      },
    });

    if (!device.loaded) {
      await device.load({
        routerRtpCapabilities:
          roomState.routerRtpCapabilities as unknown as MediasoupTypes.RtpCapabilities,
      });
    }

    this.peerId = roomState.selfPeerId;
    await this.createTransports();

    this.setState('joined');
    this.emit('roomState', roomState);

    // A late joiner has to see an ongoing share, not just future ones.
    if (roomState.screenShare) {
      this.emit('screenShareStarted', roomState.screenShare);
    }

    return roomState;
  }

  async leave(): Promise<void> {
    if (this.state === 'closed' || this.state === 'idle') return;
    try {
      await this.request(CLIENT.leave, {});
    } catch {
      // Leaving a room that already ended is not an error worth surfacing.
    }
    this.teardown('left');
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  async publishCamera(track: MediaStreamTrackLike): Promise<MediasoupTypes.Producer> {
    const sendTransport = this.requireSendTransport();
    const producer = await sendTransport.produce({
      track: track as unknown as MediaStreamTrack,
      encodings: this.options.deviceAdapter.capabilities.supportsSimulcast
        ? CAMERA_ENCODINGS
        : undefined,
      codecOptions: { videoGoogleStartBitrate: 300 },
      appData: { source: 'camera' satisfies SignalingEvents.MediaSource },
    });
    this.producers.camera = producer;
    producer.on('transportclose', () => {
      this.producers.camera = null;
    });
    return producer;
  }

  async publishMicrophone(track: MediaStreamTrackLike): Promise<MediasoupTypes.Producer> {
    const sendTransport = this.requireSendTransport();
    const producer = await sendTransport.produce({
      track: track as unknown as MediaStreamTrack,
      codecOptions: { opusDtx: true, opusFec: true },
      appData: { source: 'microphone' satisfies SignalingEvents.MediaSource },
    });
    this.producers.microphone = producer;
    return producer;
  }

  /** Pausing keeps the producer alive, so unmuting does not renegotiate. */
  async setCameraEnabled(enabled: boolean): Promise<void> {
    const producer = this.producers.camera;
    if (!producer) return;
    if (enabled) {
      producer.resume();
      await this.request(CLIENT.resumeProducer, { producerId: producer.id });
    } else {
      producer.pause();
      await this.request(CLIENT.pauseProducer, { producerId: producer.id });
    }
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    const producer = this.producers.microphone;
    if (!producer) return;
    if (enabled) {
      producer.resume();
      await this.request(CLIENT.resumeProducer, { producerId: producer.id });
    } else {
      producer.pause();
      await this.request(CLIENT.pauseProducer, { producerId: producer.id });
    }
  }

  // -------------------------------------------------------------------------
  // Screen sharing
  // -------------------------------------------------------------------------

  /**
   * Asks for the presenter lock, opens the platform picker, then publishes the
   * capture as a second producer.
   *
   * Order matters: the lock is requested first, so a user who is going to be
   * refused never sees a picker. The lock is released again if the capture
   * fails or is cancelled — otherwise a dismissed dialog would block the room's
   * share for everyone.
   */
  async startScreenShare(options: { withAudio?: boolean } = {}): Promise<void> {
    if (!this.options.screenShareAdapter.isSupported()) {
      throw new ApiError('not_implemented', {
        detail: 'This device cannot share its screen.',
      });
    }
    if (this.producers.screen) return;

    await this.request(CLIENT.startScreenShare, {
      withAudio: options.withAudio ?? false,
    });

    let handle: ScreenShareHandle;
    try {
      handle = await this.options.screenShareAdapter.start({
        withAudio: options.withAudio,
      });
    } catch (cause) {
      // Give the lock back before rethrowing; a cancelled picker must not leave
      // the room unable to share.
      await this.request(CLIENT.stopScreenShare, {}).catch(() => undefined);
      throw cause;
    }

    this.screenHandle = handle;

    try {
      const sendTransport = this.requireSendTransport();
      const producer = await sendTransport.produce({
        track: handle.videoTrack as unknown as MediaStreamTrack,
        // One layer, not simulcast: the bitrate belongs to detail, not to
        // resolution variants nobody will subscribe to.
        encodings: SCREEN_ENCODINGS,
        codecOptions: { videoGoogleStartBitrate: 1_000 },
        appData: {
          source: 'screen' satisfies SignalingEvents.MediaSource,
          label: handle.label,
        },
      });
      this.producers.screen = producer;

      if (handle.audioTrack) {
        this.producers.screenAudio = await sendTransport.produce({
          track: handle.audioTrack as unknown as MediaStreamTrack,
          appData: { source: 'screen-audio' satisfies SignalingEvents.MediaSource },
        });
      }

      // The browser's own stop bar ends the track without going through us.
      this.stopScreenListener = handle.onEnded((reason) => {
        void this.stopScreenShare(reason);
      });
    } catch (cause) {
      handle.stop();
      this.screenHandle = null;
      await this.request(CLIENT.stopScreenShare, {}).catch(() => undefined);
      throw cause;
    }
  }

  async stopScreenShare(reason = 'user'): Promise<void> {
    const handle = this.screenHandle;
    const producer = this.producers.screen;

    this.stopScreenListener?.();
    this.stopScreenListener = null;

    producer?.close();
    this.producers.screenAudio?.close();
    this.producers.screen = null;
    this.producers.screenAudio = null;

    handle?.stop();
    this.screenHandle = null;

    if (producer) {
      await this.request(CLIENT.closeProducer, { producerId: producer.id }).catch(() => undefined);
    }
    await this.request(CLIENT.stopScreenShare, {}).catch(() => undefined);

    this.emit('localScreenShareEnded', reason);
  }

  // -------------------------------------------------------------------------
  // In-session actions
  // -------------------------------------------------------------------------

  async raiseHand(raised: boolean): Promise<void> {
    await this.request(CLIENT.raiseHand, { raised });
  }

  async react(emoji: string): Promise<void> {
    await this.request(CLIENT.react, { emoji });
  }

  async hostAction(payload: SignalingEvents.SignalingClientPayloads['classroom:host.action']) {
    await this.request(CLIENT.hostAction, payload);
  }

  // -------------------------------------------------------------------------
  // Transports
  // -------------------------------------------------------------------------

  private async createTransports(): Promise<void> {
    const device = this.device;
    if (!device) throw new Error('join() must run first');

    const sendInfo = await this.request<SignalingEvents.TransportCreated>(
      CLIENT.createTransport,
      { direction: 'send', forceRelay: false },
    );
    const send = device.createSendTransport(
      sendInfo as unknown as MediasoupTypes.TransportOptions,
    );
    this.wireTransport(send, 'send');
    this.sendTransport = send;

    const recvInfo = await this.request<SignalingEvents.TransportCreated>(
      CLIENT.createTransport,
      { direction: 'recv', forceRelay: false },
    );
    const recv = device.createRecvTransport(
      recvInfo as unknown as MediasoupTypes.TransportOptions,
    );
    this.wireTransport(recv, 'recv');
    this.recvTransport = recv;
  }

  private wireTransport(transport: MediasoupTypes.Transport, direction: 'send' | 'recv'): void {
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.request(CLIENT.connectTransport, { transportId: transport.id, dtlsParameters })
        .then(() => callback())
        .catch((cause: Error) => errback(cause));
    });

    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        this.request<{ producerId: string }>(CLIENT.produce, {
          transportId: transport.id,
          kind,
          rtpParameters,
          source: (appData as { source?: string }).source ?? 'camera',
          appData: {
            contentHint:
              (appData as { source?: string }).source === 'screen' ? 'detail' : undefined,
          },
        })
          .then(({ producerId }) => callback({ id: producerId }))
          .catch((cause: Error) => errback(cause));
      });
    }

    transport.on('connectionstatechange', (connectionState) => {
      this.options.logger?.debug('transport', direction, connectionState);
      // 'failed' means ICE gave up: usually a network change, occasionally a
      // node that disappeared. Either way the session needs rebuilding.
      if (connectionState === 'failed' && this.state === 'joined') {
        void this.handleConnectionLoss();
      }
    });
  }

  private requireSendTransport(): MediasoupTypes.Transport {
    if (!this.sendTransport) throw new Error('Not joined: no send transport');
    return this.sendTransport;
  }

  // -------------------------------------------------------------------------
  // Consuming
  // -------------------------------------------------------------------------

  private async consume(producer: SignalingEvents.ProducerInfo): Promise<void> {
    const device = this.device;
    const recvTransport = this.recvTransport;
    if (!device || !recvTransport) return;

    const info = await this.request<SignalingEvents.ConsumerCreated>(CLIENT.consume, {
      transportId: recvTransport.id,
      producerId: producer.producerId,
      rtpCapabilities: device.rtpCapabilities as unknown as Record<string, unknown>,
    });

    const consumer = await recvTransport.consume({
      id: info.consumerId,
      producerId: info.producerId,
      kind: info.kind,
      rtpParameters: info.rtpParameters as unknown as MediasoupTypes.RtpParameters,
    });

    this.consumers.set(consumer.id, consumer);

    // The server creates consumers paused so the client can attach the track
    // before any media flows; resuming here avoids the first frames being lost.
    await this.request(CLIENT.resumeConsumer, { consumerId: consumer.id });

    this.emit('streamAdded', {
      consumerId: consumer.id,
      producerId: info.producerId,
      peerId: producer.peerId,
      userId: producer.userId,
      kind: info.kind,
      source: info.source,
      track: consumer.track as unknown as MediaStreamTrackLike,
      paused: info.producerPaused,
    });
  }

  // -------------------------------------------------------------------------
  // Server events
  // -------------------------------------------------------------------------

  private bindServerEvents(transport: SignalingTransport): void {
    transport.on(SERVER.peerJoined, (peer: SignalingEvents.Peer) =>
      this.emit('peerJoined', peer),
    );
    transport.on(SERVER.peerLeft, (event: { peerId: string; reason: string }) =>
      this.emit('peerLeft', event),
    );
    transport.on(SERVER.peerUpdated, (peer: SignalingEvents.Peer) =>
      this.emit('peerUpdated', peer),
    );

    transport.on(SERVER.newProducer, (producer: SignalingEvents.ProducerInfo) => {
      void this.consume(producer).catch((cause) => this.emitError(cause));
    });

    transport.on(SERVER.producerClosed, ({ producerId }: { producerId: string }) => {
      for (const [consumerId, consumer] of this.consumers) {
        if (consumer.producerId !== producerId) continue;
        consumer.close();
        this.consumers.delete(consumerId);
        this.emit('streamRemoved', { consumerId, producerId });
      }
    });

    transport.on(SERVER.screenShareStarted, (event: SignalingEvents.ScreenShareStarted) =>
      this.emit('screenShareStarted', event),
    );
    transport.on(SERVER.screenShareStopped, (event: SignalingEvents.ScreenShareStopped) =>
      this.emit('screenShareStopped', event),
    );

    transport.on(SERVER.handRaised, (event: { peerId: string; raised: boolean }) =>
      this.emit('handRaised', event),
    );
    transport.on(SERVER.reaction, (event: { peerId: string; emoji: string }) =>
      this.emit('reaction', event),
    );
    transport.on(SERVER.recordingChanged, (event: { recording: boolean }) =>
      this.emit('recordingChanged', event),
    );

    transport.on(SERVER.roomClosed, (event: { reason: string }) => {
      this.teardown(event.reason);
    });

    // A deployment is replacing this node. Rejoin elsewhere rather than
    // waiting to be cut off.
    transport.on(SERVER.nodeDraining, () => {
      void this.handleNodeDraining();
    });
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  private async handleNodeDraining(): Promise<void> {
    const roomId = this.roomId;
    const nodeId = this.nodeId;
    if (!roomId || !nodeId) return;

    this.setState('reconnecting');
    const attempts = this.options.rejoinAttempts ?? 3;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.options.nodeResolver.rotate(roomId, nodeId);
        await this.rejoin(roomId);
        return;
      } catch (cause) {
        this.options.logger?.warn('rejoin failed', attempt, cause);
        // The room may still be held by the draining node while its last
        // lesson finishes; backing off and asking again is the whole strategy.
        await new Promise((resolve) => setTimeout(resolve, attempt * 3_000));
      }
    }

    this.emitError(
      new ApiError('sfu_unavailable', {
        detail: 'Could not move this session to another server.',
      }),
    );
    this.teardown('node-drained');
  }

  private async handleConnectionLoss(): Promise<void> {
    const roomId = this.roomId;
    if (!roomId) return;
    this.setState('reconnecting');
    this.options.nodeResolver.invalidate(roomId);
    try {
      await this.rejoin(roomId);
    } catch (cause) {
      this.emitError(cause);
      this.teardown('error');
    }
  }

  /**
   * Rebuilds the session and republishes whatever was live. The screen share is
   * deliberately not restarted: the platform picker requires a fresh gesture,
   * and silently re-capturing someone's screen would be wrong.
   */
  private async rejoin(roomId: string): Promise<void> {
    const cameraTrack = this.producers.camera?.track ?? null;
    const micTrack = this.producers.microphone?.track ?? null;
    const wasSharing = this.isScreenSharing;

    this.closeMediaOnly();
    this.transport?.disconnect();
    this.transport = null;

    await this.join(roomId);

    if (cameraTrack) {
      await this.publishCamera(cameraTrack as unknown as MediaStreamTrackLike);
    }
    if (micTrack) {
      await this.publishMicrophone(micTrack as unknown as MediaStreamTrackLike);
    }
    if (wasSharing) {
      this.emit('localScreenShareEnded', 'reconnected');
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  private closeMediaOnly(): void {
    for (const consumer of this.consumers.values()) consumer.close();
    this.consumers.clear();

    this.producers.camera?.close();
    this.producers.microphone?.close();
    this.producers.screen?.close();
    this.producers.screenAudio?.close();
    this.producers.camera = null;
    this.producers.microphone = null;
    this.producers.screen = null;
    this.producers.screenAudio = null;

    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
  }

  private teardown(reason: string): void {
    this.stopScreenListener?.();
    this.stopScreenListener = null;
    this.screenHandle?.stop();
    this.screenHandle = null;

    this.closeMediaOnly();

    this.transport?.disconnect();
    this.transport = null;
    this.device = null;
    this.peerId = null;

    if (this.roomId) this.options.nodeResolver.invalidate(this.roomId);
    this.roomId = null;
    this.nodeId = null;

    this.setState('closed');
    this.emit('closed', reason);
  }

  // -------------------------------------------------------------------------
  // Request helper
  // -------------------------------------------------------------------------

  /**
   * Every signalling call is an ack, and every ack is `{ ok }`. Unwrapping it
   * here means the rest of this class deals in values and exceptions rather
   * than in envelopes.
   */
  private async request<TResponse = unknown>(
    event: string,
    payload: unknown,
  ): Promise<TResponse> {
    const transport = this.transport;
    if (!transport) {
      throw new ApiError('dependency_unavailable', { detail: 'Signalling socket is closed' });
    }
    const ack = await transport.emitWithAck<TResponse>(event, payload);
    if (!ack.ok) throw ApiError.fromResponse(ack.error);
    return ack.data;
  }

  private emitError(cause: unknown): void {
    const error = ApiError.is(cause)
      ? cause
      : new ApiError('internal_error', {
          detail: cause instanceof Error ? cause.message : 'Unknown media error',
          cause,
        });
    this.emit('error', error);
  }
}