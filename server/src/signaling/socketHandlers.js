// classroom-app/server/src/signaling/socketHandlers.js
/**
 * Classroom signalling  (F1)  [EXT]
 *
 * Namespace: `/classroom` (CLASSROOM_NAMESPACE)
 *
 * Event names come from packages/contracts/src/events/signaling.events.ts,
 * never from local literals, so the contract test catches drift rather than a
 * user discovering it. packages/core-client/src/rtc/SfuClient.ts is written
 * against the same constants, which is what makes the two halves fit.
 *
 * What this file is: a thin, rate-limited, role-checked adapter between
 * Socket.IO and the classroom domain.
 *
 * What it is not: a place where classroom rules live. The presenter lock is
 * ScreenShareManager's, admit/mute/remove are ModerationControls', splits are
 * BreakoutManager's. Those modules also *broadcast their own outcomes* through
 * `room.broadcast` / `room.sendTo`, so handlers here must not re-emit what they
 * already sent — a doubled `screenShare.stopped` makes a client tear down a
 * share twice.
 *
 * Contract with authSocket.js: by the time a handler runs the JWT handshake has
 * populated socket.data = { userId, tenantId, role, displayName, avatarUrl,
 * deviceId, sessionId } and rejected the connection otherwise. Handlers never
 * re-read identity from the payload.
 *
 * Ack envelope, matching SocketAck<T> in the contracts package:
 *     ack({ ok: true,  data })
 *     ack({ ok: false, error: { code, message, traceId } })
 */

import crypto from 'node:crypto';

import { SignalingEvents } from '@classroom/contracts';

import * as RoomManager from '../classroom/RoomManager.js';
import * as RoomRegistry from '../classroom/RoomRegistry.js';
import * as ScreenShareManager from '../classroom/ScreenShareManager.js';
import * as BreakoutManager from '../classroom/BreakoutManager.js';
import * as ModerationControls from '../classroom/ModerationControls.js';
import * as AttendanceService from '../classroom/AttendanceService.js';
import * as HandRaise from '../classroom/interaction/HandRaise.js';
import * as Reactions from '../classroom/interaction/Reactions.js';
import { Peer } from '../classroom/Peer.js';
import { createWebRtcTransport } from '../mediasoup/createWebRtcTransport.js';
import { isDraining } from '../lifecycle/drainSfu.js';
import { consumeSocketBudget } from '../middleware/rateLimit.js';
import * as CapacityGuard from '../capacity/CapacityGuard.js';
import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';

const {
  CLASSROOM_NAMESPACE,
  SIGNALING_CLIENT_EVENTS: CLIENT,
  SIGNALING_SERVER_EVENTS: SERVER,
  MEDIA_SOURCES,
} = SignalingEvents;

const log = logger.child({ component: 'signaling' });

/** Room roles from the contract, not tenant roles. */
const MODERATORS = Object.freeze(['host', 'cohost']);
const SCREEN_SOURCES = Object.freeze(['screen', 'screen-audio']);

/* ------------------------------------------------------------------ *
 * Ack plumbing
 * ------------------------------------------------------------------ */

class SignalError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new SignalError(code, message);
};

const roomChannel = (roomId) => `room:${roomId}`;

/* ------------------------------------------------------------------ *
 * Handler table
 * ------------------------------------------------------------------ */

/**
 *   roles   undefined = any peer in the room; array = one of these room roles
 *   cost    token-bucket weight for realtime/socketRateLimit.js
 *   joined  false for events allowed before the peer is in a room
 */
