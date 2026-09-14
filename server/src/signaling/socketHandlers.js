/**
 * socketHandlers — the signalling namespace. (F1)
 *
 * [EXT] Version 5 handled join / transport / produce / consume. Version 6 adds the screen
 * share producer, the interaction/ events, moderation, the waiting room and breakout
 * rooms. Nothing that already worked changed shape: the same ack contract, the same
 * transport lifecycle, the same room fan-out.
 *
 * What this file is:
 *   a thin, rate-limited, role-checked adapter between Socket.IO and the classroom domain.
 *
 * What this file is not:
 *   a place where classroom rules live. Presenter locks belong to ScreenShareManager,
 *   admit/mute rules to ModerationControls, splits to BreakoutManager. If a handler here
 *   grows an `if`, the rule is in the wrong file.
 *
 * Contract with authSocket.js ([UNCHANGED]): by the time a handler runs, the JWT
 * handshake has populated
 *     socket.data = { userId, tenantId, role, displayName, deviceId, sessionId }
 * and rejected the connection otherwise. Handlers never re-read identity from the payload.
 *
 * Every callable event answers through an ack:
 *     ack({ ok: true,  data })
 *     ack({ ok: false, error: { code, message, traceId } })
 * so the client never has to race a success event against a silent failure. Broadcasts are
 * fire-and-forget and always past tense (`peer:joined`, `screenShare:started`).
 */

import crypto from 'node:crypto';

