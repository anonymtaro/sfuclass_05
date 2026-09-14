// classroom-app/server/src/community/SpaceService.js
/**
 * Spaces  (F2)  [NEW]
 *
 * Creation, membership and the course link.
 *
 * `provisionForCourse` is the one worth reading. CourseService calls it on
 * every publish, which means it runs again on every republish — so it has to be
 * idempotent, and it has to backfill members who enrolled before the space
 * existed. Getting either wrong produces a second empty discussion space on a
 * course that already had one.
 */

import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';
import * as Spaces from './models/Space.js';
import * as Memberships from './models/Membership.js';
import * as Presence from './PresenceService.js';

const log = logger.child({ component: 'spaces' });

const slugify = (name) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'space';

const uniqueSlug = async (name) => {
  const base = slugify(name);
  return (await Spaces.slugExists(base)) ? `${base}-${randomUUID().slice(0, 6)}` : base;
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Online counts come from Redis, so they are attached after the SQL read. */
const withPresence = async (spaces) => {
  const list = Array.isArray(spaces) ? spaces : [spaces];
  if (list.length === 0) return spaces;

  const counts = await Presence.spaceCounts(list.map((space) => space.spaceId)).catch(() => ({}));
  const decorated = list.map((space) => ({ ...space, onlineCount: counts[space.spaceId] ?? 0 }));

  return Array.isArray(spaces) ? decorated : decorated[0];
};

export const getSpace = async ({ spaceId, slug, viewerId }) => {
  const space = spaceId
    ? await Spaces.findById(spaceId, viewerId)
    : await Spaces.findBySlug(slug, viewerId);

  if (!space) throw Object.assign(new Error('space not found'), { code: 'not_found' });

  // A private space does not exist as far as a non-member is concerned. 404
  // rather than 403: the name of a private space is itself information.
  if (space.visibility === 'private' && !space.joined) {
    throw Object.assign(new Error('space not found'), { code: 'not_found' });
  }

  return withPresence(space);
};

export const listSpaces = async (query) => {
  const page = await Spaces.list(query);
  return { ...page, items: await withPresence(page.items) };
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export const createSpace = async ({ ownerId, name, slug, description, visibility, courseId = null }) => {
  const space = await Spaces.insert({
    name,
    slug: slug ?? (await uniqueSlug(name)),
    description,
    visibility,
    courseId,
    ownerId,
  });

  await Memberships.join({ spaceId: space.spaceId, userId: ownerId, role: 'owner' });
  log.info({ spaceId: space.spaceId, ownerId, courseId }, 'space created');

  return Spaces.findById(space.spaceId, ownerId);
};

export const updateSpace = async ({ spaceId, actorId, patch }) => {
  await assertModerator({ spaceId, userId: actorId });

  if (patch.slug && (await Spaces.slugExists(patch.slug))) {
    throw Object.assign(new Error('that address is already taken'), { code: 'conflict' });
  }
  return Spaces.update(spaceId, patch, actorId);
};

// ---------------------------------------------------------------------------
// Course provisioning
// ---------------------------------------------------------------------------

/**
 * Called by CourseService on every publish. Idempotent in both directions: it
 * does not create a second space, and it does backfill members who enrolled
 * while the course was still a draft.
 */
export const provisionForCourse = async ({ courseId }) => {
  const { rows } = await pool.query(
    `SELECT id, title, slug, owner_id, space_id FROM courses WHERE id = $1`,
    [courseId],
  );
  const course = rows[0];
  if (!course) return null;

  let space = await Spaces.findByCourse(courseId, course.owner_id);

  if (!space) {
    space = await createSpace({
      ownerId: course.owner_id,
      name: course.title,
      slug: `course-${course.slug}`,
      description: `Discussion for ${course.title}.`,
      // Course spaces are members-only by default: the people in them are the
      // people who paid for or were enrolled in the course.
      visibility: 'members',
      courseId,
    });

    await pool.query(`UPDATE courses SET space_id = $2 WHERE id = $1`, [courseId, space.spaceId]);
    log.info({ courseId, spaceId: space.spaceId }, 'space provisioned for course');
  }

  // Runs every time. A republish six months in picks up everyone who has
  // enrolled since, and the ON CONFLICT makes repeats free.
  const { rows: learners } = await pool.query(
    `SELECT user_id FROM enrollments WHERE course_id = $1 AND status IN ('active','completed')`,
    [courseId],
  );

  const added = await Memberships.joinMany({
    spaceId: space.spaceId,
    userIds: learners.map((row) => row.user_id),
  });

  if (added > 0) log.info({ courseId, spaceId: space.spaceId, added }, 'learners added to course space');

  return { ...space, membersAdded: added };
};

/** Called when someone enrols after the course was published. */
export const addLearnerToCourseSpace = async ({ courseId, userId }) => {
  const space = await Spaces.findByCourse(courseId);
  if (!space) return null;
  return Memberships.join({ spaceId: space.spaceId, userId });
};

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export const join = async ({ spaceId, userId }) => {
  const space = await Spaces.findById(spaceId, userId);
  if (!space) throw Object.assign(new Error('space not found'), { code: 'not_found' });

  // A course space is not joined by asking: enrolling in the course is what
  // puts you in it.
  if (space.courseId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM enrollments WHERE course_id = $1 AND user_id = $2 AND status IN ('active','completed')`,
      [space.courseId, userId],
    );
    if (rows.length === 0) {
      throw Object.assign(new Error('enrol in the course to join this space'), { code: 'forbidden' });
    }
  } else if (space.visibility === 'private') {
    throw Object.assign(new Error('this space is invite only'), { code: 'forbidden' });
  }

  const membership = await Memberships.join({ spaceId, userId });
  log.info({ spaceId, userId }, 'joined space');
  return membership;
};

export const leave = ({ spaceId, userId }) => Memberships.leave({ spaceId, userId });

export const invite = async ({ spaceId, actorId, userIds }) => {
  await assertModerator({ spaceId, userId: actorId });
  const added = await Memberships.joinMany({ spaceId, userIds });

  const space = await Spaces.findById(spaceId, actorId);
  const { notifyMany } = await import('./NotificationService.js');
  await notifyMany({
    userIds,
    type: 'space.invite',
    title: `You were added to ${space.name}`,
    href: `/spaces/${space.slug}`,
    actorId,
    data: { spaceId },
  });

  return { added };
};

export const updateMembership = async ({ spaceId, actorId, userId, patch }) => {
  const actor = await assertModerator({ spaceId, userId: actorId });

  // Only an owner changes roles. A moderator can mute and suspend, which is
  // what moderation needs, but cannot appoint other moderators.
  if (patch.role !== undefined && actor.role !== 'owner') {
    throw Object.assign(new Error('only the owner can change roles'), { code: 'forbidden' });
  }
  return Memberships.update({ spaceId, userId, patch });
};

export const listMembers = async ({ spaceId, viewerId, cursor, limit }) => {
  await assertMember({ spaceId, userId: viewerId });
  const page = await Memberships.listMembers({ spaceId, cursor, limit });

  const presence = await Presence.getMany(page.items.map((member) => member.userId)).catch(() => []);
  const byUser = new Map(presence.map((entry) => [entry.userId, entry]));

  return {
    ...page,
    items: page.items.map((member) => ({
      ...member,
      presence: byUser.get(member.userId)?.state ?? 'offline',
    })),
  };
};

export const markRead = ({ spaceId, userId }) => Memberships.markRead({ spaceId, userId });

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export const assertMember = async ({ spaceId, userId }) => {
  const membership = await Memberships.find({ spaceId, userId });
  if (!membership || membership.suspended) {
    throw Object.assign(new Error('you are not a member of this space'), { code: 'forbidden' });
  }
  return membership;
};

export const assertModerator = async ({ spaceId, userId }) => {
  const membership = await Memberships.find({ spaceId, userId });
  if (!Memberships.isModerator(membership)) {
    throw Object.assign(new Error('you are not a moderator of this space'), { code: 'forbidden' });
  }
  return membership;
};

export default { getSpace, listSpaces, createSpace, updateSpace, provisionForCourse, join, leave, invite };