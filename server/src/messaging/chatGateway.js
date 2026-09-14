// classroom-app/server/src/messaging/chatGateway.js
/**
 * Socket.IO /chat namespace  (F6)
 *
 * The fast path for messaging. Every event here has an HTTP twin in
 * messaging.routes.js, and both call the same services — the socket is an
 * optimisation for a connection that is already open, not a second
 * implementation with its own rules.
 *
 * Three things this file is responsible for:
 *
 *   Subscriptions. A client receives events only for targets it has joined.
 *   Without that, a member of two hundred channels pays for all of them on
 *   every keystroke anyone makes. Socket.IO rooms do the routing; the
 *   authorisation check before joining one is ours.
 *
 *   Cross-task fan-out. A sender on task A must reach a reader on task B. The
 *   Redis adapter handles it, which is why every broadcast below goes through
 *   the namespace rather than through a socket.
 *
 *   Catch-up. Reconnecting is not the same as being back: subscriptions are per
 *   connection and they are gone. `chat:sync` replays what changed since the
 *   client's cursor, which is the server half of core-client's `onResume`.
 */

import { ChatEvents, SOCKET_NAMESPACES, ApiError } from '@classroom/contracts';
import { logger } from '../observability/logger.js';
import { consumeSocketBudget } from '../middleware/rateLimit.js';
import * as DirectMessages from './DirectMessageService.js';
import * as Typing from './TypingService.js';
import * as Unread from './UnreadService.js';
import * as Block from './models/Block.js';
import * as Participant from './models/Participant.js';
import * as Receipt from './models/Receipt.js';

const { CHAT_CLIENT_EVENTS: CLIENT, CHAT_SERVER_EVENTS: SERVER } = ChatEvents;

const log = logger.child({ component: 'chat-gateway' });

/** Set at attach time; every broadcast helper below needs it. */
let namespace = null;

/** Socket.IO room name for a target. The one place this mapping exists. */
const roomOf = (target) => {
  switch (target.kind) {
    case 'conversation':
      return `c:${target.conversationId}`;
    case 'channel':
      return `ch:${target.channelId}`;
    default:
      return `r:${target.roomId}`;
  }
};

const ok = (data) => ({ ok: true, data });
const fail = (error) => ({
  ok: false,
  error: (ApiError.is(error)
    ? error
    : new ApiError('internal_error', { detail: 'Something went wrong.' })
  ).toJSON(),
});

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

export const attachChatGateway = (io) => {
  namespace = io.of(SOCKET_NAMESPACES.chat);

  namespace.use(async (socket, next) => {
    // The handshake is verified by authSocket; this only unpacks it.
    const { userId, tenantId } = socket.data.auth ?? {};
    if (!userId) return next(new Error('unauthenticated'));

    socket.data.userId = userId;
    socket.data.tenantId = tenantId;
    socket.data.subscriptions = new Set();

    // Loaded once per connection rather than per message: a busy channel
    // would otherwise query the block list hundreds of times a minute.
    socket.data.blocked = await Block.allRelatedIds(userId);

    next();
  });

  namespace.on('connection', (socket) => {
    const { userId } = socket.data;
    log.debug({ userId, socketId: socket.id }, 'chat socket connected');

    /** Wraps a handler with the per-connection event budget and error shaping. */
    const handle = (event, handler) => {
      socket.on(event, async (payload, ack) => {
        const budget = await consumeSocketBudget({ socketId: socket.id, userId, event });

        if (!budget.allowed) {
          socket.emit(SERVER.throttled, {
            target: payload?.target ?? null,
            reason: 'rate_limited',
            retryAfterSec: budget.retryAfterSec,
            until: null,
          });
          ack?.(fail(new ApiError('rate_limited', { retryAfter: budget.retryAfterSec })));
          return;
        }

        try {
          ack?.(ok(await handler(payload)));
        } catch (cause) {
          if (!ApiError.is(cause)) {
            log.error({ err: cause, event, userId }, 'chat handler failed');
          }
          ack?.(fail(cause));
        }
      });
    };

    // -----------------------------------------------------------------------
    // Subscriptions
    // -----------------------------------------------------------------------

    handle(CLIENT.subscribe, async ({ targets }) => {
      const joined = [];

      for (const target of targets) {
        // Authorised per target, every time. A client can send any id it
        // likes, and joining a Socket.IO room is granting it a feed.
        await DirectMessages.authoriseRead({ target, userId });
        const room = roomOf(target);
        await socket.join(room);
        socket.data.subscriptions.add(room);
        joined.push(target);
      }

      return { subscribed: joined.length };
    });

    handle(CLIENT.unsubscribe, async ({ targets }) => {
      for (const target of targets) {
        const room = roomOf(target);
        await socket.leave(room);
        socket.data.subscriptions.delete(room);
        await Typing.clearForUser({ target, userId });
      }
      return { unsubscribed: targets.length };
    });

    // -----------------------------------------------------------------------
    // Messages
    // -----------------------------------------------------------------------

    handle(CLIENT.send, async (payload) => {
      const message = await DirectMessages.send({
        target: payload.target,
        authorId: userId,
        tenantId: socket.data.tenantId,
        body: payload.body,
        attachmentIds: payload.attachmentIds,
        replyToId: payload.replyToId,
        clientMessageId: payload.clientMessageId,
      });

      // Sending implies you have stopped typing.
      await Typing.clearForUser({ target: payload.target, userId });
      return message;
    });

    handle(CLIENT.edit, ({ messageId, body }) =>
      DirectMessages.edit({ messageId, userId, body }),
    );

    handle(CLIENT.delete, ({ messageId }) => DirectMessages.remove({ messageId, userId }));

    handle(CLIENT.react, async ({ messageId, emoji, action }) => {
      const { react } = await import('./DirectMessageService.js');
      return react ? react({ messageId, userId, emoji, action }) : { messageId, emoji, action };
    });

    // -----------------------------------------------------------------------
    // Presence within a thread
    // -----------------------------------------------------------------------

    handle(CLIENT.typing, ({ target, typing }) =>
      Typing.setTyping({ target, userId, typing }),
    );

    handle(CLIENT.markRead, async ({ target, messageId }) => {
      const readAt = new Date().toISOString();

      if (target.kind === 'conversation') {
        await Participant.markRead({
          conversationId: target.conversationId,
          userId,
          readAt,
          messageId,
        });
        await Receipt.markReadThrough({
          conversationId: target.conversationId,
          userId,
          messageId,
          readAt,
        });

        // Only the other person needs to know, and only if receipts are on
        // for both of them.
        broadcastRead({ target, userId, lastReadMessageId: messageId, readAt });
      } else if (target.kind === 'channel') {
        await Participant.markChannelRead({ channelId: target.channelId, userId, readAt, messageId });
      }

      await Unread.clear({ userId, target });
      const summary = await Unread.summary({ userId });
      socket.emit(SERVER.unreadChanged, { summary, targets: await Unread.perTarget({ userId }) });

      return summary;
    });

    // -----------------------------------------------------------------------
    // Catch-up
    // -----------------------------------------------------------------------

    /**
     * Replays what changed while the client was away. Capped: past a certain
     * volume a refetch is cheaper than a replay, and `truncated` tells the
     * client to do exactly that.
     */
    handle(CLIENT.sync, async ({ targets }) => {
      const messages = [];
      let truncated = false;

      for (const entry of targets) {
        await DirectMessages.authoriseRead({ target: entry.target, userId });

        const page = await DirectMessages.history({
          target: entry.target,
          viewerId: userId,
          cursor: entry.since ?? undefined,
          limit: 100,
          order: 'asc',
        });

        if (page.hasMore) truncated = true;
        messages.push(...page.items);

        if (messages.length >= 500) {
          truncated = true;
          break;
        }
      }

      return { messages: messages.slice(0, 500), truncated, unread: await Unread.summary({ userId }) };
    });

    // -----------------------------------------------------------------------
    // Teardown
    // -----------------------------------------------------------------------

    socket.on('disconnect', async (reason) => {
      // A typing indicator left behind outlives the connection by its TTL,
      // which is long enough to look like a ghost.
      const targets = [...socket.data.subscriptions].map(parseRoom).filter(Boolean);
      await Typing.clearAll({ targets, userId }).catch(() => undefined);
      log.debug({ userId, reason }, 'chat socket disconnected');
    });
  });

  log.info({ namespace: SOCKET_NAMESPACES.chat }, 'chat gateway attached');
  return namespace;
};

