/**
 * notificationWorker — push · email · in-app fan-out (F2, F6)
 *
 * Every notification in the product funnels through here: a new post, a mention, a chat
 * message to someone who is offline, a session reminder from ReminderRules, the daily
 * digest. One worker, because the rules that decide whether to send are the same rules
 * every time and they should live in one place.
 *
 * Order of decisions, per recipient:
 *   1. Preferences — the channel is off for this kind → drop it, quietly.
 *   2. Presence — an in-app notification always lands; push is for people who are not
 *      looking at the app, otherwise everyone gets told twice.
 *   3. Quiet hours — time-critical kinds (a lesson starting in ten minutes) pass through;
 *      everything else is held for the digest.
 *   4. Dedupe — a Redis key per (recipient, dedupeKey). Three replies in ten seconds is
 *      one push, not three.
 *
 * A dead push token is not an error. SNS says EndpointDisabled, the registry retires the
 * token, and the job succeeds — otherwise every uninstalled app becomes a failed job.
 */

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { defineWorker, QUEUE_NAMES, PermanentJobError } from '../queues.js';
import { utilityConnection } from '../connection.js';
import { env } from '../../config/env.js';
import * as NotificationService from '../../community/NotificationService.js';
import * as DeviceRegistry from '../../identity/DeviceRegistry.js';
import * as PresenceService from '../../community/PresenceService.js';
import * as ScheduleService from '../../scheduling/ScheduleService.js';
import * as ReminderRules from '../../scheduling/ReminderRules.js';
import { metrics } from '../../observability/metrics.js';

const sns = new SNSClient({ region: env.SNS_REGION ?? env.AWS_REGION });
const ses = new SESv2Client({ region: env.SES_REGION ?? env.AWS_REGION });
const redis = utilityConnection('notify');

/** Kinds that ignore quiet hours. Everything else waits for the digest. */
const TIME_CRITICAL = new Set(['session.reminder.starting_soon', 'session.cancelled', 'security.alert']);

const DEDUPE_TTL_SECONDS = 120;

/* ------------------------------------------------------------------ *
 * Job types
 * ------------------------------------------------------------------ */

const handlers = {
  'notification.fanout': fanout,
  'session.reminder': sessionReminder,
  'digest.daily': digest,
};

export function createNotificationWorker() {
  return defineWorker(QUEUE_NAMES.NOTIFY, async (job, log) => {
    const handler = handlers[job.name];
    if (!handler) throw new PermanentJobError(`Unknown notification job: ${job.name}`);
    return handler(job, log);
  });
}

/* ------------------------------------------------------------------ *
 * Generic fan-out
 * ------------------------------------------------------------------ */

/**
 * @param {{ data: {
 *   kind: string, recipientIds: string[], title: string, body: string,
 *   url?: string, actorId?: string, dedupeKey?: string, data?: object,
 *   channels?: Array<'in-app'|'push'|'email'>
 * } }} job
 */
async function fanout(job, log) {
  const { kind, recipientIds = [], title, body, url = null, actorId = null, dedupeKey = null } = job.data;
  if (!kind || recipientIds.length === 0) throw new PermanentJobError('fanout needs a kind and recipients');

  const requested = job.data.channels ?? ['in-app', 'push'];
  const result = { delivered: 0, suppressed: 0, byChannel: { 'in-app': 0, push: 0, email: 0 } };

  for (const recipientId of recipientIds) {
    if (recipientId === actorId) continue; // never notify someone about their own action

    const decision = await decide({ recipientId, kind, requested, dedupeKey });
    if (decision.channels.length === 0) {
      result.suppressed += 1;
      continue;
    }

    if (decision.channels.includes('in-app')) {
      await NotificationService.createInApp({ userId: recipientId, kind, title, body, url, actorId, data: job.data.data });
      result.byChannel['in-app'] += 1;
    }
    if (decision.channels.includes('push')) {
      result.byChannel.push += await sendPush({ recipientId, title, body, url, kind, data: job.data.data }, log);
    }
    if (decision.channels.includes('email')) {
      result.byChannel.email += await sendEmail({ recipientId, title, body, url, kind }, log);
    }

    result.delivered += 1;
  }

  metrics.increment?.('notification_fanout', result.delivered, { kind });
  log.info({ kind, ...result }, 'notify: fan-out done');
  return result;
}

