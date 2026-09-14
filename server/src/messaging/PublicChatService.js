// classroom-app/server/src/messaging/PublicChatService.js
/**
 * Channels  (F6)
 *
 * The public lobby, space channels, course channels, and the persistence side
 * of in-lesson chat.
 *
 * A channel differs from a conversation in exactly one way that matters: its
 * history is readable by anyone in scope, including from before they joined. A
 * learner who enrols in week six can read weeks one to five. That is why
 * membership rows here carry preferences rather than permission — deleting one
 * does not remove access, and the scope check is what gates a read.
 *
 * Auto-provisioning lives here too. SpaceService and CourseService call
 * `ensureChannelFor` on publish, and it has to be safe to call repeatedly
 * because publishing happens more than once.
 */

import { randomUUID } from 'node:crypto';
import { ApiError } from '@classroom/contracts';
import { logger } from '../observability/logger.js';
import * as Channel from './models/Channel.js';
import * as Participant from './models/Participant.js';
import * as Message from './models/Message.js';

const log = logger.child({ component: 'channels' });

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/** One lobby per tenant, created on setup and never deleted. */
export const ensureLobby = async ({ tenantId, name = 'General' }) => {
  const existing = await Channel.findPublicLobby(tenantId);
  if (existing) return existing;

  log.info({ tenantId }, 'creating the tenant lobby');
  return Channel.ensureForScope({
    channelId: randomUUID(),
    tenantId,
    scope: 'public',
    scopeRefId: null,
    name,
  });
};

/**
 * Idempotent. Called on every course publish and every space creation, so the
 * second publish must find the first channel rather than making another.
 */
export const ensureChannelFor = async ({ tenantId, scope, scopeRefId, name }) => {
  if (scope !== 'space' && scope !== 'course') {
    throw new ApiError('validation_failed', { detail: 'A channel is bound to a space or a course.' });
  }

  const channel = await Channel.ensureForScope({
    channelId: randomUUID(),
    tenantId,
    scope,
    scopeRefId,
    name,
  });

  log.info({ channelId: channel.channel_id, scope, scopeRefId }, 'channel ready');
  return channel;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const list = async ({ userId, tenantId, scope, limit }) => {
  const rows = await Channel.listForUser({ userId, tenantId, scope, limit });

  const items = await Promise.all(
    rows.map(async (row) =>
      Channel.toChannel(row, {
        unreadCount: Number(row.unread_count ?? 0),
        muted: row.muted ?? false,
        memberCount: await Channel.memberCount(row.channel_id),
      }),
    ),
  );

  return { items, nextCursor: null, hasMore: false };
};

export const getById = async ({ channelId, userId }) => {
  const row = await Channel.findById(channelId);
  if (!row) throw new ApiError('not_found', { detail: 'Channel not found.' });

  if (!(await Channel.canRead({ channelId, userId }))) {
    throw new ApiError('not_found', { detail: 'Channel not found.' });
  }

  return Channel.toChannel(row, { memberCount: await Channel.memberCount(channelId) });
};

/**
 * Joining records a preference row. It does not grant access — the scope
 * already did — so this is really "start tracking my unread count here".
 */
export const join = async ({ channelId, userId }) => {
  if (!(await Channel.canRead({ channelId, userId }))) {
    throw new ApiError('forbidden', { detail: 'You cannot join this channel.' });
  }

  await Participant.markChannelRead({
    channelId,
    userId,
    readAt: new Date().toISOString(),
  });

  return getById({ channelId, userId });
};

export const setMuted = ({ channelId, userId, muted }) =>
  Participant.setChannelMuted({ channelId, userId, muted });

// ---------------------------------------------------------------------------
// Live lesson chat
// ---------------------------------------------------------------------------

/**
 * Called by classroom/interaction/LiveChat.js, *after* the message has already
 * been broadcast to the room.
 *
 * The lesson panel is not a second chat system: it writes into this same table
 * with `target: { kind: 'room' }`, which is what lets a learner who missed the
 * class read it afterwards in the ordinary thread view.
 *
 * A failure here loses the message from the archive but not from the lesson,
 * which is the right way round — so this throws rather than swallowing, and the
 * caller logs it.
 */
export const persistRoomMessage = async ({ message, roomId, lessonId, authorId, tenantId }) => {
  const row = await Message.insert({
    messageId: message.messageId,
    tenantId,
    target: { kind: 'room', roomId },
    authorId,
    kind: message.kind ?? 'text',
    body: message.body,
    replyToId: message.replyToId ?? null,
    clientMessageId: message.clientMessageId ?? null,
  });

  // Indexed so the lesson transcript is searchable with everything else.
  const { indexMessage } = await import('./ChatSearchService.js');
  await indexMessage(Message.toMessage(row, {}), { lessonId }).catch(() => undefined);

  return row.message_id;
};

/** The lesson's chat, read back after the room has ended. */
export const roomHistory = async ({ roomId, viewerId, cursor, limit = 50 }) => {
  const { history } = await import('./DirectMessageService.js');
  return history({ target: { kind: 'room', roomId }, viewerId, cursor, limit, order: 'asc' });
};

// ---------------------------------------------------------------------------
// Moderation surface
// ---------------------------------------------------------------------------

export const setSlowMode = async ({ channelId, seconds, actorId }) => {
  const row = await Channel.setSlowMode(channelId, seconds);
  log.info({ channelId, seconds, actorId }, 'slow mode changed');

  const { broadcastChannelUpdate } = await import('./chatGateway.js');
  broadcastChannelUpdate({ channel: Channel.toChannel(row, {}) });

  return Channel.toChannel(row, {});
};

export default { ensureLobby, ensureChannelFor, list, getById, join, persistRoomMessage };