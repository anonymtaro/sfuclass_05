// classroom-app/server/src/messaging/DirectMessageService.js
/**
 * Sending, editing, deleting and reading messages  (F6)
 *
 * Despite the name this handles every target — direct, channel and room. The
 * name is the tree's; the behaviour is shared, because splitting send into
 * three implementations is how three subtly different sets of rules appear.
 *
 * The send path is the important one, and its order is deliberate:
 *
 *   1. authorise      may this person write here at all
 *   2. rate and slow  cheap rejections before any write
 *   3. insert         idempotent on client_message_id
 *   4. attachments
 *   5. broadcast      the socket fan-out, immediately
 *   6. side effects   unread counters, notifications, search — all after the
 *                     message is already on everyone's screen
 *
 * Steps 5 and 6 are in that order on purpose. A slow search index or a slow push
 * provider must never delay a message that has already been accepted.
 */

import { randomUUID } from 'node:crypto';
import { ApiError } from '@classroom/contracts';
import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';
import * as Message from './models/Message.js';
import * as Attachment from './models/MessageAttachment.js';
import * as Participant from './models/Participant.js';
import * as Channel from './models/Channel.js';
import * as Block from './models/Block.js';
import * as Conversation from './models/Conversation.js';
import { assertParticipant } from './ConversationService.js';
import { checkSlowMode, assertNotMuted } from './ChatModerationService.js';

const log = logger.child({ component: 'messages' });

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

const authoriseWrite = async ({ target, userId }) => {
  switch (target.kind) {
    case 'conversation': {
      await assertParticipant({ conversationId: target.conversationId, userId });

      // A block inside an existing DM still stops the message. The
      // conversation predates the block; the message does not.
      const participants = await Participant.listForConversation(target.conversationId);
      const others = participants.filter((participant) => participant.user_id !== userId);

      for (const other of others) {
        const { blocked } = await Block.areBlocked(userId, other.user_id);
        if (blocked) {
          throw new ApiError('blocked_by_user', {
            detail: 'You can no longer send messages in this conversation.',
          });
        }
      }
      return { recipients: others.map((participant) => participant.user_id) };
    }

    case 'channel': {
      const channel = await Channel.findById(target.channelId);
      if (!channel) throw new ApiError('not_found', { detail: 'Channel not found.' });

      if (!(await Channel.canRead({ channelId: target.channelId, userId }))) {
        throw new ApiError('forbidden', { detail: 'You are not a member of this channel.' });
      }
      if (channel.read_only) {
        throw new ApiError('forbidden', { detail: 'This channel is read-only.' });
      }

      await checkSlowMode({ channelId: target.channelId, userId, seconds: channel.slow_mode_sec });
      return { recipients: [], channel };
    }

    default:
      // Room chat is authorised by being in the room, which the socket
      // handshake already established.
      return { recipients: [] };
  }
};

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export const send = async ({ target, authorId, tenantId, body, attachmentIds = [], replyToId = null, clientMessageId }) => {
  const text = String(body ?? '').trim();

  if (!text && attachmentIds.length === 0) {
    throw new ApiError('validation_failed', { detail: 'A message needs text or an attachment.' });
  }
  if (text.length > env.CHAT_MAX_MESSAGE_LEN) {
    throw new ApiError('message_too_long', {
      detail: `Messages are limited to ${env.CHAT_MAX_MESSAGE_LEN} characters.`,
    });
  }

  await assertNotMuted({ userId: authorId, target });
  const { recipients } = await authoriseWrite({ target, userId: authorId });

  const row = await Message.insert({
    messageId: randomUUID(),
    tenantId,
    target,
    authorId,
    body: text,
    replyToId,
    clientMessageId: clientMessageId ?? null,
  });

  // The insert is idempotent, so a replayed send returns the original row and
  // everything below must be safe to repeat.
  if (attachmentIds.length > 0) {
    await Attachment.attach({ messageId: row.message_id, assetIds: attachmentIds });
  }

  const attachments = await Attachment.listForMessage(row.message_id);
  const message = Message.toMessage(row, { attachments, viewerId: authorId });

  if (target.kind === 'conversation') {
    await Conversation.touch(target.conversationId);
  }

  // On screen now. Everything after this is bookkeeping.
  void deliver({ message, target, authorId, recipients }).catch((cause) =>
    log.error({ err: cause, messageId: row.message_id }, 'post-send fan-out failed'),
  );

  return message;
};