const HANDLERS = [
  { event: CLIENT.join, cost: 5, joined: false, handler: onJoin },
  { event: CLIENT.leave, cost: 1, handler: onLeave },
  { event: CLIENT.createTransport, cost: 4, handler: onTransportCreate },
  { event: CLIENT.connectTransport, cost: 2, handler: onTransportConnect },
  { event: CLIENT.produce, cost: 4, handler: onProduce },
  { event: CLIENT.closeProducer, cost: 1, handler: onProducerClose },
  { event: CLIENT.pauseProducer, cost: 1, handler: onProducerPause },
  { event: CLIENT.resumeProducer, cost: 1, handler: onProducerResume },
  { event: CLIENT.consume, cost: 2, handler: onConsume },
  { event: CLIENT.resumeConsumer, cost: 1, handler: onConsumerResume },
  { event: CLIENT.startScreenShare, cost: 4, handler: onScreenShareStart },
  { event: CLIENT.stopScreenShare, cost: 2, handler: onScreenShareStop },
  { event: CLIENT.raiseHand, cost: 1, handler: onRaiseHand },
  { event: CLIENT.react, cost: 1, handler: onReact },
  { event: CLIENT.hostAction, cost: 3, roles: MODERATORS, handler: onHostAction },
  { event: CLIENT.breakout, cost: 5, roles: MODERATORS, handler: onBreakout },
];

/**
 * Attach the `/classroom` namespace.
 *
 * Also installs the room emitter. RoomManager builds every Room with an `emit`
 * that routes through here, which is what keeps classroom/ free of any socket
 * import and prevents a circular dependency — and what makes
 * `room.broadcast(...)` inside ScreenShareManager and ModerationControls
 * actually reach anybody.
 */
export function registerSocketHandlers(io) {
  const namespace = io.of(CLASSROOM_NAMESPACE);

  RoomManager.setEmitter((event, payload, options = {}) => {
    const { roomId, except, only } = options;
    // `only` is a socket id; Socket.IO treats every socket id as a room of one.
    if (only) {
      namespace.to(only).emit(event, payload);
      return;
    }
    const target = except
      ? namespace.to(roomChannel(roomId)).except(except)
      : namespace.to(roomChannel(roomId));
    target.emit(event, payload);
  });

  namespace.on('connection', (socket) => registerSocket(namespace, socket));
  return namespace;
}

function registerSocket(namespace, socket) {
  const ctx = { io: namespace, socket };

  for (const { event, roles, cost = 1, joined = true, handler } of HANDLERS) {
    socket.on(event, async (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      const traceId = socket.data.traceId ?? crypto.randomUUID();
      const startedAt = process.hrtime.bigint();

      try {
        const budget = await consumeSocketBudget({
          socketId: socket.id,
          userId: socket.data.userId ?? socket.data.session?.userId,
          event,
        });
        if (!budget.allowed) fail('rate_limited', 'Too many signalling events');

        const session = socket.data.session ?? null;
        if (joined && !session) fail('not_in_room', 'Join a room first');
        if (joined && roles && !roles.includes(session.peer.role)) {
          fail('forbidden', 'Your role cannot perform this action');
        }

        const data = await handler(ctx, payload ?? {}, session);
        respond({ ok: true, data: data ?? null });
      } catch (error) {
        // Domain modules throw with `code` attached; SignalError carries its
        // own. Anything else is a bug and must not leak its message.
        const code =
          error instanceof SignalError ? error.code : (error?.code ?? 'internal_error');

        if (code === 'internal_error') {
          log.error({ err: error, event, socketId: socket.id, traceId }, 'handler failed');
        } else {
          log.debug({ event, code, traceId }, 'handler rejected');
        }

        respond({
          ok: false,
          error: {
            code,
            message: code === 'internal_error' ? 'Signalling error' : error.message,
            traceId,
          },
        });
      } finally {
        metrics.observe?.(
          'signaling_event_ms',
          Number(process.hrtime.bigint() - startedAt) / 1e6,
          { event },
        );
      }
    });
  }

  socket.on('disconnect', (reason) => {
    teardown(ctx, reason).catch((error) =>
      log.error({ err: error, socketId: socket.id }, 'teardown failed'),
    );
  });
}

/* ------------------------------------------------------------------ *
 * Session lifecycle
 * ------------------------------------------------------------------ */

