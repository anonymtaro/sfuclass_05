/**
 * chatFanoutWorker — unread counters, mentions (F6)
 *
 * The send path does the minimum: persist the message, emit it to the Socket.IO room, ack.
 * Everything that can happen a beat later happens here, because chat delivery latency is an
 * alarm (p95 under a second) and counting badges for a 500-person channel is not something
 * the sender should wait for.
 *
 * What "a beat later" must still guarantee:
 *  - Counters are exact, not approximate. They are Redis INCRs keyed per participant, and
 *    the job is idempotent per message so a redelivered job cannot double-count: a set
 *    marker per (message, participant) gates the increment.
 *  - A participant who is actively looking at the conversation is not incremented, and
 *    their read marker moves instead. Otherwise the badge appears and clears every time
 *    somebody types.
 *  - Push is only for people who are offline everywhere. That decision is made here and
 *    handed to the notify queue, which owns preferences and quiet hours.
 *
 * Ordering is not guaranteed between jobs, and it does not need to be: counters are
 * commutative, and the read marker keeps the furthest message it has seen.
 */

import { defineWorker, enqueue, QUEUE_NAMES, PermanentJobError } from '../queues.js';
import { utilityConnection } from '../connection.js';
import * as UnreadService from '../../messaging/UnreadService.js';
import * as ConversationService from '../../messaging/ConversationService.js';
import * as DirectMessageService from '../../messaging/DirectMessageService.js';
import * as ChatSearchService from '../../messaging/ChatSearchService.js';
import * as PresenceService from '../../community/PresenceService.js';
import { metrics } from '../../observability/metrics.js';

const redis = utilityConnection('chat-fanout');

/** How long the per-message dedupe marker lives. Longer than any plausible retry chain. */
const FANOUT_MARKER_TTL_SECONDS = 3600;

const handlers = {
  'chat.message.fanout': fanoutMessage,
  'chat.message.index': indexMessage,
  'chat.read.sync': syncRead,
};

export function createChatFanoutWorker() {
  return defineWorker(QUEUE_NAMES.CHAT, async (job, log) => {
    const handler = handlers[job.name];
    if (!handler) throw new PermanentJobError(`Unknown chat job: ${job.name}`);
    return handler(job, log);
  });
}

/* ------------------------------------------------------------------ *
 * Fan-out
 * ------------------------------------------------------------------ */

async function fanoutMessage(job, log) {
  const { messageId, conversationId, channelId, senderId, preview, mentions = [] } = job.data;
  if (!messageId || (!conversationId && !channelId)) {
    throw new PermanentJobError('chat fan-out needs a messageId and a conversation or channel');
  }

  const scopeId = conversationId ?? channelId;
  const participants = conversationId
    ? await ConversationService.participantIds(conversationId)
    : await ConversationService.channelSubscriberIds(channelId);

  const mentioned = new Set(mentions);
  const offline = [];
  let incremented = 0;
  let skipped = 0;

  for (const userId of participants) {
    if (userId === senderId) {
      // The sender has read it by definition; move their marker instead of counting.
      await UnreadService.setReadMarker({ scopeId, userId, messageId });
      continue;
    }

    // Idempotency gate: one increment per (message, participant), whatever the retries do.
    const marker = `chat:fanout:${messageId}:${userId}`;
    const first = await redis.set(marker, '1', 'EX', FANOUT_MARKER_TTL_SECONDS, 'NX');
    if (!first) {
      skipped += 1;
      continue;
    }

    const presence = await PresenceService.get(userId);
    const viewing = presence?.viewing === scopeId;

    if (viewing) {
      // Looking straight at it — treat it as read rather than flashing a badge.
      await UnreadService.setReadMarker({ scopeId, userId, messageId });
      continue;
    }

    await UnreadService.increment({ scopeId, userId, mention: mentioned.has(userId) });
    incremented += 1;

    const reachable = presence?.state === 'online' || presence?.state === 'in-class';
    if (!reachable) offline.push(userId);
  }

  // Badge fan-out over the Socket.IO Redis adapter: every API task, every device.
  await UnreadService.publishBadges({ scopeId, userIds: participants.filter((id) => id !== senderId) });

  if (offline.length > 0) {
    const sender = await ConversationService.describeSender(senderId);
    await enqueue(
      QUEUE_NAMES.NOTIFY,
      'notification.fanout',
      {
        kind: channelId ? 'chat.channel.message' : 'chat.direct.message',
        recipientIds: offline,
        actorId: senderId,
        title: sender.displayName,
        body: preview,
        url: conversationId ? `/chat/${conversationId}` : `/channels/${channelId}`,
        // Three messages in two minutes is one push, not three.
        dedupeKey: `chat:${scopeId}`,
        channels: ['push', 'in-app'],
        data: { conversationId: conversationId ?? null, channelId: channelId ?? null, messageId },
      },
      { jobId: `chat-push:${messageId}` },
    );
  }

  // Mentions are louder than a message: they bypass the per-conversation dedupe.
  const mentionedOffline = mentions.filter((id) => id !== senderId);
  if (mentionedOffline.length > 0) {
    await enqueue(
      QUEUE_NAMES.NOTIFY,
      'notification.fanout',
      {
        kind: 'chat.mention',
        recipientIds: mentionedOffline,
        actorId: senderId,
        title: 'You were mentioned',
        body: preview,
        url: conversationId ? `/chat/${conversationId}` : `/channels/${channelId}`,
        dedupeKey: `mention:${messageId}`,
        channels: ['push', 'in-app'],
      },
      { jobId: `chat-mention:${messageId}` },
    );
  }

  metrics.increment?.('chat_fanout_participants', incremented);
  log.debug({ messageId, participants: participants.length, incremented, skipped, offline: offline.length }, 'chat: fan-out done');
  return { participants: participants.length, incremented, skipped, pushed: offline.length };
}

/* ------------------------------------------------------------------ *
 * Search index
 * ------------------------------------------------------------------ */

/**
 * OpenSearch indexing is off the send path on purpose: a slow cluster must not slow down
 * message delivery, and a lost index entry is repairable by a reindex — a lost message is
 * not.
 */
async function indexMessage(job, log) {
  const { messageId } = job.data;
  const message = await DirectMessageService.getForIndex(messageId);

  if (!message || message.deletedAt) {
    await ChatSearchService.remove(messageId);
    return { removed: true };
  }

  await ChatSearchService.index(message);
  log.debug({ messageId }, 'chat: indexed');
  return { indexed: true };
}

/* ------------------------------------------------------------------ *
 * Read state
 * ------------------------------------------------------------------ */

/**
 * A read from one device has to clear the badge on the others. The HTTP route updates Redis
 * synchronously; this job persists the marker to Postgres and republishes the badge, so a
 * Redis flush does not resurrect an unread count the user already cleared.
 */
async function syncRead(job) {
  const { scopeId, userId, messageId } = job.data;
  await UnreadService.persistReadMarker({ scopeId, userId, messageId });
  await UnreadService.publishBadges({ scopeId, userIds: [userId] });
  return { synced: true };
}

export default createChatFanoutWorker;