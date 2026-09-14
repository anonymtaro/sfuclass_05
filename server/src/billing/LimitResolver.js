// classroom-app/server/src/billing/LimitResolver.js
/**
 * Entitlements  (F4)  [EXT]
 *
 * Extended in version 6 from seats alone to seats, storage and courses.
 *
 * This file answers one question for the whole product: what may this tenant do
 * right now. It is the only place that knows how a plan becomes a permission,
 * and everything else — the record button, the upload picker, the publish
 * action — reads the pre-computed answer rather than comparing numbers itself.
 *
 * That matters because there are two comparisons, not one: the client decides
 * whether to enable a button and the server decides whether to allow the
 * request. If both implement the rule, they will eventually disagree, and the
 * user experience of that disagreement is a button that does nothing.
 *
 * The three limits behave differently and the difference is the interesting
 * part:
 *
 *   seats     a rate. Freed when a lesson ends. Checked at the door.
 *   courses   a count. Changes rarely. Checked when publishing.
 *   storage   a ratchet. Only ever grows until somebody deletes. Checked
 *             before a byte moves, because refusing at the end of a 2 GB
 *             upload is the worst possible moment.
 */

import { logger } from '../observability/logger.js';
import * as Plans from './models/Plan.js';
import * as Subscriptions from './models/Subscription.js';

const log = logger.child({ component: 'limits' });

const GB = 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Computation  (pure)
// ---------------------------------------------------------------------------

/**
 * Turns a plan and a usage snapshot into the entitlements object every client
 * reads. Pure, so the rules can be tested exhaustively and so the same function
 * produces the cached copy and the fresh one.
 *
 * @param {{ plan: object, usage: object, status: string }} input
 */
export const computeEntitlements = ({ plan, usage, status = 'active' }) => {
  const limits = plan.limits;
  const quotaBytes = limits.storageQuotaGb * GB;

  // An unlimited limit is null, not Infinity: JSON has no Infinity, and a
  // limit that survives serialisation as `null` is the one that works.
  const under = (used, limit) => limit === null || used < limit;

  const storageAvailable = usage.storageBytes < quotaBytes;

  const can = {
    // Seats are per room, so the question at the door is whether another room
    // may open at all.
    startRoom: under(usage.activeRooms, limits.concurrentRooms),
    record: limits.features.recording && limits.recordingHoursPerMonth > 0
      && usage.recordingMinutesThisMonth < limits.recordingHoursPerMonth * 60,
    upload: storageAvailable,
    publishCourse: under(usage.publishedCourses, limits.maxCourses),
    createSpace: under(usage.spaces, limits.maxSpaces),
    inviteTeacher: under(usage.teachers, limits.maxTeachers),
    screenShare: limits.features.screenShare,
    useBreakouts: limits.features.breakoutRooms,
  };

  // A subscription that is not entitled loses everything that costs money but
  // keeps what is needed to get the data out. Locking somebody out of their own
  // course material over a failed card is not a collections strategy.
  if (!Subscriptions.ENTITLED.has(status)) {
    can.startRoom = false;
    can.record = false;
    can.upload = false;
    can.publishCourse = false;
    can.createSpace = false;
    can.inviteTeacher = false;
  }

  return {
    planCode: plan.code,
    status,
    limits,
    usage: { ...usage, storageQuotaBytes: quotaBytes },
    can,
  };
};

/**
 * The answer to one specific request, with the numbers behind it.
 *
 * Returns a reason code that matches an ErrorCode, so the route that refuses
 * and the dialog that explains use the same vocabulary.
 */
export const checkLimit = ({ entitlements, action, sizeBytes = 0 }) => {
  const { limits, usage, can } = entitlements;

  const allow = () => ({ allowed: true, reason: null, requiredPlanCode: null, currentUsage: null, limit: null });

  const deny = (reason, currentUsage, limit) => ({
    allowed: false,
    reason,
    // Which plan would fix it is resolved by the caller against the catalogue;
    // this file does not know what is for sale.
    requiredPlanCode: null,
    currentUsage,
    limit,
  });

  switch (action) {
    case 'start-room':
      return can.startRoom
        ? allow()
        : deny('seat_limit_reached', usage.activeRooms, limits.concurrentRooms);

    case 'upload': {
      if (!can.upload) {
        return deny('quota_exceeded', usage.storageBytes, usage.storageQuotaBytes);
      }
      // The size matters, not just whether there is any room left: 100 MB free
      // and a 2 GB file is a refusal, and it is better delivered now.
      if (sizeBytes > 0 && usage.storageBytes + sizeBytes > usage.storageQuotaBytes) {
        return deny('quota_exceeded', usage.storageBytes + sizeBytes, usage.storageQuotaBytes);
      }
      return allow();
    }

    case 'record':
      if (!limits.features.recording) return deny('plan_upgrade_required', null, null);
      return can.record
        ? allow()
        : deny('quota_exceeded', usage.recordingMinutesThisMonth, limits.recordingHoursPerMonth * 60);

    case 'publish-course':
      return can.publishCourse
        ? allow()
        : deny('plan_upgrade_required', usage.publishedCourses, limits.maxCourses);

    case 'create-space':
      return can.createSpace
        ? allow()
        : deny('plan_upgrade_required', usage.spaces, limits.maxSpaces);

    case 'invite-teacher':
      return can.inviteTeacher
        ? allow()
        : deny('plan_upgrade_required', usage.teachers, limits.maxTeachers);

    default:
      return deny('plan_upgrade_required', null, null);
  }
};