import * as RoomManager from '../classroom/RoomManager.js';
import * as RoomRegistry from '../classroom/RoomRegistry.js';
import * as ScreenShareManager from '../classroom/ScreenShareManager.js';
import * as BreakoutManager from '../classroom/BreakoutManager.js';
import * as ModerationControls from '../classroom/ModerationControls.js';
import * as AttendanceService from '../classroom/AttendanceService.js';
import * as HandRaise from '../classroom/interaction/HandRaise.js';
import * as Reactions from '../classroom/interaction/Reactions.js';
import * as LiveChat from '../classroom/interaction/LiveChat.js';
import * as Poll from '../classroom/interaction/Poll.js';
import { createWebRtcTransport } from '../mediasoup/createWebRtcTransport.js';
import { isDraining } from '../lifecycle/drainSfu.js';
import { consumeSocketBudget } from '../realtime/socketRateLimit.js';
import * as CapacityGuard from '../capacity/CapacityGuard.js';
import { logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';

/**
 * Event names. Mirrors packages/contracts/src/events/signaling.events.ts — that file stays
 * the source of truth; this constant exists only because the server is JS and the contracts
 * package ships TypeScript. Keep them in step or the contract test will say so.
 */
export const EV = Object.freeze({
  // session lifecycle
  JOIN: 'room:join',
  LEAVE: 'room:leave',
  RTP_CAPABILITIES: 'router:rtpCapabilities',
  TRANSPORT_CREATE: 'transport:create',
  TRANSPORT_CONNECT: 'transport:connect',
  PRODUCE: 'produce',
  PRODUCER_PAUSE: 'producer:pause',
  PRODUCER_RESUME: 'producer:resume',
  PRODUCER_CLOSE: 'producer:close',
  CONSUME: 'consume',
  CONSUMER_RESUME: 'consumer:resume',
  CONSUMER_PAUSE: 'consumer:pause',
  // screen share
  SCREEN_START: 'screenShare:start',
  SCREEN_STOP: 'screenShare:stop',
  SCREEN_HANDOVER: 'screenShare:handover',
  // interaction
  HAND_RAISE: 'hand:raise',
  HAND_LOWER: 'hand:lower',
  REACTION: 'reaction:send',
  CHAT_SEND: 'chat:send',
  POLL_CREATE: 'poll:create',
  POLL_VOTE: 'poll:vote',
  POLL_CLOSE: 'poll:close',
  // moderation
  MOD_ADMIT: 'mod:admit',
  MOD_DENY: 'mod:deny',
  MOD_MUTE: 'mod:mute',
  MOD_MUTE_ALL: 'mod:muteAll',
  MOD_REMOVE: 'mod:remove',
  MOD_LOCK: 'mod:lock',
  MOD_HANDOVER: 'mod:handover',
  // breakout
  BREAKOUT_OPEN: 'breakout:open',
  BREAKOUT_ASSIGN: 'breakout:assign',
  BREAKOUT_BROADCAST: 'breakout:broadcast',
  BREAKOUT_RECALL: 'breakout:recall',
});

const HOSTS = Object.freeze(['owner', 'teacher', 'cohost']);
const MAX_CHAT_LEN = 4000;

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

function roomChannel(roomId) {
  return `room:${roomId}`;
}

function hostChannel(roomId) {
  return `room:${roomId}:hosts`;
}

/** Everything the client is allowed to know about a peer. No tokens, no transport ids. */
function publicPeer(peer) {
  return {
    peerId: peer.id,
    userId: peer.userId,
    displayName: peer.displayName,
    role: peer.role,
    handRaised: Boolean(peer.handRaised),
    producers: Object.fromEntries(
      Object.entries(peer.producers ?? {})
        .filter(([, producer]) => producer && !producer.closed)
        .map(([source, producer]) => [source, { id: producer.id, paused: producer.paused }]),
    ),
  };
}

/* ------------------------------------------------------------------ *
 * Handler table
 * ------------------------------------------------------------------ */

/**
 * Declarative rather than forty `socket.on` calls: role and cost sit next to the handler,
 * so an event can never be added without deciding who may send it and what it costs.
 *
 *  roles   null = any peer in the room; array = one of these room roles
 *  cost    token-bucket weight for realtime/socketRateLimit.js
 *  joined  false for events allowed before the peer is in a room
 */
const HANDLERS = [
  { event: EV.JOIN, cost: 5, joined: false, handler: onJoin },
  { event: EV.LEAVE, cost: 1, handler: onLeave },
  { event: EV.RTP_CAPABILITIES, cost: 1, handler: onRtpCapabilities },
  { event: EV.TRANSPORT_CREATE, cost: 4, handler: onTransportCreate },
  { event: EV.TRANSPORT_CONNECT, cost: 2, handler: onTransportConnect },
  { event: EV.PRODUCE, cost: 4, handler: onProduce },
  { event: EV.PRODUCER_PAUSE, cost: 1, handler: onProducerPause },
  { event: EV.PRODUCER_RESUME, cost: 1, handler: onProducerResume },
  { event: EV.PRODUCER_CLOSE, cost: 1, handler: onProducerClose },
  { event: EV.CONSUME, cost: 2, handler: onConsume },
  { event: EV.CONSUMER_RESUME, cost: 1, handler: onConsumerResume },
  { event: EV.CONSUMER_PAUSE, cost: 1, handler: onConsumerPause },

  { event: EV.SCREEN_START, cost: 4, handler: onScreenShareStart },
  { event: EV.SCREEN_STOP, cost: 2, handler: onScreenShareStop },
  { event: EV.SCREEN_HANDOVER, cost: 2, roles: HOSTS, handler: onScreenShareHandover },

  { event: EV.HAND_RAISE, cost: 1, handler: onHandRaise },
  { event: EV.HAND_LOWER, cost: 1, handler: onHandLower },
  { event: EV.REACTION, cost: 1, handler: onReaction },
  { event: EV.CHAT_SEND, cost: 2, handler: onChatSend },
  { event: EV.POLL_CREATE, cost: 3, roles: HOSTS, handler: onPollCreate },
  { event: EV.POLL_VOTE, cost: 1, handler: onPollVote },
  { event: EV.POLL_CLOSE, cost: 2, roles: HOSTS, handler: onPollClose },

  { event: EV.MOD_ADMIT, cost: 2, roles: HOSTS, handler: onAdmit },
  { event: EV.MOD_DENY, cost: 2, roles: HOSTS, handler: onDeny },
  { event: EV.MOD_MUTE, cost: 2, roles: HOSTS, handler: onMute },
  { event: EV.MOD_MUTE_ALL, cost: 4, roles: HOSTS, handler: onMuteAll },
  { event: EV.MOD_REMOVE, cost: 3, roles: HOSTS, handler: onRemove },
  { event: EV.MOD_LOCK, cost: 2, roles: HOSTS, handler: onLock },
  { event: EV.MOD_HANDOVER, cost: 3, roles: ['owner', 'teacher'], handler: onHandover },

  { event: EV.BREAKOUT_OPEN, cost: 6, roles: HOSTS, handler: onBreakoutOpen },
  { event: EV.BREAKOUT_ASSIGN, cost: 3, roles: HOSTS, handler: onBreakoutAssign },
  { event: EV.BREAKOUT_BROADCAST, cost: 3, roles: HOSTS, handler: onBreakoutBroadcast },
  { event: EV.BREAKOUT_RECALL, cost: 4, roles: HOSTS, handler: onBreakoutRecall },
];

/**
 * Register every signalling handler on a connected socket.
 * Called from server.js once the namespace middleware (authSocket) has run.
 */
export function registerSocketHandlers(io, socket) {
  const ctx = {
    io,
    socket,
    get session() {
      return socket.data.session ?? null;
    },
  };

  for (const { event, roles, cost = 1, joined = true, handler } of HANDLERS) {
    socket.on(event, async (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      const traceId = socket.data.traceId ?? crypto.randomUUID();
      const startedAt = process.hrtime.bigint();

      try {
        const allowed = await consumeSocketBudget(socket, event, cost);
        if (!allowed) fail('RATE_LIMITED', 'Too many signalling events');

        const session = socket.data.session ?? null;
        if (joined && !session) fail('NOT_IN_ROOM', 'Join a room first');
        if (joined && roles && !roles.includes(session.peer.role)) {
          fail('FORBIDDEN', 'Your role cannot perform this action');
        }

        const data = await handler(ctx, payload ?? {}, session);
        respond({ ok: true, data: data ?? null });
      } catch (error) {
        const code = error instanceof SignalError ? error.code : 'INTERNAL';
        if (code === 'INTERNAL') {
          logger.error({ err: error, event, socketId: socket.id, traceId }, 'signaling: handler failed');
        } else {
          logger.debug({ event, code, traceId }, 'signaling: handler rejected');
        }
        respond({
          ok: false,
          error: {
            code,
            message: code === 'INTERNAL' ? 'Signalling error' : error.message,
            traceId,
          },
        });
      } finally {
        metrics.observe?.('signaling_event_ms', Number(process.hrtime.bigint() - startedAt) / 1e6, { event });
      }
    });
  }

  socket.on('disconnect', (reason) => {
    teardown(ctx, reason).catch((error) =>
      logger.error({ err: error, socketId: socket.id }, 'signaling: teardown failed'),
    );
  });
}

/* ------------------------------------------------------------------ *
 * Session lifecycle
 * ------------------------------------------------------------------ */

async function onJoin({ io, socket }, payload) {
  if (socket.data.session) fail('ALREADY_JOINED', 'This socket is already in a room');

  const roomId = String(payload.roomId ?? '');
  if (!roomId) fail('INVALID_PAYLOAD', 'roomId is required');

  // A draining node must not accept new rooms; the client re-resolves and reconnects.
  if (isDraining() && !RoomManager.has(roomId)) {
    fail('NODE_DRAINING', 'This node is draining — resolve the room node again');
  }

  const owner = await RoomRegistry.resolve(roomId);
  if (owner && owner.nodeId !== process.env.NODE_ID && !RoomManager.has(roomId)) {
    fail('WRONG_NODE', 'This room lives on another SFU node');
  }

  const { userId, tenantId, role, displayName } = socket.data;

  const seat = await CapacityGuard.reserveSeat({ tenantId, roomId, userId });
  if (!seat.ok) fail('ROOM_FULL', seat.reason ?? 'The room is full for this plan');

  let room;
  let peer;
  try {
    room = await RoomManager.getOrCreate({ roomId, tenantId, lessonId: payload.lessonId ?? null });

    // Waiting room and lock are decided by ModerationControls, never here.
    const admission = await ModerationControls.evaluateAdmission(room, { userId, role });
    if (admission.decision === 'denied') fail('ROOM_LOCKED', admission.reason ?? 'The room is locked');
    if (admission.decision === 'waiting') {
      socket.data.waiting = { roomId, since: Date.now() };
      await socket.join(roomChannel(roomId));
      io.to(hostChannel(roomId)).emit('waitingRoom:updated', {
        roomId,
        pending: await ModerationControls.listWaiting(room),
      });
      return { state: 'waiting', roomId };
    }

    peer = await room.addPeer({
      socketId: socket.id,
      userId,
      displayName: payload.displayName ?? displayName,
      role: admission.role ?? role,
      device: payload.device ?? null,
    });
  } catch (error) {
    await CapacityGuard.releaseSeat({ tenantId, roomId, userId }).catch(() => {});
    throw error;
  }

  socket.data.session = { roomId, room, peer, tenantId, userId, joinedAt: Date.now() };
  socket.data.waiting = null;

  await socket.join(roomChannel(roomId));
  if (HOSTS.includes(peer.role)) await socket.join(hostChannel(roomId));

  await AttendanceService.recordJoin({
    roomId,
    lessonId: room.lessonId,
    userId,
    peerId: peer.id,
    role: peer.role,
  });

  socket.to(roomChannel(roomId)).emit('peer:joined', { roomId, peer: publicPeer(peer) });
  metrics.increment?.('classroom_peer_joined', 1, { role: peer.role });

  return {
    state: 'joined',
    roomId,
    peerId: peer.id,
    role: peer.role,
    mode: room.mode,
    breakoutParent: room.breakoutParent ?? null,
    rtpCapabilities: room.router.rtpCapabilities,
    peers: room.peers().filter((other) => other.id !== peer.id).map(publicPeer),
    screenShare: ScreenShareManager.current(room),
    handsRaised: HandRaise.list(room),
    activePoll: Poll.active(room),
  };
}

async function onLeave(ctx) {
  await teardown(ctx, 'client-leave');
  return { left: true };
}

async function teardown({ io, socket }, reason) {
  const waiting = socket.data.waiting;
  if (waiting) {
    await ModerationControls.dropWaiting(waiting.roomId, socket.data.userId).catch(() => {});
    socket.data.waiting = null;
  }

  const session = socket.data.session;
  if (!session) return;
  socket.data.session = null;

  const { room, peer, roomId, tenantId, userId } = session;

  // The screen must be released before the peer, or the lock outlives the sharer.
  if (ScreenShareManager.isPresenter(room, peer.id)) {
    const released = await ScreenShareManager.release(room, peer.id);
    io.to(roomChannel(roomId)).emit('screenShare:stopped', { roomId, peerId: peer.id, reason: 'disconnect', next: released?.next ?? null });
  }

  await room.removePeer(peer.id).catch((error) =>
    logger.warn({ err: error, roomId, peerId: peer.id }, 'signaling: removePeer failed'),
  );
  await CapacityGuard.releaseSeat({ tenantId, roomId, userId }).catch(() => {});
  await AttendanceService.recordLeave({ roomId, userId, peerId: peer.id, reason }).catch(() => {});

  io.to(roomChannel(roomId)).emit('peer:left', { roomId, peerId: peer.id, reason });
  await RoomManager.closeIfEmpty(roomId);
  metrics.increment?.('classroom_peer_left', 1, { reason });
}

/* ------------------------------------------------------------------ *
 * Transports and producers (logic unchanged from v5)
 * ------------------------------------------------------------------ */

async function onRtpCapabilities(_ctx, _payload, session) {
  return { rtpCapabilities: session.room.router.rtpCapabilities };
}

async function onTransportCreate(_ctx, payload, session) {
  const direction = payload.direction === 'recv' ? 'recv' : 'send';
  const transport = await createWebRtcTransport(session.room.router, {
    appData: { peerId: session.peer.id, direction },
  });
  session.peer.addTransport(transport, direction);

  return {
    id: transport.id,
    direction,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
    sctpParameters: transport.sctpParameters,
  };
}

async function onTransportConnect(_ctx, payload, session) {
  const transport = session.peer.getTransport(payload.transportId);
  if (!transport) fail('NO_TRANSPORT', 'Unknown transport');
  await transport.connect({ dtlsParameters: payload.dtlsParameters });
  return { connected: true };
}

/**
 * One producer per source. `appData.source` is 'cam' | 'mic' | 'screen' | 'screenAudio' —
 * the screen share is a second video producer on the same peer, not a second connection,
 * so it arrives here like any other track. What differs is the lock, applied before the
 * producer exists (see onScreenShareStart).
 */
async function onProduce({ io, socket }, payload, session) {
  const source = String(payload.appData?.source ?? (payload.kind === 'audio' ? 'mic' : 'cam'));
  if (!['cam', 'mic', 'screen', 'screenAudio'].includes(source)) {
    fail('INVALID_PAYLOAD', `Unknown producer source: ${source}`);
  }
  if ((source === 'screen' || source === 'screenAudio') && !ScreenShareManager.isPresenter(session.room, session.peer.id)) {
    fail('NO_PRESENTER_LOCK', 'Call screenShare:start before producing a screen track');
  }
  if (source !== 'screen' && source !== 'screenAudio' && ModerationControls.isMuted(session.room, session.peer.id, source)) {
    fail('MUTED_BY_HOST', 'A host has muted this source');
  }

  const transport = session.peer.getTransport(payload.transportId);
  if (!transport) fail('NO_TRANSPORT', 'Unknown transport');

  const existing = session.peer.producers?.[source];
  if (existing && !existing.closed) fail('ALREADY_PRODUCING', `This peer already produces ${source}`);

  const producer = await transport.produce({
    kind: payload.kind,
    rtpParameters: payload.rtpParameters,
    appData: { ...payload.appData, source, peerId: session.peer.id },
  });

  session.peer.addProducer(source, producer);
  producer.observer.once('close', () => {
    io.to(roomChannel(session.roomId)).emit('producer:closed', {
      roomId: session.roomId,
      peerId: session.peer.id,
      producerId: producer.id,
      source,
    });
  });

  socket.to(roomChannel(session.roomId)).emit('producer:new', {
    roomId: session.roomId,
    peerId: session.peer.id,
    producerId: producer.id,
    kind: producer.kind,
    source,
  });

  metrics.increment?.('classroom_producer_created', 1, { source });
  return { producerId: producer.id, source };
}

async function onProducerPause(_ctx, payload, session) {
  const producer = session.peer.getProducer(payload.producerId);
  if (!producer) fail('NO_PRODUCER', 'Unknown producer');
  await producer.pause();
  return { paused: true };
}

async function onProducerResume(_ctx, payload, session) {
  const producer = session.peer.getProducer(payload.producerId);
  if (!producer) fail('NO_PRODUCER', 'Unknown producer');
  if (ModerationControls.isMuted(session.room, session.peer.id, producer.appData?.source)) {
    fail('MUTED_BY_HOST', 'A host has muted this source');
  }
  await producer.resume();
  return { paused: false };
}

async function onProducerClose({ io }, payload, session) {
  const producer = session.peer.getProducer(payload.producerId);
  if (!producer) return { closed: true };
  const source = producer.appData?.source;
  producer.close();
  session.peer.removeProducer(producer.id);

  if (source === 'screen') {
    const released = await ScreenShareManager.release(session.room, session.peer.id);
    io.to(roomChannel(session.roomId)).emit('screenShare:stopped', {
      roomId: session.roomId,
      peerId: session.peer.id,
      reason: 'producer-closed',
      next: released?.next ?? null,
    });
  }
  return { closed: true };
}

async function onConsume(_ctx, payload, session) {
  const { producerId, rtpCapabilities, transportId } = payload;
  if (!session.room.router.canConsume({ producerId, rtpCapabilities })) {
    fail('CANNOT_CONSUME', 'Incompatible capabilities for this producer');
  }
  const transport = session.peer.getTransport(transportId);
  if (!transport) fail('NO_TRANSPORT', 'Unknown transport');

  const consumer = await transport.consume({
    producerId,
    rtpCapabilities,
    paused: true, // resumed by the client once the element is attached — avoids a black first frame
  });
  session.peer.addConsumer(consumer);

  return {
    consumerId: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    source: consumer.appData?.source ?? null,
  };
}

async function onConsumerResume(_ctx, payload, session) {
  const consumer = session.peer.getConsumer(payload.consumerId);
  if (!consumer) fail('NO_CONSUMER', 'Unknown consumer');
  await consumer.resume();
  return { paused: false };
}

async function onConsumerPause(_ctx, payload, session) {
  const consumer = session.peer.getConsumer(payload.consumerId);
  if (!consumer) fail('NO_CONSUMER', 'Unknown consumer');
  await consumer.pause();
  return { paused: true };
}

/* ------------------------------------------------------------------ *
 * Screen share (F1)
 * ------------------------------------------------------------------ */

/**
 * Two steps on purpose: acquire the lock, then produce. The client must not capture the
 * screen — and show the browser's sharing indicator — before it knows it may share.
 */
async function onScreenShareStart({ io }, payload, session) {
  const lock = await ScreenShareManager.acquire(session.room, session.peer.id, {
    withAudio: Boolean(payload.withAudio),
    force: HOSTS.includes(session.peer.role) && Boolean(payload.force),
  });
  if (!lock.granted) {
    fail('SCREEN_TAKEN', lock.reason ?? `${lock.presenter?.displayName ?? 'Someone else'} is sharing`);
  }

  if (lock.revoked) {
    io.to(roomChannel(session.roomId)).emit('screenShare:stopped', {
      roomId: session.roomId,
      peerId: lock.revoked.peerId,
      reason: 'taken-over',
    });
  }

  io.to(roomChannel(session.roomId)).emit('screenShare:started', {
    roomId: session.roomId,
    peerId: session.peer.id,
    displayName: session.peer.displayName,
    withAudio: Boolean(payload.withAudio),
  });

  metrics.increment?.('classroom_screenshare_started');
  return {
    granted: true,
    // Simulcast off, lower frame rate, contentHint 'detail': text over motion.
    encodings: lock.encodings,
    contentHint: lock.contentHint ?? 'detail',
    maxWidth: lock.maxWidth,
    maxFramerate: lock.maxFramerate,
  };
}

async function onScreenShareStop({ io }, _payload, session) {
  for (const source of ['screen', 'screenAudio']) {
    const producer = session.peer.producers?.[source];
    if (producer && !producer.closed) {
      producer.close();
      session.peer.removeProducer(producer.id);
    }
  }
  const released = await ScreenShareManager.release(session.room, session.peer.id);
  io.to(roomChannel(session.roomId)).emit('screenShare:stopped', {
    roomId: session.roomId,
    peerId: session.peer.id,
    reason: 'stopped',
    next: released?.next ?? null,
  });
  return { stopped: true };
}

/** Host hands the screen to someone else, or allows a second parallel share. */
async function onScreenShareHandover({ io }, payload, session) {
  const result = await ScreenShareManager.handover(session.room, {
    toPeerId: payload.peerId ?? null,
    allowParallel: Boolean(payload.allowParallel),
    by: session.peer.id,
  });

  io.to(roomChannel(session.roomId)).emit('screenShare:handedOver', {
    roomId: session.roomId,
    presenters: result.presenters,
    allowParallel: result.allowParallel,
  });
  return result;
}

/* ------------------------------------------------------------------ *
 * Interaction (F1, F2)
 * ------------------------------------------------------------------ */

async function onHandRaise({ io }, _payload, session) {
  const state = await HandRaise.raise(session.room, session.peer.id);
  io.to(roomChannel(session.roomId)).emit('hand:raised', {
    roomId: session.roomId,
    peerId: session.peer.id,
    displayName: session.peer.displayName,
    position: state.position,
  });
  return state;
}

async function onHandLower({ io }, payload, session) {
  // A host may lower somebody else's hand; a learner may only lower their own.
  const targetPeerId = payload.peerId && HOSTS.includes(session.peer.role) ? payload.peerId : session.peer.id;
  await HandRaise.lower(session.room, targetPeerId);
  io.to(roomChannel(session.roomId)).emit('hand:lowered', { roomId: session.roomId, peerId: targetPeerId });
  return { peerId: targetPeerId };
}

/** Ephemeral by design: reactions are never written to the chat history. */
async function onReaction({ io }, payload, session) {
  const emoji = Reactions.normalise(payload.emoji);
  if (!emoji) fail('INVALID_PAYLOAD', 'Unsupported reaction');
  if (!(await Reactions.allow(session.room, session.peer.id))) {
    fail('RATE_LIMITED', 'Slow down on the reactions');
  }
  io.to(roomChannel(session.roomId)).emit('reaction:burst', {
    roomId: session.roomId,
    peerId: session.peer.id,
    emoji,
    at: Date.now(),
  });
  return { sent: true };
}

/**
 * In-lesson chat is not a separate chat system: LiveChat persists into the messaging
 * domain (F6), so the lesson transcript and the chat dock show the same messages.
 */
async function onChatSend({ io }, payload, session) {
  const body = String(payload.body ?? '').trim();
  if (!body) fail('INVALID_PAYLOAD', 'Empty message');
  if (body.length > MAX_CHAT_LEN) fail('MESSAGE_TOO_LONG', `Max ${MAX_CHAT_LEN} characters`);
  if (ModerationControls.isMuted(session.room, session.peer.id, 'chat')) {
    fail('MUTED_BY_HOST', 'A host has muted you in this room');
  }

  const message = await LiveChat.post(session.room, {
    userId: session.userId,
    peerId: session.peer.id,
    body,
    clientId: payload.clientId ?? null, // dedupe key: the outbox may retry after a reconnect
  });

  io.to(roomChannel(session.roomId)).emit('chat:message', { roomId: session.roomId, message });
  return { messageId: message.id, clientId: payload.clientId ?? null };
}

async function onPollCreate({ io }, payload, session) {
  const poll = await Poll.create(session.room, {
    question: payload.question,
    options: payload.options,
    anonymous: Boolean(payload.anonymous),
    createdBy: session.peer.id,
  });
  io.to(roomChannel(session.roomId)).emit('poll:opened', { roomId: session.roomId, poll });
  return poll;
}

async function onPollVote({ io }, payload, session) {
  const tally = await Poll.vote(session.room, {
    pollId: payload.pollId,
    optionId: payload.optionId,
    peerId: session.peer.id,
  });
  io.to(hostChannel(session.roomId)).emit('poll:tally', { roomId: session.roomId, pollId: payload.pollId, tally });
  return { voted: true };
}

async function onPollClose({ io }, payload, session) {
  const result = await Poll.close(session.room, payload.pollId);
  io.to(roomChannel(session.roomId)).emit('poll:closed', { roomId: session.roomId, poll: result });
  return result;
}

/* ------------------------------------------------------------------ *
 * Moderation and the waiting room (F1)
 * ------------------------------------------------------------------ */

async function onAdmit({ io }, payload, session) {
  const admitted = await ModerationControls.admit(session.room, payload.userId, { by: session.userId });
  io.to(roomChannel(session.roomId)).emit('waitingRoom:admitted', { roomId: session.roomId, userId: payload.userId });
  io.to(hostChannel(session.roomId)).emit('waitingRoom:updated', {
    roomId: session.roomId,
    pending: await ModerationControls.listWaiting(session.room),
  });
  return admitted;
}

async function onDeny({ io }, payload, session) {
  await ModerationControls.deny(session.room, payload.userId, { by: session.userId, reason: payload.reason ?? null });
  io.to(roomChannel(session.roomId)).emit('waitingRoom:denied', { roomId: session.roomId, userId: payload.userId });
  return { denied: true };
}

async function onMute({ io }, payload, session) {
  const source = payload.source === 'chat' ? 'chat' : payload.source === 'cam' ? 'cam' : 'mic';
  const target = await ModerationControls.mute(session.room, payload.peerId, source, { by: session.userId });
  io.to(roomChannel(session.roomId)).emit('moderation:muted', {
    roomId: session.roomId,
    peerId: payload.peerId,
    source,
  });
  return target;
}

async function onMuteAll({ io }, payload, session) {
  const result = await ModerationControls.muteAll(session.room, {
    source: payload.source ?? 'mic',
    exceptHosts: payload.exceptHosts !== false,
    allowUnmute: Boolean(payload.allowUnmute),
    by: session.userId,
  });
  io.to(roomChannel(session.roomId)).emit('moderation:mutedAll', { roomId: session.roomId, ...result });
  return result;
}

async function onRemove({ io }, payload, session) {
  if (payload.peerId === session.peer.id) fail('INVALID_PAYLOAD', 'You cannot remove yourself');
  const removed = await ModerationControls.remove(session.room, payload.peerId, {
    by: session.userId,
    ban: Boolean(payload.ban),
  });

  io.to(roomChannel(session.roomId)).emit('moderation:removed', {
    roomId: session.roomId,
    peerId: payload.peerId,
    ban: Boolean(payload.ban),
  });

  // Disconnect the target's socket so it cannot simply keep its transports open.
  const sockets = await io.in(roomChannel(session.roomId)).fetchSockets();
  for (const other of sockets) {
    if (other.data.session?.peer.id === payload.peerId) other.disconnect(true);
  }
  return removed;
}

async function onLock({ io }, payload, session) {
  const locked = Boolean(payload.locked);
  await ModerationControls.setLocked(session.room, locked, { by: session.userId });
  io.to(roomChannel(session.roomId)).emit('moderation:lockChanged', { roomId: session.roomId, locked });
  return { locked };
}

async function onHandover({ io }, payload, session) {
  const result = await ModerationControls.handoverHost(session.room, {
    toPeerId: payload.peerId,
    by: session.peer.id,
    keepCohost: payload.keepCohost !== false,
  });

  const sockets = await io.in(roomChannel(session.roomId)).fetchSockets();
  for (const other of sockets) {
    const peerId = other.data.session?.peer?.id;
    if (!peerId) continue;
    if (result.hosts.includes(peerId)) await other.join(hostChannel(session.roomId));
    else await other.leave(hostChannel(session.roomId));
  }

  io.to(roomChannel(session.roomId)).emit('moderation:hostChanged', { roomId: session.roomId, ...result });
  return result;
}

/* ------------------------------------------------------------------ *
 * Breakout rooms (F1)
 * ------------------------------------------------------------------ */

/**
 * Child rooms are real rooms with `breakoutParent` set. The client leaves and rejoins
 * through the normal join path — no second transport model, no special-cased peer.
 */
async function onBreakoutOpen({ io }, payload, session) {
  const plan = await BreakoutManager.open(session.room, {
    count: payload.count,
    assignment: payload.assignment ?? 'auto', // 'auto' | 'manual'
    durationMinutes: payload.durationMinutes ?? null,
    by: session.peer.id,
  });

  io.to(roomChannel(session.roomId)).emit('breakout:opened', { roomId: session.roomId, rooms: plan.rooms });
  for (const assignment of plan.assignments) {
    io.to(roomChannel(session.roomId)).emit('breakout:assigned', {
      roomId: session.roomId,
      peerId: assignment.peerId,
      breakoutRoomId: assignment.breakoutRoomId,
      autoJoinAt: plan.autoJoinAt ?? null,
    });
  }
  return plan;
}

async function onBreakoutAssign({ io }, payload, session) {
  const assignment = await BreakoutManager.assign(session.room, {
    peerId: payload.peerId,
    breakoutRoomId: payload.breakoutRoomId,
    by: session.peer.id,
  });
  io.to(roomChannel(session.roomId)).emit('breakout:assigned', { roomId: session.roomId, ...assignment });
  return assignment;
}

async function onBreakoutBroadcast({ io }, payload, session) {
  const body = String(payload.body ?? '').trim();
  if (!body) fail('INVALID_PAYLOAD', 'Empty broadcast');

  const targets = await BreakoutManager.children(session.room);
  for (const childRoomId of targets) {
    io.to(roomChannel(childRoomId)).emit('breakout:broadcast', {
      roomId: childRoomId,
      from: session.peer.displayName,
      body,
      at: Date.now(),
    });
  }
  return { delivered: targets.length };
}

async function onBreakoutRecall({ io }, payload, session) {
  const result = await BreakoutManager.recall(session.room, {
    graceSeconds: Number(payload.graceSeconds ?? 30),
    by: session.peer.id,
  });

  for (const childRoomId of result.rooms) {
    io.to(roomChannel(childRoomId)).emit('breakout:recalled', {
      roomId: childRoomId,
      returnTo: session.roomId,
      at: result.recallAt,
    });
  }
  return result;
}

export default registerSocketHandlers;