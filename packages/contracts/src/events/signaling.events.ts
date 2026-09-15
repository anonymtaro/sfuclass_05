/**
 * Classroom signalling  (F1)
 *
 * Namespace: `/classroom`
 *
 * Everything that establishes or changes a media flow goes through here.
 * Nothing in this file carries media itself — the RTP path is between the
 * browser and the SFU node, and this socket only negotiates it.
 *
 * Screen sharing is not a second connection. It is a second video producer on
 * the same peer, tagged `appData.source = 'screen'`, which is what lets every
 * client lay it out differently from a webcam tile without a parallel code
 * path. `ScreenShareManager` holds a presenter lock; a client that starts
 * sharing while someone else holds it receives `screen_share_taken`.
 *
 * Naming: `namespace:noun.verb`, past tense for things that already happened.
 * Client→server events take an acknowledgement callback; server→client events
 * never do.
 */

import { z } from 'zod';
import {
  ActorRefSchema,
  IsoDateTimeSchema,
  UserIdSchema,
  displayText,
} from '../zod/common.schema.ts';

export const CLASSROOM_NAMESPACE = '/classroom' as const;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export const PEER_ROLES = ['host', 'cohost', 'learner'] as const;
export const PeerRoleSchema = z.enum(PEER_ROLES);
export type PeerRole = z.infer<typeof PeerRoleSchema>;

/** Distinguishes a webcam from a screen on the same peer. */
export const MEDIA_SOURCES = ['camera', 'microphone', 'screen', 'screen-audio'] as const;
export const MediaSourceSchema = z.enum(MEDIA_SOURCES);
export type MediaSource = z.infer<typeof MediaSourceSchema>;

export const TRANSPORT_DIRECTIONS = ['send', 'recv'] as const;
export const TransportDirectionSchema = z.enum(TRANSPORT_DIRECTIONS);

/**
 * mediasoup payloads are large, provider-defined structures. Validating their
 * internals here would duplicate mediasoup's own checks and break on every
 * upgrade, so they pass through as opaque records and mediasoup rejects what it
 * does not like.
 */
const OpaqueSchema = z.record(z.string(), z.unknown());

export const RtpCapabilitiesSchema = OpaqueSchema;
export const RtpParametersSchema = OpaqueSchema;
export const DtlsParametersSchema = OpaqueSchema;
export const IceParametersSchema = OpaqueSchema;
export const IceCandidateSchema = OpaqueSchema;

export const ProducerInfoSchema = z.object({
  producerId: z.string().max(64),
  peerId: z.string().max(64),
  userId: UserIdSchema,
  kind: z.enum(['audio', 'video']),
  source: MediaSourceSchema,
  paused: z.boolean().default(false),
});
export type ProducerInfo = z.infer<typeof ProducerInfoSchema>;

export const PeerSchema = z.object({
  peerId: z.string().max(64),
  user: ActorRefSchema,
  role: PeerRoleSchema,
  handRaised: z.boolean().default(false),
  producers: z.array(ProducerInfoSchema).default([]),
  joinedAt: IsoDateTimeSchema,
  /** Set while the peer is in a breakout room rather than the main room. */
  breakoutId: z.string().max(64).nullable().default(null),
});
export type Peer = z.infer<typeof PeerSchema>;

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

export const JoinRoomSchema = z.object({
  roomId: z.uuid(),
  /** Resolved beforehand through GET /rooms/:id/node. */
  nodeId: z.string().max(64),
  rtpCapabilities: RtpCapabilitiesSchema,
  device: z.object({
    platform: z.enum(['web', 'ios', 'android']),
    /** Drives the screen-share capability check on mobile. */
    supportsScreenShare: z.boolean().default(false),
  }),
});

export const CreateTransportSchema = z.object({
  direction: TransportDirectionSchema,
  /** Requests TURN when a direct path already failed once. */
  forceRelay: z.boolean().default(false),
});

export const TransportCreatedSchema = z.object({
  transportId: z.string().max(64),
  iceParameters: IceParametersSchema,
  iceCandidates: z.array(IceCandidateSchema),
  dtlsParameters: DtlsParametersSchema,
});