/** @returns {import('@classroom/contracts').SignalingEvents.RoomState} */
async function onJoin({ socket }, payload) {
  if (socket.data.session) fail('already_joined', 'This socket is already in a room');

  const roomId = String(payload.roomId ?? '');
  if (!roomId) fail('invalid_payload', 'roomId is required');

  // A draining node must not take a room it is not already carrying; the client
  // re-resolves through GET /rooms/:id/node and connects elsewhere.
  const alreadyHere = Boolean(RoomManager.getRoom(roomId));
  if (isDraining() && !alreadyHere) {
    fail('node_draining', 'This node is draining — resolve the room node again');
  }

  // A room lives on exactly one node, because its peers share one router.
  const assignedNodeId = await RoomRegistry.whereIs(roomId);
  if (assignedNodeId && assignedNodeId !== env.SFU_NODE_ID && !alreadyHere) {
    fail('wrong_node', 'This room lives on another SFU node');
  }

  const { userId, tenantId, displayName, avatarUrl } = socket.data;
  const user = {
    userId,
    displayName: payload.displayName ?? displayName,
    avatarUrl: avatarUrl ?? null,
  };

  const seat = await CapacityGuard.reserveSeat({ tenantId, roomId, userId });
  if (!seat.ok) fail('room_full', seat.reason ?? 'The room is full for this plan');

  let room;
  let peer;
  try {
    room =
      RoomManager.getRoom(roomId) ??
      (await RoomManager.createRoom({
        roomId,
        lessonId: payload.lessonId ?? null,
        hostUserId: userId, // whoever opens the room owns it
      }));

    // Waiting room and lock belong to ModerationControls. A knock allocates no
    // router resources, so a flood of them costs nothing.
    const knocked = ModerationControls.knock(room, { peerId: socket.id, user });

    if (!knocked.admitted) {
      if (knocked.waiting) {
        socket.data.waiting = { roomId, room, since: Date.now() };
        // Joining the channel lets `classroom:waiting.admitted` reach them.
        await socket.join(roomChannel(roomId));
        fail('waiting_room', 'Waiting for a host to admit you');
      }
      fail(knocked.code ?? 'room_locked', knocked.reason ?? 'The room is locked');
    }

    // Room.addPeer takes a constructed Peer, which keeps Room free of any
    // knowledge about sockets or identity.
    peer = room.addPeer(
      new Peer({
        id: socket.id,
        user,
        role: room.hostUserId === userId ? 'host' : 'learner',
        device: payload.device ?? {},
      }),
    );
  } catch (error) {
    await CapacityGuard.releaseSeat({ tenantId, roomId, userId }).catch(() => {});
    throw error;
  }

  socket.data.session = { roomId, room, peer, tenantId, userId, joinedAt: Date.now() };
  socket.data.waiting = null;

  await socket.join(roomChannel(roomId));

  await AttendanceService.recordJoin({
    roomId,
    lessonId: room.lessonId,
    userId,
    peerId: peer.id,
    role: peer.role,
  }).catch((error) => log.warn({ err: error, roomId }, 'attendance join failed'));

  room.broadcast(SERVER.peerJoined, peer.toJSON(), { except: socket.id });
  metrics.increment?.('classroom_peer_joined', 1, { role: peer.role });

  // RoomState carries routerRtpCapabilities, the peer list and any share
  // already in progress, so a late joiner needs exactly one round trip.
  return room.toState(peer.id);
}

async function onLeave(ctx) {
  await teardown(ctx, 'left');
  return { left: true };
}

async function teardown({ socket }, reason) {
  const waiting = socket.data.waiting;
  if (waiting) {
    waiting.room?.waiting.delete(socket.id);
    socket.data.waiting = null;
  }

  const session = socket.data.session;
  if (!session) return;
  socket.data.session = null;

  const { room, peer, roomId, tenantId, userId } = session;

  // The lock must go before the peer, or it outlives its holder and nobody
  // else in the room can share. releaseForPeer broadcasts the stop itself.
  ScreenShareManager.releaseForPeer(room, peer.id);

  // Room.removePeer broadcasts classroom:peer.left through the injected
  // emitter, so nothing to emit here.
  room.removePeer(peer.id, normaliseLeaveReason(reason));

  await CapacityGuard.releaseSeat({ tenantId, roomId, userId }).catch(() => {});
  await AttendanceService.recordLeave({ roomId, userId, peerId: peer.id, reason }).catch(() => {});

  if (room.peerCount === 0) {
    await RoomManager.closeRoom(roomId, 'ended-by-host').catch(() => {});
  }
  metrics.increment?.('classroom_peer_left', 1, { reason });
}

