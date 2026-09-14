// classroom-app/server/src/classroom/interaction/LiveChat.js
/**
 * In-session chat  (F1, F6)  [EXT]
 *
 * The chat panel in a lesson is not a second chat system. It writes into
 * messaging/ with `target: { kind: 'room', roomId }`, which means one message
 * table, one moderation path, one search index, one retention rule.
 *
 * That decision is what makes a lesson readable afterwards. A learner who
 * missed the class opens the room thread and sees what was said, in the same
 * component that renders every other conversation — rather than a transcript
 * that lives somewhere else and behaves differently.
 *
 * The fast path is still the classroom socket, because everyone in the room is
 * already connected to it. Persistence happens behind that: the message is
 * broadcast immediately and written asynchronously, so a slow database never
 * delays a message in a live lesson.
 */

import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../observability/logger.js';
import { recordInteraction } from '../AttendanceService.js';

const log = logger.child({ component: 'live-chat' });

/**
 * Recent messages, kept in memory so a late joiner sees context immediately
 * without a database round trip. The durable copy is in messaging/.
 */
const BUFFER_SIZE = 50;
const buffers = new Map();

const bufferFor = (roomId) => {
  let buffer = buffers.get(roomId);
  if (!buffer) {
    buffer = [];
    buffers.set(roomId, buffer);
  }
  return buffer;
};

export const send = async (room, peer, { body, clientMessageId, replyToId = null }) => {
  const text = String(body ?? '').trim();

  if (!text) {
    return { ok: false, code: 'validation_failed', reason: 'empty message' };
  }
  if (text.length > env.CHAT_MAX_MESSAGE_LEN) {
    return { ok: false, code: 'message_too_long' };
  }

  const message = {
    messageId: randomUUID(),
    target: { kind: 'room', roomId: room.id },
    kind: 'text',
    author: peer.toJSON().user,
    body: text,
    mentions: [],
    attachments: [],
    replyToId,
    reactions: [],
    clientMessageId: clientMessageId ?? null,
    editedAt: null,
    deletedAt: null,
    deletedBy: null,
    createdAt: new Date().toISOString(),
  };

  // Broadcast first. In a live lesson, latency is the feature.
  room.broadcast('chat:message.new', { message, clientMessageId: message.clientMessageId });

  const buffer = bufferFor(room.id);
  buffer.push(message);
  if (buffer.length > BUFFER_SIZE) buffer.shift();

  recordInteraction(room.id, peer.user.userId, 'messages');

  // Persist behind the broadcast. A failure here loses the message from the
  // history but not from the lesson, which is the right way round.
  void import('../../messaging/PublicChatService.js')
    .then(({ persistRoomMessage }) =>
      persistRoomMessage({
        message,
        roomId: room.id,
        lessonId: room.lessonId,
        authorId: peer.user.userId,
      }),
    )
    .catch((cause) => log.error({ err: cause, roomId: room.id }, 'live chat message not persisted'));

  return { ok: true, message };
};

/** What a late joiner is shown before their client fetches the real history. */
export const recent = (roomId) => [...(buffers.get(roomId) ?? [])];

/**
 * Host deletion. Removes it for everyone and marks the stored copy deleted —
 * the row survives for the audit trail, as everywhere else in messaging/.
 */
export const remove = async (room, actor, messageId) => {
  if (!actor?.canModerate) {
    throw Object.assign(new Error('only a host may delete messages'), { code: 'not_room_host' });
  }

  const buffer = bufferFor(room.id);
  const index = buffer.findIndex((message) => message.messageId === messageId);
  if (index >= 0) buffer.splice(index, 1);

  room.broadcast('chat:message.deleted', {
    target: { kind: 'room', roomId: room.id },
    messageId,
    deletedBy: 'moderator',
    deletedAt: new Date().toISOString(),
  });

  const { moderateMessage } = await import('../../messaging/ChatModerationService.js');
  await moderateMessage({ messageId, action: 'delete', actorId: actor.user.userId }).catch(
    (cause) => log.error({ err: cause, messageId }, 'stored copy not marked deleted'),
  );

  return true;
};

/** The room ended. The durable history stays; only the buffer goes. */
export const clearRoom = (roomId) => buffers.delete(roomId);
export const resetLiveChat = () => buffers.clear();

export default { send, recent, remove };