/**
 * Everything that happens after a message is visible. Failures here are logged
 * and swallowed: a missing search index entry is a degraded search, not a lost
 * message.
 */
const deliver = async ({ message, target, authorId, recipients }) => {
  const { broadcastMessage } = await import('./chatGateway.js');
  broadcastMessage({ message, target });

  const { incrementUnread } = await import('./UnreadService.js');
  await incrementUnread({ target, authorId, recipients, message });

  const { indexMessage } = await import('./ChatSearchService.js');
  await indexMessage(message);

  // Push is delayed and conditional; the worker decides, not this path.
  const { enqueueChatNotification } = await import('../queues/queues.js');
  await enqueueChatNotification({
    messageId: message.messageId,
    target,
    authorId,
    recipients,
  });
};

// ---------------------------------------------------------------------------
// Edit and delete
// ---------------------------------------------------------------------------

export const edit = async ({ messageId, userId, body }) => {
  const row = await Message.findById(messageId);
  if (!row) throw new ApiError('not_found', { detail: 'Message not found.' });
  if (row.author_id !== userId) {
    throw new ApiError('forbidden', { detail: 'You can only edit your own messages.' });
  }
  if (row.deleted_at) {
    throw new ApiError('gone', { detail: 'This message was deleted.' });
  }

  // A window, not forever. Editing a message somebody replied to an hour ago
  // rewrites a conversation other people already read.
  const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60_000;
  if (env.CHAT_EDIT_WINDOW_MIN > 0 && ageMin > env.CHAT_EDIT_WINDOW_MIN) {
    throw new ApiError('conflict', {
      detail: `Messages can be edited for ${env.CHAT_EDIT_WINDOW_MIN} minutes after sending.`,
    });
  }

  const updated = await Message.update({ messageId, body: String(body).trim() });
  const attachments = await Attachment.listForMessage(messageId);
  const message = Message.toMessage(updated, { attachments, viewerId: userId });

  const { broadcastUpdate } = await import('./chatGateway.js');
  broadcastUpdate({ message });

  const { indexMessage } = await import('./ChatSearchService.js');
  await indexMessage(message).catch(() => undefined);

  return message;
};

export const remove = async ({ messageId, userId, asModerator = false }) => {
  const row = await Message.findById(messageId);
  if (!row) throw new ApiError('not_found', { detail: 'Message not found.' });

  if (!asModerator && row.author_id !== userId) {
    throw new ApiError('forbidden', { detail: 'You can only delete your own messages.' });
  }

  const deleted = await Message.softDelete({
    messageId,
    deletedBy: asModerator ? 'moderator' : 'author',
  });
  if (!deleted) return null;

  const { broadcastDelete } = await import('./chatGateway.js');
  broadcastDelete({
    target: Message.toMessage(row, {}).target,
    messageId,
    deletedBy: asModerator ? 'moderator' : 'author',
    deletedAt: deleted.deleted_at,
  });

  const { removeFromIndex } = await import('./ChatSearchService.js');
  await removeFromIndex(messageId).catch(() => undefined);

  return { messageId, deletedAt: deleted.deleted_at };
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * A page of history, with attachments resolved and signed in one pass rather
 * than per message.
 */
export const history = async ({ target, viewerId, cursor, limit = 25, order = 'desc', around = null }) => {
  await authoriseRead({ target, userId: viewerId });

  const page = around
    ? await Message.listAround({ target, messageId: around, limit })
    : await Message.listByTarget({ target, cursor, limit, order });

  const ids = page.rows.map((row) => row.message_id);
  const attachmentsByMessage = await Attachment.listForMessages(ids);

  const { signAttachments } = await import('./ChatAttachmentService.js');

  const items = await Promise.all(
    page.rows.map(async (row) =>
      Message.toMessage(row, {
        attachments: await signAttachments(attachmentsByMessage.get(row.message_id) ?? []),
        viewerId,
      }),
    ),
  );

  return { items, nextCursor: page.nextCursor, hasMore: page.hasMore };
};

export const authoriseRead = async ({ target, userId }) => {
  if (target.kind === 'conversation') {
    await assertParticipant({ conversationId: target.conversationId, userId });
    return true;
  }
  if (target.kind === 'channel') {
    if (!(await Channel.canRead({ channelId: target.channelId, userId }))) {
      throw new ApiError('not_found', { detail: 'Channel not found.' });
    }
  }
  return true;
};

export default { send, edit, remove, history, authoriseRead };