/** PeerLeftSchema allows exactly these four. */
function normaliseLeaveReason(reason) {
  if (reason === 'left' || reason === 'removed' || reason === 'timeout') return reason;
  return 'disconnected';
}

/* ------------------------------------------------------------------ *
 * Transports
 * ------------------------------------------------------------------ */

async function onTransportCreate(_ctx, payload, session) {
  const direction = payload.direction === 'recv' ? 'recv' : 'send';

  // Returns { transport, params } — the transport stays here, the params are
  // the only thing that crosses to the client.
  const { transport, params } = await createWebRtcTransport(session.room.router, {
    direction,
    forceRelay: Boolean(payload.forceRelay),
  });

  transport.appData = { ...transport.appData, peerId: session.peer.id, direction };
  session.peer.addTransport(transport, direction);

  return {
    ...params,
    // mediasoup-client's createSendTransport/createRecvTransport read `id`,
    // and SfuClient passes this object straight through. The contract field is
    // `transportId`; both are sent so neither side needs a translation step.
    id: params.transportId,
  };
}

async function onTransportConnect(_ctx, payload, session) {
  const transport = session.peer.getTransport(payload.transportId);
  if (!transport) fail('no_transport', 'Unknown transport');
  await transport.connect({ dtlsParameters: payload.dtlsParameters });
  return { connected: true };
}

/* ------------------------------------------------------------------ *
 * Producers
 * ------------------------------------------------------------------ */

/** Contract source ('screen-audio') to Peer.js slot name ('screenAudio'). */
const slotOf = (source) => (source === 'screen-audio' ? 'screenAudio' : source);

/**
 * One producer per source. A screen share is a *second* video producer on the
 * same peer, tagged `source: 'screen'` — not a second connection. What differs
 * is the lock, which must already be held before the producer exists.
 */
async function onProduce({ socket }, payload, session) {
  const source = String(payload.source ?? (payload.kind === 'audio' ? 'microphone' : 'camera'));
  if (!MEDIA_SOURCES.includes(source)) {
    fail('invalid_payload', `Unknown producer source: ${source}`);
  }

  if (
    SCREEN_SOURCES.includes(source) &&
    !ScreenShareManager.isSharing(session.roomId, session.peer.id)
  ) {
    fail('no_presenter_lock', 'Request the presenter lock before producing a screen track');
  }

  const transport = session.peer.getTransport(payload.transportId);
  if (!transport) fail('no_transport', 'Unknown transport');

  const producer = await transport.produce({
    kind: payload.kind,
    rtpParameters: payload.rtpParameters,
    appData: {
      ...payload.appData,
      source,
      peerId: session.peer.id,
      userId: session.userId,
    },
  });

  // Peer.addProducer replaces and closes whatever was in the slot, so a client
  // re-producing after a camera switch leaves nothing behind consuming
  // bandwidth for every subscriber.
  session.peer.addProducer(slotOf(source), producer);

  producer.observer.once('close', () => {
    session.room.broadcast(SERVER.producerClosed, { producerId: producer.id });
  });

  session.room.broadcast(
    SERVER.newProducer,
    {
      producerId: producer.id,
      peerId: session.peer.id,
      userId: session.userId,
      kind: producer.kind,
      source,
      paused: producer.paused,
    },
    { except: socket.id },
  );

  // Turns the reserved lock into a live share: it stamps appData, broadcasts
  // classroom:screenShare.started and points the recorder at the new source.
  // Without this call the lock is never confirmed and expires after a minute.
  if (source === 'screen') {
    const attached = ScreenShareManager.attachProducer(session.room, session.peer, producer, {
      label: payload.appData?.label ?? null,
    });
    if (!attached.ok) fail(attached.code ?? 'screen_share_taken', 'Someone else is sharing');
  }

  session.room.broadcast(SERVER.peerUpdated, session.peer.toJSON());
  metrics.increment?.('classroom_producer_created', 1, { source });

  return { producerId: producer.id, source };
}

