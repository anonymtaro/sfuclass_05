// classroom-app/server/src/messaging/ChatModerationService.js
/**
 * Chat moderation  (F6)
 *
 * Reports, mutes, slow mode and retention — the controls a public channel needs
 * before it is opened to a whole tenant.
 *
 * The distinction that runs through this file is between *blocking* and
 * *moderation*. Blocking is personal and symmetric: one member decides they do
 * not want to hear from another, and nothing is removed. Moderation is
 * institutional: a moderator removes content for everyone, and every action
 * leaves an audit record naming who did it and why.
 *
 * Deletion is always soft. The row survives with an empty body, because a
 * report about a message that no longer exists cannot be reviewed, and because
 * "who deleted this" is a question that gets asked.
 */

import { randomUUID } from 'node:crypto';
import { ApiError } from '@classroom/contracts';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { redis } from '../db/redis.js';
import { logger } from '../observability/logger.js';
import * as Message from './models/Message.js';

const log = logger.child({ component: 'chat-moderation' });

// ---------------------------------------------------------------------------
// Slow mode
// ---------------------------------------------------------------------------

const slowKey = (channelId, userId) => `${env.REDIS_PREFIX}:slow:${channelId}:${userId}`;

/**
 * Enforced per person per channel, in Redis, because it has to hold across
 * every API task. Moderators are exempt: slow mode exists to pace a busy room,
 * not to stop the person running it from answering.
 */
export const checkSlowMode = async ({ channelId, userId, seconds, isModerator = false }) => {
  const effective = seconds ?? env.CHAT_SLOW_MODE_SEC;
  if (!effective || isModerator) return true;

  const key = slowKey(channelId, userId);
  // SET NX EX: the key's existence *is* the cooldown, and it expires itself.
  const acquired = await redis.set(key, '1', 'EX', effective, 'NX');

  if (!acquired) {
    const ttl = await redis.ttl(key);
    throw new ApiError('slow_mode_active', {
      detail: `Slow mode is on. You can post again in ${Math.max(1, ttl)}s.`,
      retryAfter: Math.max(1, ttl),
    });
  }
  return true;
};

// ---------------------------------------------------------------------------
// Mutes
// ---------------------------------------------------------------------------

/**
 * A mute stops someone posting to a channel. Distinct from a member muting a
 * channel for themselves, which is a notification preference and lives on the
 * membership row.
 */
export const mute = async ({ channelId, userId, until = null, actorId, reason = null }) => {
  await pool.query(
    `INSERT INTO chat_mutes (mute_id, channel_id, user_id, muted_until, muted_by, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (channel_id, user_id)
     DO UPDATE SET muted_until = EXCLUDED.muted_until, muted_by = EXCLUDED.muted_by,
                   reason = EXCLUDED.reason, created_at = now()`,
    [randomUUID(), channelId, userId, until, actorId, reason],
  );

  await audit({ action: 'mute', actorId, targetUserId: userId, channelId, reason });
  log.info({ channelId, userId, until, actorId }, 'user muted');
  return true;
};

export const unmute = async ({ channelId, userId, actorId }) => {
  await pool.query(`DELETE FROM chat_mutes WHERE channel_id = $1 AND user_id = $2`, [
    channelId,
    userId,
  ]);
  await audit({ action: 'unmute', actorId, targetUserId: userId, channelId });
  return true;
};