const parseRoom = (room) => {
  const [prefix, id] = [room.slice(0, room.indexOf(':')), room.slice(room.indexOf(':') + 1)];
  if (prefix === 'c') return { kind: 'conversation', conversationId: id };
  if (prefix === 'ch') return { kind: 'channel', channelId: id };
  if (prefix === 'r') return { kind: 'room', roomId: id };
  return null;
};

// ---------------------------------------------------------------------------
// Broadcasts — called by the services, never by a socket handler directly
// ---------------------------------------------------------------------------

const emit = (target, event, payload) => {
  if (!namespace) return false;
  namespace.to(roomOf(target)).emit(event, payload);
  return true;
};

export const broadcastMessage = ({ message, target }) =>
  emit(target, SERVER.messageNew, { message, clientMessageId: message.clientMessageId ?? null });

export const broadcastUpdate = ({ message }) =>
  emit(message.target, SERVER.messageUpdated, { message });

export const broadcastDelete = ({ target, messageId, deletedBy, deletedAt }) =>
  emit(target, SERVER.messageDeleted, { target, messageId, deletedBy, deletedAt });

export const broadcastReaction = ({ target, messageId, emoji, userId, action, count }) =>
  emit(target, SERVER.reactionChanged, { target, messageId, emoji, userId, action, count });

export const broadcastTyping = ({ target, userId, typing, expiresAt }) =>
  emit(target, SERVER.typingChanged, { target, userId, typing, expiresAt });

export const broadcastRead = ({ target, userId, lastReadMessageId, readAt }) =>
  emit(target, SERVER.readChanged, { target, userId, lastReadMessageId, readAt });

export const broadcastAttachmentReady = (payload) =>
  emit(payload.target, SERVER.attachmentReady, payload);

export const broadcastChannelUpdate = ({ channel }) =>
  emit({ kind: 'channel', channelId: channel.channelId }, SERVER.channelUpdated, { channel });

/**
 * A new conversation has to reach a client that is not subscribed to it yet —
 * it did not exist a moment ago. Addressed to the user's personal room, which
 * every socket joins on connect.
 */
export const notifyConversationCreated = ({ conversation, userIds }) => {
  if (!namespace) return false;
  for (const userId of userIds) {
    namespace.to(`u:${userId}`).emit(SERVER.conversationCreated, { conversation });
  }
  return true;
};

export const notifyUnreadChanged = ({ userId, summary, targets }) => {
  if (!namespace) return false;
  namespace.to(`u:${userId}`).emit(SERVER.unreadChanged, { summary, targets });
  return true;
};

export default { attachChatGateway, broadcastMessage, broadcastTyping };