async function onProducerPause(_ctx, payload, session) {
  const producer = session.peer.findProducer(payload.producerId);
  if (!producer) fail('no_producer', 'Unknown producer');
  await producer.pause();
  session.room.broadcast(SERVER.peerUpdated, session.peer.toJSON());
  return { paused: true };
}

/**
 * NOTE: there is no server-side check here that a host mute is still in force.
 * ModerationControls.mute() pauses the producer but records no flag, so a
 * client that calls resume immediately un-mutes itself. Closing that hole needs
 * a `mutedBy` marker on the peer — deliberately not invented here, because
 * guessing at the shape would put the rule in this file instead of in
 * ModerationControls where it belongs.
 */
async function onProducerResume(_ctx, payload, session) {
  const producer = session.peer.findProducer(payload.producerId);
  if (!producer) fail('no_producer', 'Unknown producer');
  await producer.resume();
  session.room.broadcast(SERVER.peerUpdated, session.peer.toJSON());
  return { paused: false };
}

async function onProducerClose(_ctx, payload, session) {
  const slot = session.peer.sourceOf(payload.producerId);
  if (!slot) return { closed: true };

  if (slot === 'screen') {
    // release() closes the share and broadcasts screenShare.stopped itself.
    ScreenShareManager.release(session.room, session.peer.id, 'stopped');
  } else {
    session.peer.closeProducer(slot);
  }

  session.room.broadcast(SERVER.peerUpdated, session.peer.toJSON());
  return { closed: true };
}

/* ------------------------------------------------------------------ *
 * Consumers
 * ------------------------------------------------------------------ */

async function onConsume(_ctx, payload, session) {
  const { producerId, rtpCapabilities, transportId } = payload;

  if (!session.room.router.canConsume({ producerId, rtpCapabilities })) {
    fail('cannot_consume', 'Incompatible capabilities for this producer');
  }

  const transport = session.peer.getTransport(transportId);
  if (!transport) fail('no_transport', 'Unknown transport');

  const owner = session.room.producerOwner(producerId);
  const slot = owner?.sourceOf(producerId) ?? null;

  const consumer = await transport.consume({
    producerId,
    rtpCapabilities,
    // Resumed by the client once the element is attached, so the first frames
    // are not thrown away before anything can render them.
    paused: true,
  });
  session.peer.addConsumer(consumer);

  return {
    consumerId: consumer.id,
    producerId,
    kind: consumer.kind,
    source: slot === 'screenAudio' ? 'screen-audio' : (slot ?? 'camera'),
    rtpParameters: consumer.rtpParameters,
    producerPaused: consumer.producerPaused,
  };
}

async function onConsumerResume(_ctx, payload, session) {
  const consumer = session.peer.consumers.get(payload.consumerId);
  if (!consumer) fail('no_consumer', 'Unknown consumer');
  await consumer.resume();
  return { paused: false };
}

/* ------------------------------------------------------------------ *
 * Screen share (F1)
 * ------------------------------------------------------------------ */

/**
 * Two steps on purpose: take the lock, then produce. A user who is going to be
 * refused must never see the platform's screen picker first, and a dismissed
 * picker releases the lock again rather than blocking the room.
 *
 * `screenShare.started` is broadcast by attachProducer in onProduce, not here —
 * until a producer exists there is nothing for anyone to consume.
 */
async function onScreenShareStart(_ctx, payload, session) {
  const result = ScreenShareManager.acquire(session.room, session.peer, {
    label: payload.label ?? null,
  });

  if (!result.ok) {
    fail(
      result.code ?? 'screen_share_taken',
      result.reason ?? 'Someone else is sharing their screen',
    );
  }

  metrics.increment?.('classroom_screenshare_started');

  // The client is told what to encode; it does not get to choose. Simulcast
  // off, low frame rate, contentHint 'detail' — text over motion.
  return { granted: true, profile: result.profile };
}