export const ConnectTransportSchema = z.object({
  transportId: z.string().max(64),
  dtlsParameters: DtlsParametersSchema,
});

export const ProduceSchema = z.object({
  transportId: z.string().max(64),
  kind: z.enum(['audio', 'video']),
  rtpParameters: RtpParametersSchema,
  source: MediaSourceSchema,
  /**
   * Screen shares set contentHint 'detail' and a low frame rate: readable text
   * matters more than smooth motion. See SCREENSHARE_* in .env.example.
   */
  appData: z
    .object({
      contentHint: z.enum(['motion', 'detail', 'text']).optional(),
    })
    .default({}),
});

export const ConsumeSchema = z.object({
  transportId: z.string().max(64),
  producerId: z.string().max(64),
  rtpCapabilities: RtpCapabilitiesSchema,
});

export const ProducerActionSchema = z.object({
  producerId: z.string().max(64),
});

/**
 * Requests the presenter lock. Fails with `screen_share_taken` when another
 * peer holds it and the host has not allowed a second presenter.
 */
export const StartScreenShareSchema = z.object({
  /** For the participant list: 'Entire screen', 'Slides.key', 'Tab: docs'. */
  label: displayText(80).optional(),
  withAudio: z.boolean().default(false),
});

export const ScreenShareStartedSchema = z.object({
  peerId: z.string().max(64),
  user: ActorRefSchema,
  producerId: z.string().max(64),
  audioProducerId: z.string().max(64).nullable().default(null),
  label: displayText(80).nullable().default(null),
  startedAt: IsoDateTimeSchema,
});

export const ScreenShareStoppedSchema = z.object({
  peerId: z.string().max(64),
  producerId: z.string().max(64),
  /** 'stopped' is deliberate; 'revoked' means a host ended it. */
  reason: z.enum(['stopped', 'revoked', 'disconnected']),
});

export const RaiseHandSchema = z.object({
  raised: z.boolean(),
});

export const ReactionSchema = z.object({
  /** Ephemeral. Never persisted, never in the chat history. */
  emoji: z.string().min(1).max(8),
});

export const HostActionSchema = z.object({
  targetPeerId: z.string().max(64),
  action: z.enum([
    'mute',
    'unmute-request',
    'stop-video',
    'remove',
    'promote-cohost',
    'demote',
    'revoke-screen-share',
    'admit',
    'deny',
  ]),
  reason: z.string().max(200).optional(),
});

export const BreakoutActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    groups: z
      .array(z.object({ name: displayText(60), peerIds: z.array(z.string().max(64)) }))
      .min(1)
      .max(50),
    durationMin: z.number().int().min(1).max(240).nullable().default(null),
  }),
  z.object({ action: z.literal('broadcast'), message: z.string().max(500) }),
  z.object({ action: z.literal('recall') }),
  z.object({ action: z.literal('join'), breakoutId: z.string().max(64) }),
]);

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export const RoomStateSchema = z.object({
  roomId: z.uuid(),
  lessonId: z.uuid().nullable(),
  mode: z.enum(['lecture', 'seminar', 'office-hours']),
  routerRtpCapabilities: RtpCapabilitiesSchema,
  peers: z.array(PeerSchema),
  selfPeerId: z.string().max(64),
  selfRole: PeerRoleSchema,
  recording: z.boolean().default(false),
  /** The active screen share, if any, so a late joiner sees it immediately. */
  screenShare: ScreenShareStartedSchema.nullable().default(null),
  waitingRoomEnabled: z.boolean().default(false),
  startedAt: IsoDateTimeSchema,
});

export const RoomClosedSchema = z.object({
  reason: z.enum(['ended-by-host', 'scheduled-end', 'node-drained', 'error']),
  /** Set for 'node-drained': the client reconnects here instead of failing. */
  reconnectNodeId: z.string().max(64).nullable().default(null),
});

export const PeerLeftSchema = z.object({
  peerId: z.string().max(64),
  reason: z.enum(['left', 'removed', 'disconnected', 'timeout']),
});

