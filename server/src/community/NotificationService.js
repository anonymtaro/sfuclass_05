// classroom-app/server/src/community/NotificationService.js
/**
 * Notifications  (F2, F5, F6)  [NEW]
 *
 * One entry point — `notify()` — and three channels behind it: in-app, push and
 * email. Every caller in the platform uses this rather than reaching for SNS or
 * SES directly, which is what makes a single "do not disturb" setting actually
 * work.
 *
 * The routing decision is a pure function, `decideChannels`, for two reasons:
 * it is the part with all the rules in it, and it is the part that must behave
 * identically whether a notification is delivered now or by a queued job an
 * hour later.
 *
 * The rules, in the order they apply:
 *
 *   1. never notify someone about their own action
 *   2. an in-app entry is always written — the bell is a log, not a channel
 *   3. push only if the person is not already looking at it; a message from
 *      someone you are actively chatting with should not buzz your phone
 *   4. quiet hours suppress push, except for a lesson starting now
 *   5. email only for things that survive being read tomorrow
 */

import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';
import { notificationTypes, isWithinQuietHours } from '../config/push.config.js';
import * as Presence from './PresenceService.js';

const log = logger.child({ component: 'notifications' });

/** Types that justify an email. Everything else would be noise in an inbox. */
const EMAILABLE = new Set(['assignment.graded', 'course.completed', 'space.invite', 'lesson.reminder']);

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Pure. Given who, what and their settings, which channels fire.
 *
 * @returns {{ inApp: boolean, push: boolean, email: boolean, delayMinutes: number, reason?: string }}
 */
export const decideChannels = ({ type, settings = {}, presence = { state: 'offline' }, actorIsRecipient = false, now = new Date(), timeZone = 'UTC' }) => {
  if (actorIsRecipient) {
    return { inApp: false, push: false, email: false, delayMinutes: 0, reason: 'own action' };
  }

  const policy = notificationTypes[type] ?? {
    priority: 'normal', delayMinutes: 0, respectQuietHours: true,
  };

  // Always written. The bell shows what happened while you were away, and a
  // notification that was suppressed for push still belongs in that list.
  const decision = { inApp: true, push: false, email: false, delayMinutes: policy.delayMinutes ?? 0 };

  const pushAllowed =
    (type.startsWith('chat.') ? settings.dmPush !== false : settings.mentionPush !== false) &&
    type !== 'asset.ready';

  if (pushAllowed) {
    // Someone in a lesson is looking at their screen; a chat push would
    // interrupt the thing they are already doing.
    if (presence.state === 'in-class' && type.startsWith('chat.')) {
      decision.reason = 'recipient is in a lesson';
    } else if (presence.state === 'online' && policy.delayMinutes > 0) {
      // Delivered in-app immediately; push only if they stay silent.
      decision.push = true;
      decision.reason = 'deferred while active';
    } else {
      decision.push = true;
    }
  }

  if (decision.push && policy.respectQuietHours && settings.quietHours) {
    if (isWithinQuietHours(settings.quietHours, now, timeZone)) {
      decision.push = false;
      decision.reason = 'quiet hours';
    }
  }

  if (EMAILABLE.has(type)) {
    decision.email = type.startsWith('chat.') ? settings.dmEmail === true : true;
  }

  return decision;
};

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * @param {{ userId: string, type: string, title: string, body?: string, href: string,
 *           actorId?: string|null, data?: object }} input
 */