async function onScreenShareStop(_ctx, _payload, session) {
  // Closes the producers and broadcasts screenShare.stopped on its own.
  ScreenShareManager.release(session.room, session.peer.id, 'stopped');
  session.room.broadcast(SERVER.peerUpdated, session.peer.toJSON());
  return { stopped: true };
}

/* ------------------------------------------------------------------ *
 * Interaction (F1)
 * ------------------------------------------------------------------ */

async function onRaiseHand(_ctx, payload, session) {
  const raised = Boolean(payload.raised);

  if (raised) await HandRaise.raise(session.room, session.peer.id);
  else await HandRaise.lower(session.room, session.peer.id);

  session.peer.handRaised = raised;
  session.peer.handRaisedAt = raised ? new Date().toISOString() : null;

  session.room.broadcast(SERVER.handRaised, { peerId: session.peer.id, raised });
  return { raised };
}

/** Ephemeral by design: reactions are never written to the chat history. */
async function onReact(_ctx, payload, session) {
  const emoji = Reactions.normalise(payload.emoji);
  if (!emoji) fail('invalid_payload', 'Unsupported reaction');
  if (!(await Reactions.allow(session.room, session.peer.id))) {
    fail('rate_limited', 'Slow down on the reactions');
  }

  session.room.broadcast(SERVER.reaction, { peerId: session.peer.id, emoji });
  return { sent: true };
}

/* ------------------------------------------------------------------ *
 * Moderation (F1)
 * ------------------------------------------------------------------ */

/**
 * One event, nine actions, one implementation. ModerationControls owns every
 * rule and every broadcast; this handler adds only the two things that need a
 * socket rather than a room: disconnecting a removed peer, and admitting a
 * peer who is not a peer yet.
 */
async function onHostAction({ io }, payload, session) {
  const { targetPeerId, action, reason = null } = payload;
  if (!targetPeerId || !action) fail('invalid_payload', 'targetPeerId and action are required');

  const result = await ModerationControls.applyHostAction(session.room, session.peer, {
    targetPeerId,
    action,
    reason,
  });

  if (action === 'remove') {
    // Disconnect the socket, or it simply keeps its transports open and its
    // media flowing to everyone who is still subscribed.
    const sockets = await io.in(roomChannel(session.roomId)).fetchSockets();
    for (const other of sockets) {
      if (other.id === targetPeerId) other.disconnect(true);
    }
  }

  if (action === 'admit') {
    // The admitted person is still on the waiting screen with no session. The
    // `classroom:waiting.admitted` that ModerationControls sent is their cue to
    // retry the join; nothing else to do here.
    log.debug({ roomId: session.roomId, targetPeerId }, 'peer admitted, awaiting rejoin');
  }

  return { applied: Boolean(result), action, targetPeerId };
}

/* ------------------------------------------------------------------ *
 * Breakout rooms (F1)
 * ------------------------------------------------------------------ */

/**
 * Child rooms are real rooms with `breakoutParent` set. The client leaves and
 * rejoins through the normal join path — no second transport model, no
 * special-cased peer.
 *
 * UNVERIFIED: BreakoutManager's exported surface was not available when this
 * was written. The four calls below follow the contract's BreakoutActionSchema;
 * if the manager names them differently, this is the file to change, not the
 * contract.
 */
async function onBreakout(_ctx, payload, session) {
  switch (payload.action) {
    case 'create':
      return BreakoutManager.create(session.room, {
        groups: payload.groups,
        durationMin: payload.durationMin ?? null,
        by: session.peer.id,
      });

    case 'broadcast': {
      const message = String(payload.message ?? '').trim();
      if (!message) fail('invalid_payload', 'Empty broadcast');
      return BreakoutManager.broadcast(session.room, { message, by: session.peer.id });
    }

    case 'recall':
      return BreakoutManager.recall(session.room, { by: session.peer.id });

    case 'join':
      return BreakoutManager.assign(session.room, {
        peerId: session.peer.id,
        breakoutId: payload.breakoutId,
        by: session.peer.id,
      });

    default:
      return fail('invalid_payload', `Unknown breakout action: ${payload.action}`);
  }
}

export default registerSocketHandlers;