/** The cheapest plan in the catalogue that would allow the refused action. */
export const smallestPlanFor = ({ plans, action, needed = 1 }) => {
  const satisfies = (plan) => {
    const limits = plan.limits;
    switch (action) {
      case 'start-room':
        return limits.concurrentRooms >= needed;
      case 'upload':
        return limits.storageQuotaGb * GB >= needed;
      case 'record':
        return limits.features.recording && limits.recordingHoursPerMonth > 0;
      case 'publish-course':
        return limits.maxCourses === null || limits.maxCourses >= needed;
      case 'create-space':
        return limits.maxSpaces === null || limits.maxSpaces >= needed;
      case 'invite-teacher':
        return limits.maxTeachers === null || limits.maxTeachers >= needed;
      default:
        return false;
    }
  };

  // Sorted by price, so the answer is the cheapest fix rather than the most
  // expensive one we could suggest.
  return (
    [...plans]
      .filter((plan) => plan.visible)
      .sort((a, b) => a.price.amountMinor - b.price.amountMinor)
      .find(satisfies) ?? null
  );
};

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

/**
 * Counts everything the entitlements depend on, in one round trip.
 *
 * One query rather than six, because this runs on a cache miss and a cache miss
 * happens on every task after every deploy — six queries there is six times the
 * thundering herd.
 */
export const gatherUsage = async (ownerId) => {
  const { pool } = await import('../db/pool.js');

  const { rows } = await pool.query(
    `SELECT
       (SELECT coalesce(sum(size_bytes),0)::bigint FROM assets
         WHERE owner_id = $1 AND deleted_at IS NULL
           AND status IN ('ready','processing','scanning'))            AS storage_bytes,
       (SELECT count(*)::int FROM rooms
         WHERE owner_id = $1 AND ended_at IS NULL)                      AS active_rooms,
       (SELECT count(*)::int FROM courses
         WHERE owner_id = $1 AND status = 'published' AND deleted_at IS NULL) AS published_courses,
       (SELECT count(*)::int FROM spaces
         WHERE owner_id = $1 AND deleted_at IS NULL)                    AS spaces,
       (SELECT count(DISTINCT ci.user_id)::int FROM course_instructors ci
          JOIN courses c ON c.id = ci.course_id
         WHERE c.owner_id = $1)                                         AS teachers,
       (SELECT coalesce(sum(duration_sec),0)::bigint / 60 FROM recordings
         WHERE owner_id = $1
           AND created_at >= date_trunc('month', now()))                AS recording_minutes`,
    [ownerId],
  );

  const row = rows[0] ?? {};

  return {
    storageBytes: Number(row.storage_bytes ?? 0),
    activeRooms: Number(row.active_rooms ?? 0),
    publishedCourses: Number(row.published_courses ?? 0),
    spaces: Number(row.spaces ?? 0),
    teachers: Number(row.teachers ?? 0),
    recordingMinutesThisMonth: Number(row.recording_minutes ?? 0),
  };
};

/**
 * The uncached path. Called by EntitlementCache on a miss, and nowhere else —
 * calling it directly would bypass the cache and, on a busy tenant, hammer the
 * database from every request.
 */
export const resolve = async (ownerId) => {
  const subscription = await Subscriptions.findByOwner(ownerId);

  const plan = subscription?.planId
    ? ((await Plans.findById(subscription.planId)) ?? Plans.freePlan())
    : Plans.freePlan();

  const usage = await gatherUsage(ownerId);

  const entitlements = computeEntitlements({
    plan,
    usage,
    status: subscription?.status ?? 'active',
  });

  log.debug({ ownerId, planCode: plan.code, storageBytes: usage.storageBytes }, 'entitlements resolved');

  return entitlements;
};

export default { resolve, computeEntitlements, checkLimit, gatherUsage, smallestPlanFor };