export const notify = async (input) => {
  const { userId, type, title, body = null, href, actorId = null, data = {} } = input;

  const settings = await loadSettings(userId);
  const presence = await Presence.get(userId);

  const decision = decideChannels({
    type,
    settings: settings.notifications,
    presence,
    actorIsRecipient: actorId === userId,
    timeZone: settings.timeZone,
  });

  if (!decision.inApp) return { delivered: [], reason: decision.reason };

  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, type, actor_id, title, body, href, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     RETURNING id, created_at`,
    [userId, type, actorId, title, body, href, JSON.stringify(data)],
  );

  const notification = {
    notificationId: rows[0].id,
    type,
    title,
    body,
    href,
    readAt: null,
    createdAt: rows[0].created_at.toISOString(),
  };

  const delivered = ['in-app'];
  const unread = await unreadCount(userId);

  // Live, to whichever task holds their socket.
  void import('../realtime/presenceGateway.js')
    .then(({ pushToUser }) => pushToUser(userId, 'community:notification', { notification, unread }))
    .catch(() => undefined);

  if (decision.push) {
    // Queued rather than sent inline: SNS is a network call, and a slow
    // notification must never slow down the action that caused it.
    await enqueue('notification.push', {
      userId,
      type,
      title,
      body,
      href,
      badgeCount: unread,
      data,
      delayMinutes: decision.delayMinutes,
    });
    delivered.push('push');
  }

  if (decision.email) {
    await enqueue('notification.email', { userId, type, title, body, href, data });
    delivered.push('email');
  }

  return { delivered, notificationId: notification.notificationId, reason: decision.reason };
};

/**
 * Fan-out to many people. One insert for every recipient, one job for the rest
 * — a thread reply in a space with four hundred members should not be four
 * hundred round trips.
 */
export const notifyMany = async ({ userIds, ...input }) => {
  if (userIds.length === 0) return { queued: 0 };

  await enqueue('notification.fanout', { userIds, ...input });
  return { queued: userIds.length };
};

const enqueue = async (job, payload) => {
  const { enqueueNotification } = await import('../queues/queues.js');
  await enqueueNotification(job, payload).catch((cause) =>
    log.error({ err: cause, job }, 'could not queue a notification'),
  );
};

const loadSettings = async (userId) => {
  const { rows } = await pool.query(
    `SELECT notifications, time_zone FROM profiles WHERE user_id = $1`,
    [userId],
  );
  return {
    notifications: rows[0]?.notifications ?? {},
    timeZone: rows[0]?.time_zone ?? 'UTC',
  };
};

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

/** Called by LiveSessionLink when a room opens. */
export const notifyLessonStarted = async ({ lessonId }) => {
  const { rows } = await pool.query(
    `SELECT l.title, c.title AS course_title, c.slug, e.user_id
       FROM lessons l
       JOIN modules m ON m.id = l.module_id
       JOIN courses c ON c.id = m.course_id
       JOIN enrollments e ON e.course_id = c.id AND e.status = 'active'
      WHERE l.id = $1`,
    [lessonId],
  );

  if (rows.length === 0) return { queued: 0 };

  return notifyMany({
    userIds: rows.map((row) => row.user_id),
    type: 'lesson.starting',
    title: `${rows[0].title} is starting`,
    body: rows[0].course_title,
    href: `/courses/${rows[0].slug}/lessons/${lessonId}`,
    data: { lessonId },
  });
};

/** Called by LiveSessionLink when a recording finishes processing. */
export const notifyRecordingReady = async ({ lessonId, assetId }) => {
  const { rows } = await pool.query(
    `SELECT l.title, c.slug, e.user_id
       FROM lessons l
       JOIN modules m ON m.id = l.module_id
       JOIN courses c ON c.id = m.course_id
       JOIN enrollments e ON e.course_id = c.id AND e.status = 'active'
      WHERE l.id = $1`,
    [lessonId],
  );

  if (rows.length === 0) return { queued: 0 };

  return notifyMany({
    userIds: rows.map((row) => row.user_id),
    type: 'asset.ready',
    title: `The recording of ${rows[0].title} is ready`,
    href: `/courses/${rows[0].slug}/lessons/${lessonId}`,
    data: { lessonId, assetId },
  });
};

/** Called when someone replies in a thread. */
export const notifyThreadReply = async ({ threadId, actorId, excerpt }) => {
  const Threads = await import('./models/Thread.js');
  const [thread, watchers] = await Promise.all([
    Threads.findById(threadId),
    Threads.followers(threadId, actorId),
  ]);
  if (!thread || watchers.length === 0) return { queued: 0 };

  return notifyMany({
    userIds: watchers,
    type: 'thread.reply',
    title: `New reply in “${thread.title}”`,
    body: excerpt,
    href: `/spaces/${thread.spaceId}/threads/${threadId}`,
    actorId,
    data: { threadId },
  });
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const list = async ({ userId, cursor, limit = 25, unreadOnly = false }) => {
  const params = [userId];
  let where = 'user_id = $1';

  if (unreadOnly) where += ' AND read_at IS NULL';
  if (cursor) {
    const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    params.push(at, id);
    where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);

  const { rows } = await pool.query(
    `SELECT n.*, u.display_name AS actor_name, u.avatar_url AS actor_avatar
       FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
      WHERE ${where.replaceAll('user_id', 'n.user_id').replaceAll('read_at', 'n.read_at').replaceAll('created_at', 'n.created_at').replaceAll(' id)', ' n.id)')}
      ORDER BY n.created_at DESC, n.id DESC LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    items: page.map((row) => ({
      notificationId: row.id,
      type: row.type,
      actor: row.actor_id
        ? { userId: row.actor_id, displayName: row.actor_name, avatarUrl: row.actor_avatar }
        : null,
      title: row.title,
      body: row.body,
      href: row.href,
      readAt: row.read_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    })),
    hasMore,
    nextCursor: hasMore && page.at(-1)
      ? Buffer.from(`${page.at(-1).created_at.toISOString()}|${page.at(-1).id}`).toString('base64url')
      : null,
  };
};

export const unreadCount = async (userId) => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return rows[0].unread;
};

/** No ids means everything. */
export const markRead = async ({ userId, notificationIds = [] }) => {
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read_at = now()
      WHERE user_id = $1 AND read_at IS NULL
        AND ($2::uuid[] IS NULL OR cardinality($2::uuid[]) = 0 OR id = ANY($2::uuid[]))`,
    [userId, notificationIds],
  );
  return rowCount;
};

export default { notify, notifyMany, list, unreadCount, markRead, decideChannels };