/** The four gates, in order. Returns the channels that survive all of them. */
async function decide({ recipientId, kind, requested, dedupeKey }) {
  const preferences = await NotificationService.getPreferences(recipientId);

  let channels = requested.filter((channel) => NotificationService.isEnabled(preferences, kind, channel));
  if (channels.length === 0) return { channels };

  // Someone with the app open gets the in-app badge; pushing as well is just noise.
  const presence = await PresenceService.get(recipientId);
  if (presence?.state === 'online' || presence?.state === 'in-class') {
    channels = channels.filter((channel) => channel !== 'push');
  }

  if (!TIME_CRITICAL.has(kind) && NotificationService.inQuietHours(preferences)) {
    channels = channels.filter((channel) => channel === 'in-app');
  }

  if (dedupeKey && channels.length > 0) {
    const key = `notify:dedupe:${recipientId}:${dedupeKey}`;
    const fresh = await redis.set(key, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
    if (!fresh) channels = channels.filter((channel) => channel === 'in-app');
  }

  return { channels };
}

/* ------------------------------------------------------------------ *
 * Channels
 * ------------------------------------------------------------------ */

async function sendPush({ recipientId, title, body, url, kind, data }, log) {
  const devices = await DeviceRegistry.activeEndpoints(recipientId);
  let sent = 0;

  for (const device of devices) {
    const message =
      device.platform === 'ios'
        ? JSON.stringify({
            APNS: JSON.stringify({
              aps: { alert: { title, body }, sound: 'default', 'thread-id': kind },
              url,
              ...data,
            }),
          })
        : JSON.stringify({
            GCM: JSON.stringify({
              notification: { title, body },
              data: { url: url ?? '', kind, ...data },
              android: { priority: 'high' },
            }),
          });

    try {
      await sns.send(
        new PublishCommand({ TargetArn: device.endpointArn, MessageStructure: 'json', Message: message }),
      );
      sent += 1;
    } catch (error) {
      // An uninstalled app is not a failure of this job.
      if (error.name === 'EndpointDisabledException' || error.name === 'InvalidParameterException') {
        await DeviceRegistry.retireEndpoint(device.id, error.name);
        log.info({ recipientId, deviceId: device.id }, 'notify: retired a dead push endpoint');
        continue;
      }
      throw error;
    }
  }
  return sent;
}

async function sendEmail({ recipientId, title, body, url, kind }, log) {
  const recipient = await NotificationService.emailRecipient(recipientId);
  if (!recipient?.email || recipient.suppressed) return 0;

  const rendered = NotificationService.renderEmail({ kind, title, body, url, recipient });

  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: env.SES_FROM,
        Destination: { ToAddresses: [recipient.email] },
        Content: { Simple: { Subject: { Data: rendered.subject }, Body: { Html: { Data: rendered.html }, Text: { Data: rendered.text } } } },
        // Lets a bounce or complaint be traced back to the notification kind.
        EmailTags: [{ Name: 'kind', Value: kind.replace(/[^\w-]/g, '_') }],
      }),
    );
    return 1;
  } catch (error) {
    if (error.name === 'AccountSuspendedException' || error.name === 'MessageRejected') {
      log.error({ err: error, recipientId }, 'notify: SES rejected the message');
      throw new PermanentJobError(`SES rejected: ${error.message}`);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Scheduling (F1, F3) and digests (F2)
 * ------------------------------------------------------------------ */

/**
 * Enqueued by ReminderRules.enqueueDue(). The reminder row is the source of truth, so this
 * resolves the audience at send time — someone who enrolled an hour ago still gets it, and
 * someone who unenrolled does not.
 */
async function sessionReminder(job, log) {
  const { reminderId, sessionId, ruleKey, template } = job.data;

  const session = await ScheduleService.getSession(sessionId);
  if (!session) {
    await ReminderRules.markSent(reminderId, { recipients: 0 });
    throw new PermanentJobError('Session no longer exists', { sessionId });
  }
  if (session.status !== 'scheduled') {
    // Cancelled or already started between planning and firing.
    await ReminderRules.markSent(reminderId, { recipients: 0 });
    return { skipped: session.status };
  }

  const recipientIds = await ScheduleService.listAudience(sessionId);
  const when = ScheduleService.formatLocal(session);

  const result = await fanout(
    {
      data: {
        kind: template,
        recipientIds,
        title: session.title,
        body: ruleKey === 'T-10m' ? 'Starts in 10 minutes' : `Starts ${when}`,
        url: session.lessonId ? `/lessons/${session.lessonId}/live` : `/sessions/${session.id}`,
        dedupeKey: `session:${sessionId}:${ruleKey}`,
        channels: ruleKey === 'T-10m' ? ['push', 'in-app'] : ['email', 'push', 'in-app'],
        data: { sessionId, lessonId: session.lessonId },
      },
    },
    log,
  );

  await ReminderRules.markSent(reminderId, { recipients: result.delivered });
  return result;
}

/** Daily community digest — one email per user, everything they missed, in one job. */
async function digest(job, log) {
  const { userId, date } = job.data;
  const content = await NotificationService.buildDigest({ userId, date });
  if (!content || content.items.length === 0) return { skipped: 'empty' };

  const sent = await sendEmail(
    { recipientId: userId, title: content.subject, body: content.summary, url: content.url, kind: 'digest.daily' },
    log,
  );
  metrics.increment?.('notification_digest_sent', sent);
  return { sent, items: content.items.length };
}

export default createNotificationWorker;