/**
 * digestNotifications — daily community digest (F2)
 *
 * Runs hourly, not daily. "Daily at 08:00" means 08:00 where the reader is, and a platform
 * with learners in Berlin, São Paulo and Manila has no single hour that works. Each hourly
 * invocation picks the users whose local clock has just reached their send hour and
 * enqueues one digest job per user.
 *
 * What this file does NOT do: build the digest. That is the notify worker's job, because
 * assembling content and sending email is slow and bursty, and a one-off ECS task should
 * hand off rather than hold the work. This is a dispatcher with a clock.
 *
 * Idempotency: the job id carries the user and the local date, so a duplicate EventBridge
 * delivery — or an overlapping retry — cannot send the same person two digests.
 *
 * Schedule: hourly, on the hour.
 */

import { runJob, isMain } from './_runJob.js';
import { enqueue, QUEUE_NAMES } from '../queues/queues.js';
import * as NotificationService from '../community/NotificationService.js';
import { metrics } from '../observability/metrics.js';

const BATCH = 500;

/** Local wall-clock hour and date for a user's zone, without pulling in a date library. */
export function localHourAndDate(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(now);

  const get = (type) => parts.find((part) => part.type === type)?.value;
  const hour = Number(get('hour')) % 24; // some ICU builds emit 24 for midnight
  return { hour, date: `${get('year')}-${get('month')}-${get('day')}` };
}

export async function digestNotifications({ log, clock, argv = {} } = {}) {
  const now = argv.at ? new Date(argv.at) : new Date();
  const summary = { candidates: 0, enqueued: 0, skippedWrongHour: 0, skippedEmpty: 0, zones: 0 };

  // Only zones whose local time is within the window any user could have picked. Checking
  // every user's zone one at a time is the version of this job that takes forty minutes.
  const zones = await NotificationService.digestTimeZones();
  summary.zones = zones.length;

  for (const timeZone of zones) {
    if (clock?.expired()) break;

    const { hour, date } = localHourAndDate(timeZone, now);

    let cursor = null;
    do {
      const page = await NotificationService.listDigestSubscribers({
        timeZone,
        sendHour: hour,
        frequency: 'daily',
        cursor,
        limit: BATCH,
      });
      cursor = page.nextCursor;
      summary.candidates += page.users.length;

      for (const user of page.users) {
        // A weekly subscriber on the wrong weekday, or an hour that does not match.
        if (user.sendHour !== hour) {
          summary.skippedWrongHour += 1;
          continue;
        }
        // Nothing happened since their last digest — do not send an empty email.
        if (!user.hasUnseenActivity) {
          summary.skippedEmpty += 1;
          continue;
        }

        await enqueue(
          QUEUE_NAMES.NOTIFY,
          'digest.daily',
          { userId: user.id, date, timeZone },
          // One digest per user per local day, whatever the delivery guarantees do.
          { jobId: `digest:${user.id}:${date}` },
        );
        summary.enqueued += 1;
      }
    } while (cursor && !clock?.expired());
  }

  metrics.increment?.('digest_enqueued', summary.enqueued);
  log.info(summary, 'digest: dispatch complete');
  return summary;
}

if (isMain(import.meta.url)) {
  await runJob('digestNotifications', digestNotifications, { timeBudgetMs: 10 * 60_000 });
}

export default digestNotifications;