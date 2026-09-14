// classroom-app/server/src/config/push.config.js
/**
 * Push notifications  (F5)  [NEW]
 *
 * Credentials and payload policy for APNs and FCM, delivered through SNS
 * platform applications so the server never holds a device certificate.
 *
 * The interesting decisions here are not the credentials, they are the rules
 * about when a push is appropriate at all:
 *
 *   - a chat message pushes only after NOTIFY_PUSH_DELAY_MIN of silence, so a
 *     conversation someone is actively reading does not buzz their phone
 *   - quiet hours are honoured per user, except for a lesson starting now
 *   - the body is included only when the user has allowed it; otherwise the
 *     notification says who, not what, because lock screens are read by people
 *     other than their owner
 */

import { env } from './env.js';

export const platformApplications = {
  ios: env.SNS_PLATFORM_APP_APNS,
  android: env.SNS_PLATFORM_APP_FCM,
};

export const enabled = Boolean(
  platformApplications.ios || platformApplications.android,
);

export const snsClientOptions = { region: env.AWS_REGION };

// ---------------------------------------------------------------------------
// Per-type policy
// ---------------------------------------------------------------------------

/**
 * `collapseKey` replaces an undelivered notification of the same kind: five
 * messages in one conversation should be one badge, not five buzzes.
 *
 * `priority` maps to apns-priority and FCM priority. High wakes the device;
 * normal waits for the next maintenance window and is the right default for
 * anything that is not time-critical.
 */
export const notificationTypes = {
  'chat.message': {
    priority: 'high',
    collapseKey: (payload) => `chat:${payload.conversationId}`,
    /** Silence required before a push is sent at all. */
    delayMinutes: env.NOTIFY_PUSH_DELAY_MIN,
    respectQuietHours: true,
    includeBody: true,
    badge: true,
    sound: 'default',
    category: 'MESSAGE',
  },
  'chat.mention': {
    priority: 'high',
    collapseKey: (payload) => `mention:${payload.messageId}`,
    delayMinutes: 0,
    respectQuietHours: true,
    includeBody: true,
    badge: true,
    sound: 'default',
    category: 'MENTION',
  },
  'lesson.starting': {
    priority: 'high',
    collapseKey: (payload) => `lesson:${payload.lessonId}`,
    delayMinutes: 0,
    /** The one exception: a lesson starting now overrides quiet hours. */
    respectQuietHours: false,
    includeBody: true,
    badge: false,
    sound: 'default',
    category: 'LESSON',
  },
  'thread.reply': {
    priority: 'normal',
    collapseKey: (payload) => `thread:${payload.threadId}`,
    delayMinutes: 5,
    respectQuietHours: true,
    includeBody: true,
    badge: true,
    category: 'COMMUNITY',
  },
  'assignment.graded': {
    priority: 'normal',
    collapseKey: (payload) => `grade:${payload.submissionId}`,
    delayMinutes: 0,
    respectQuietHours: true,
    includeBody: false,
    badge: true,
    category: 'GRADE',
  },
  'asset.ready': {
    priority: 'normal',
    collapseKey: (payload) => `asset:${payload.assetId}`,
    delayMinutes: 0,
    respectQuietHours: true,
    includeBody: false,
    badge: false,
    /** No sound: the user asked for this upload and is probably watching it. */
    silent: true,
    category: 'MEDIA',
  },
};

// ---------------------------------------------------------------------------
// Payload construction
// ---------------------------------------------------------------------------

export const limits = {
  /** APNs rejects anything larger; FCM is more generous but not by much. */
  maxPayloadBytes: 4_096,
  titleMaxChars: 60,
  bodyMaxChars: 160,
  /** Tokens are pruned after this many consecutive delivery failures. */
  failuresBeforeTokenRemoval: 3,
  ttlSeconds: 86_400,
};

/** Truncates on a word boundary where it can, so a body never ends mid-word. */
const truncate = (text, max) => {
  if (!text || text.length <= max) return text ?? '';
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
};

/**
 * Builds the SNS message for both platforms. The `data` block is what the app
 * reads to route a tap; `deepLink` is the same route the in-app notification
 * would open, so tapping a push and tapping a bell entry land in one place.
 */
export const buildPayload = (type, { title, body, deepLink, badgeCount, data = {} }) => {
  const policy = notificationTypes[type];
  if (!policy) throw new Error(`Unknown notification type: ${type}`);

  const safeTitle = truncate(title, limits.titleMaxChars);
  const safeBody = policy.includeBody ? truncate(body, limits.bodyMaxChars) : '';

  const apns = {
    aps: {
      ...(policy.silent
        ? { 'content-available': 1 }
        : { alert: { title: safeTitle, body: safeBody } }),
      ...(policy.badge && badgeCount !== undefined ? { badge: badgeCount } : {}),
      ...(policy.sound && !policy.silent ? { sound: policy.sound } : {}),
      category: policy.category,
      'thread-id': policy.collapseKey({ ...data }),
    },
    data: { type, deepLink, ...data },
  };

  const fcm = {
    ...(policy.silent
      ? {}
      : { notification: { title: safeTitle, body: safeBody } }),
    android: {
      priority: policy.priority === 'high' ? 'HIGH' : 'NORMAL',
      collapseKey: policy.collapseKey({ ...data }),
      ttl: `${limits.ttlSeconds}s`,
      notification: policy.silent ? undefined : { channelId: policy.category.toLowerCase() },
    },
    data: { type, deepLink, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) },
  };

  return {
    default: safeTitle,
    APNS: JSON.stringify(apns),
    APNS_SANDBOX: JSON.stringify(apns),
    GCM: JSON.stringify(fcm),
  };
};

/** Local clock comparison, inclusive start and exclusive end, wrap-around safe. */
export const isWithinQuietHours = (quietHours, now = new Date(), timeZone = 'UTC') => {
  if (!quietHours) return false;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const local = formatter.format(now);
  const { start, end } = quietHours;
  return start <= end ? local >= start && local < end : local >= start || local < end;
};

export const pushConfig = {
  enabled,
  platformApplications,
  snsClientOptions,
  notificationTypes,
  limits,
  buildPayload,
  isWithinQuietHours,
};

export default pushConfig;