export const ConsumerCreatedSchema = z.object({
  consumerId: z.string().max(64),
  producerId: z.string().max(64),
  kind: z.enum(['audio', 'video']),
  source: MediaSourceSchema,
  rtpParameters: RtpParametersSchema,
  producerPaused: z.boolean(),
});

export const WaitingPeerSchema = z.object({
  peerId: z.string().max(64),
  user: ActorRefSchema,
  knockedAt: IsoDateTimeSchema,
});

// ---------------------------------------------------------------------------
// Inferred types — what consumers actually hold
// ---------------------------------------------------------------------------

export type JoinRoom = z.infer<typeof JoinRoomSchema>;
export type CreateTransport = z.infer<typeof CreateTransportSchema>;
export type TransportCreated = z.infer<typeof TransportCreatedSchema>;
export type ConnectTransport = z.infer<typeof ConnectTransportSchema>;
export type Produce = z.infer<typeof ProduceSchema>;
export type Consume = z.infer<typeof ConsumeSchema>;
export type ConsumerCreated = z.infer<typeof ConsumerCreatedSchema>;
export type StartScreenShare = z.infer<typeof StartScreenShareSchema>;
export type ScreenShareStarted = z.infer<typeof ScreenShareStartedSchema>;
export type ScreenShareStopped = z.infer<typeof ScreenShareStoppedSchema>;
export type HostAction = z.infer<typeof HostActionSchema>;
export type BreakoutAction = z.infer<typeof BreakoutActionSchema>;
export type RoomState = z.infer<typeof RoomStateSchema>;
export type RoomClosed = z.infer<typeof RoomClosedSchema>;
export type PeerLeft = z.infer<typeof PeerLeftSchema>;
export type WaitingPeer = z.infer<typeof WaitingPeerSchema>;

// ---------------------------------------------------------------------------
// Event names — the only place these strings are written
// ---------------------------------------------------------------------------

export const SIGNALING_CLIENT_EVENTS = {
  join: 'classroom:join',
  leave: 'classroom:leave',
  createTransport: 'classroom:transport.create',
  connectTransport: 'classroom:transport.connect',
  produce: 'classroom:produce',
  closeProducer: 'classroom:producer.close',
  pauseProducer: 'classroom:producer.pause',
  resumeProducer: 'classroom:producer.resume',
  consume: 'classroom:consume',
  resumeConsumer: 'classroom:consumer.resume',
  startScreenShare: 'classroom:screenShare.start',
  stopScreenShare: 'classroom:screenShare.stop',
  raiseHand: 'classroom:hand.raise',
  react: 'classroom:react',
  hostAction: 'classroom:host.action',
  breakout: 'classroom:breakout',
} as const;

export const SIGNALING_SERVER_EVENTS = {
  roomState: 'classroom:room.state',
  roomClosed: 'classroom:room.closed',
  peerJoined: 'classroom:peer.joined',
  peerLeft: 'classroom:peer.left',
  peerUpdated: 'classroom:peer.updated',
  newProducer: 'classroom:producer.new',
  producerClosed: 'classroom:producer.closed',
  consumerCreated: 'classroom:consumer.created',
  screenShareStarted: 'classroom:screenShare.started',
  screenShareStopped: 'classroom:screenShare.stopped',
  handRaised: 'classroom:hand.raised',
  reaction: 'classroom:reaction',
  recordingChanged: 'classroom:recording.changed',
  waitingPeer: 'classroom:waiting.peer',
  breakoutChanged: 'classroom:breakout.changed',
  /** Sent before a node drains, so clients reconnect rather than freeze. */
  nodeDraining: 'classroom:node.draining',
} as const;

export const SignalingEvents = Object.freeze({
  CLASSROOM_NAMESPACE,
  SIGNALING_CLIENT_EVENTS,
  SIGNALING_SERVER_EVENTS,
  MEDIA_SOURCES,
});

export type SignalingClientEvent =
  (typeof SIGNALING_CLIENT_EVENTS)[keyof typeof SIGNALING_CLIENT_EVENTS];
