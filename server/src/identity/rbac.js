// classroom-app/server/src/identity/rbac.js
/**
 * Authorisation policy  (F5)  [NEW]
 *
 * Who may do what. Every permission decision in the platform resolves through
 * `can()`, and the matrix below is the entire policy — readable in one screen,
 * which is the point. A policy spread across forty route handlers is a policy
 * nobody can audit.
 *
 * Three platform roles, and the distinction that matters is between *platform*
 * roles and *scoped* roles:
 *
 *   platform   owner | teacher | learner — what this account is
 *   scoped     host in a room, moderator in a space, instructor on a course
 *
 * A learner can be the host of their own study room. A teacher is not
 * automatically a moderator of every space. Conflating the two is how somebody
 * ends up able to delete a course because they run a book club.
 *
 * Everything here is pure: no database, no request. The caller resolves the
 * scope and asks.
 */

export const ROLES = ['owner', 'teacher', 'learner'];

/** Higher wins. Used for "at least a teacher" checks, never for permissions. */
const RANK = { owner: 3, teacher: 2, learner: 1 };

/**
 * The matrix. A permission a role does not hold is absent rather than false —
 * absent means "never", and there is no way to spell "sometimes" here on
 * purpose. Conditional permissions are the caller's job, with the scope in
 * hand.
 */
const PERMISSIONS = {
  owner: [
    // Everything a teacher can do, plus the tenant itself.
    'tenant.manage',
    'billing.manage',
    'billing.read',
    'user.invite',
    'user.suspend',
    'user.role.change',
    'course.create',
    'course.publish',
    'course.delete.any',
    'space.create',
    'space.moderate.any',
    'room.host.any',
    'recording.manage.any',
    'assignment.grade.any',
    'moderation.review',
    'audit.read',
  ],
  teacher: [
    'course.create',
    'course.publish',
    // Only their own; the `.own` suffix is the caller's cue to check ownership.
    'course.delete.own',
    'space.create',
    'space.moderate.own',
    'room.host.own',
    'recording.manage.own',
    'assignment.create',
    'assignment.grade.own',
    'learner.invite',
    'moderation.review',
  ],
  learner: [
    'course.enrol',
    'course.read',
    'room.join',
    'room.host.own',
    'assignment.submit',
    'space.join',
    'space.post',
    'chat.send',
    'media.upload',
    'profile.edit.own',
  ],
};

/**
 * Permissions everybody holds, whatever their role. Listed rather than implied,
 * because "everybody can read their own profile" is exactly the kind of rule
 * that gets forgotten and then hard-coded in six places.
 */
const UNIVERSAL = [
  'profile.read',
  'profile.edit.own',
  'chat.send',
  'media.upload',
  'notification.read',
  'session.manage.own',
];

const effective = (role) => new Set([...(PERMISSIONS[role] ?? []), ...UNIVERSAL]);

const CACHE = new Map(ROLES.map((role) => [role, effective(role)]));

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * @param {{ role: string }} actor
 * @param {string} permission
 */
export const can = (actor, permission) => {
  if (!actor?.role) return false;
  return CACHE.get(actor.role)?.has(permission) ?? false;
};

/**
 * `course.delete` where the actor owns it, or `course.delete.any` where they do
 * not. One call rather than every route writing the same two-branch check.
 *
 * @param {{ role: string, userId: string }} actor
 * @param {string} permission  the base, without .own or .any
 * @param {{ ownerId?: string }} resource
 */
export const canOn = (actor, permission, resource = {}) => {
  if (can(actor, `${permission}.any`)) return true;
  if (!resource.ownerId) return false;
  return resource.ownerId === actor?.userId && can(actor, `${permission}.own`);
};

export const assert = (actor, permission, message = null) => {
  if (can(actor, permission)) return true;
  throw Object.assign(new Error(message ?? 'You do not have permission to do that.'), {
    code: 'forbidden',
    permission,
  });
};

export const assertOn = (actor, permission, resource, message = null) => {
  if (canOn(actor, permission, resource)) return true;
  throw Object.assign(new Error(message ?? 'You do not have permission to do that.'), {
    code: 'forbidden',
    permission,
  });
};

/** "At least a teacher". Rank is for hierarchy questions only. */
export const atLeast = (actor, role) => (RANK[actor?.role] ?? 0) >= (RANK[role] ?? 99);

// ---------------------------------------------------------------------------
// Role changes
// ---------------------------------------------------------------------------

/**
 * Whether one account may set another's role.
 *
 * Two rules: only an owner changes roles at all, and nobody changes their own.
 * The second is what stops a compromised teacher account promoting itself, and
 * it also stops an owner accidentally demoting themselves out of the only
 * account that can undo it.
 */
export const canSetRole = (actor, target, newRole) => {
  if (!can(actor, 'user.role.change')) {
    return { allowed: false, reason: 'Only an owner can change roles.' };
  }
  if (actor.userId === target.userId) {
    return { allowed: false, reason: 'You cannot change your own role.' };
  }
  if (!ROLES.includes(newRole)) {
    return { allowed: false, reason: 'Unknown role.' };
  }
  return { allowed: true };
};

/**
 * The last owner cannot be demoted or suspended. A tenant with no owner has
 * nobody who can fix it, and recovering one is a support ticket.
 */
export const canDemoteOwner = ({ ownerCount }) =>
  ownerCount > 1
    ? { allowed: true }
    : { allowed: false, reason: 'This is the only owner; promote somebody else first.' };

/** For the UI, so a settings page renders what the account can actually reach. */
export const permissionsFor = (role) => [...(CACHE.get(role) ?? [])].sort();

export default { can, canOn, assert, assertOn, atLeast, canSetRole, permissionsFor, ROLES };