/** Called on every send. One indexed lookup; an expired mute is not a mute. */
export const assertNotMuted = async ({ userId, target }) => {
  if (target.kind !== 'channel') return true;

  const { rows } = await pool.query(
    `SELECT muted_until FROM chat_mutes
      WHERE channel_id = $1 AND user_id = $2
        AND (muted_until IS NULL OR muted_until > now())
      LIMIT 1`,
    [target.channelId, userId],
  );

  if (rows.length === 0) return true;

  const until = rows[0].muted_until;
  throw new ApiError('forbidden', {
    detail: until
      ? `You are muted in this channel until ${new Date(until).toISOString()}.`
      : 'You are muted in this channel.',
  });
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * Filing a report never fails from the reporter's side. A duplicate is folded
 * into the existing one rather than rejected — telling someone "you already
 * reported this" when they are upset is not a useful interaction.
 */
export const report = async ({ messageId, reporterId, reason, detail = null }) => {
  const message = await Message.findById(messageId);
  if (!message) throw new ApiError('not_found', { detail: 'Message not found.' });

  const reportId = randomUUID();

  const { rows } = await pool.query(
    `INSERT INTO chat_reports (report_id, message_id, reported_user_id, reporter_id, reason, detail, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'received', now())
     ON CONFLICT (message_id, reporter_id) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail
     RETURNING report_id, status, created_at`,
    [reportId, messageId, message.author_id, reporterId, reason, detail],
  );

  log.warn({ messageId, reporterId, reason }, 'message reported');
  return { reportId: rows[0].report_id, status: rows[0].status, createdAt: rows[0].created_at };
};

// ---------------------------------------------------------------------------
// Actions on content
// ---------------------------------------------------------------------------

/**
 * Called by a moderator, and by classroom/interaction/LiveChat.js when a host
 * removes a message from a lesson.
 */
export const moderateMessage = async ({ messageId, action, actorId, reason = null }) => {
  if (action === 'delete') {
    const { remove } = await import('./DirectMessageService.js');
    await remove({ messageId, userId: actorId, asModerator: true });
    await audit({ action: 'delete-message', actorId, messageId, reason });
    return true;
  }

  if (action === 'restore') {
    // Restores visibility but not content: the body was cleared on delete, and
    // a restore that invented text would be worse than none.
    await pool.query(
      `UPDATE messages SET deleted_at = NULL, deleted_by = NULL WHERE message_id = $1`,
      [messageId],
    );
    await audit({ action: 'restore-message', actorId, messageId, reason });
    return true;
  }

  throw new ApiError('validation_failed', { detail: `Unknown action: ${action}` });
};

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Deletes messages past the retention window and returns the assets that went
 * with them, so the caller can remove them from S3.
 *
 * Runs in batches from jobs/pruneChatRetention.js. CHAT_RETENTION_DAYS of 0
 * means keep everything, which is the default.
 */
export const pruneExpired = async ({ days = env.CHAT_RETENTION_DAYS, batchSize = 1_000 } = {}) => {
  if (!days || days <= 0) return { deleted: 0, assetIds: [] };

  const { assetsForMessages } = await import('./models/MessageAttachment.js');

  // Assets first: once the message rows are gone, the join that finds them is
  // gone too.
  const { rows } = await pool.query(
    `SELECT message_id FROM messages
      WHERE created_at < now() - ($1 || ' days')::interval
      ORDER BY created_at ASC LIMIT $2`,
    [days, batchSize],
  );

  const messageIds = rows.map((row) => row.message_id);
  if (messageIds.length === 0) return { deleted: 0, assetIds: [] };

  const assetIds = await assetsForMessages(messageIds);
  await pool.query(`DELETE FROM messages WHERE message_id = ANY($1::uuid[])`, [messageIds]);

  const { removeFromIndex } = await import('./ChatSearchService.js');
  for (const messageId of messageIds) await removeFromIndex(messageId).catch(() => undefined);

  log.info({ deleted: messageIds.length, assets: assetIds.length, days }, 'chat retention applied');
  return { deleted: messageIds.length, assetIds };
};

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Append-only. Every moderation action is attributable, afterwards. */
const audit = async (entry) => {
  const { record } = await import('../security/auditLog.js');
  await record({ domain: 'chat', ...entry }).catch((cause) =>
    log.error({ err: cause, entry }, 'audit write failed'),
  );
};

export default { checkSlowMode, assertNotMuted, mute, report, moderateMessage, pruneExpired };