export type SignalingServerEvent =
  (typeof SIGNALING_SERVER_EVENTS)[keyof typeof SIGNALING_SERVER_EVENTS];

// ---------------------------------------------------------------------------
// Payload maps — give Socket.IO its generics on both ends
// ---------------------------------------------------------------------------

export type SignalingClientPayloads = {
  [SIGNALING_CLIENT_EVENTS.join]: z.infer<typeof JoinRoomSchema>;
  [SIGNALING_CLIENT_EVENTS.leave]: Record<string, never>;
  [SIGNALING_CLIENT_EVENTS.createTransport]: z.infer<typeof CreateTransportSchema>;
  [SIGNALING_CLIENT_EVENTS.connectTransport]: z.infer<typeof ConnectTransportSchema>;
  [SIGNALING_CLIENT_EVENTS.produce]: z.infer<typeof ProduceSchema>;
  [SIGNALING_CLIENT_EVENTS.closeProducer]: z.infer<typeof ProducerActionSchema>;
  [SIGNALING_CLIENT_EVENTS.pauseProducer]: z.infer<typeof ProducerActionSchema>;
  [SIGNALING_CLIENT_EVENTS.resumeProducer]: z.infer<typeof ProducerActionSchema>;
  [SIGNALING_CLIENT_EVENTS.consume]: z.infer<typeof ConsumeSchema>;
  [SIGNALING_CLIENT_EVENTS.resumeConsumer]: { consumerId: string };
  [SIGNALING_CLIENT_EVENTS.startScreenShare]: z.infer<typeof StartScreenShareSchema>;
  [SIGNALING_CLIENT_EVENTS.stopScreenShare]: Record<string, never>;
  [SIGNALING_CLIENT_EVENTS.raiseHand]: z.infer<typeof RaiseHandSchema>;
  [SIGNALING_CLIENT_EVENTS.react]: z.infer<typeof ReactionSchema>;
  [SIGNALING_CLIENT_EVENTS.hostAction]: z.infer<typeof HostActionSchema>;
  [SIGNALING_CLIENT_EVENTS.breakout]: z.infer<typeof BreakoutActionSchema>;
};

export type SignalingServerPayloads = {
  [SIGNALING_SERVER_EVENTS.roomState]: z.infer<typeof RoomStateSchema>;
  [SIGNALING_SERVER_EVENTS.roomClosed]: z.infer<typeof RoomClosedSchema>;
  [SIGNALING_SERVER_EVENTS.peerJoined]: z.infer<typeof PeerSchema>;
  [SIGNALING_SERVER_EVENTS.peerLeft]: z.infer<typeof PeerLeftSchema>;
  [SIGNALING_SERVER_EVENTS.peerUpdated]: z.infer<typeof PeerSchema>;
  [SIGNALING_SERVER_EVENTS.newProducer]: z.infer<typeof ProducerInfoSchema>;
  [SIGNALING_SERVER_EVENTS.producerClosed]: z.infer<typeof ProducerActionSchema>;
  [SIGNALING_SERVER_EVENTS.consumerCreated]: z.infer<typeof ConsumerCreatedSchema>;
  [SIGNALING_SERVER_EVENTS.screenShareStarted]: z.infer<typeof ScreenShareStartedSchema>;
  [SIGNALING_SERVER_EVENTS.screenShareStopped]: z.infer<typeof ScreenShareStoppedSchema>;
  [SIGNALING_SERVER_EVENTS.handRaised]: { peerId: string; raised: boolean };
  [SIGNALING_SERVER_EVENTS.reaction]: { peerId: string; emoji: string };
  [SIGNALING_SERVER_EVENTS.recordingChanged]: { recording: boolean; startedBy: string | null };
  [SIGNALING_SERVER_EVENTS.waitingPeer]: z.infer<typeof WaitingPeerSchema>;
  [SIGNALING_SERVER_EVENTS.breakoutChanged]: {
    breakoutId: string | null;
    endsAt: string | null;
  };
  [SIGNALING_SERVER_EVENTS.nodeDraining]: { reconnectNodeId: string | null; graceSec: number };
};