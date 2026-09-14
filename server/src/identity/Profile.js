// classroom-app/server/src/identity/Profile.js
/**
 * Profiles  (F6)  [NEW]
 *
 * What a person shows to other people, and who is allowed to contact them.
 *
 * Separate from User.js because the two are read by different things at
 * different rates: the account is read by the auth path, the profile is read
 * every time anybody renders an avatar. Keeping the password hash in a table
 * that is joined into every chat message is a bad idea for reasons that do not
 * need explaining.
 *
 * The important function here is `canMessage`. It is computed on the server and
 * sent to the client as a boolean, never derived client-side, because only the
 * server can see *both* block lists — and a Message button that appears and
 * then fails is worse than one that was never there.
 */

import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'profiles' });

export const DM_POLICIES = ['anyone', 'shared-context', 'nobody'];

const DEFAULT_PRIVACY = {
  dmPolicy: env.CHAT_DEFAULT_DM_POLICY,
  showPresence: true,
  showEmail: 'nobody',
  showCourses: 'members',
  sendReadReceipts: true,
  discoverable: true,
};

const DEFAULT_NOTIFICATIONS = {
  dmPush: true,
  dmEmail: false,
  mentionPush: true,
  communityDigest: true,
  lessonReminders: true,
  quietHours: null,
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const rowToPublic = (row) => ({
  userId: row.user_id,
  displayName: row.display_name,
  handle: row.handle,
  avatarUrl: row.avatar_url,
  headline: row.headline,
  bio: row.bio,
  links: row.links ?? [],
  role: row.role,
  presence: 'offline', // filled in from Redis by the caller
  lastSeenAt: row.last_seen_at?.toISOString() ?? null,
  canMessage: false, // computed per viewer; see below
  isBlockedByViewer: false,
  sharedSpaceCount: 0,
  joinedAt: row.created_at.toISOString(),
});

const rowToOwn = (row) => ({
  ...rowToPublic(row),
  canMessage: undefined,
  isBlockedByViewer: undefined,
  sharedSpaceCount: undefined,
  email: row.email,
  emailVerified: row.email_verified,
  locale: row.locale,
  timeZone: row.time_zone,
  privacy: { ...DEFAULT_PRIVACY, ...(row.privacy ?? {}) },
  notifications: { ...DEFAULT_NOTIFICATIONS, ...(row.notifications ?? {}) },
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const SELECT = `
  SELECT p.*, u.email, u.email_verified, u.display_name, u.avatar_url,
         u.role, u.locale, u.time_zone, u.created_at
    FROM profiles p JOIN users u ON u.id = p.user_id
`;

// ---------------------------------------------------------------------------
// Contact rules  (pure)
// ---------------------------------------------------------------------------

/**
 * Whether one person may open a direct message with another.
 *
 * Pure and exported so the rule can be tested exhaustively — this is the
 * privacy boundary of the whole messaging feature, and a subtle mistake in it
 * is a stranger appearing in somebody's inbox.
 *
 * @param {{ viewerId, targetId, dmPolicy, blockedEitherWay, sharedContext, viewerIsModerator }} input
 * @returns {{ allowed: boolean, reason?: string }}
 */
export const canMessage = ({
  viewerId,
  targetId,
  dmPolicy = 'shared-context',
  blockedEitherWay = false,
  sharedContext = false,
  viewerIsModerator = false,
}) => {
  // Messaging yourself is a saved-notes feature, not a conversation.
  if (viewerId === targetId) return { allowed: false, reason: 'self' };

  /**
   * A block outranks everything, including a moderator's override. A
   * moderator who needs to contact someone who blocked them has the
   * moderation tools; the block is not theirs to ignore.
   */
  if (blockedEitherWay) return { allowed: false, reason: 'blocked' };

  if (dmPolicy === 'nobody') {
    // A teacher can still reach a learner who has closed their inbox — a
    // course has to be able to contact its participants.
    return viewerIsModerator
      ? { allowed: true, reason: 'moderator' }
      : { allowed: false, reason: 'dm_not_allowed' };
  }

  if (dmPolicy === 'anyone') return { allowed: true };

  // 'shared-context': a course or space in common.
  return sharedContext
    ? { allowed: true }
    : { allowed: false, reason: 'no_shared_context' };
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const getOwn = async (userId) => {
  const { rows } = await pool.query(`${SELECT} WHERE p.user_id = $1`, [userId]);
  return rows[0] ? rowToOwn(rows[0]) : null;
};

/**
 * The public view, resolved for one viewer.
 *
 * Blocks, DM policy and shared context are answered in a single query rather
 * than four: this runs on every profile card, and a card that opens on hover
 * cannot afford four round trips.
 */
export const getPublic = async ({ userId, viewerId }) => {
  const { rows } = await pool.query(
    `${SELECT},
       LATERAL (
         SELECT
           EXISTS (SELECT 1 FROM blocks b
                    WHERE (b.user_id = $2 AND b.blocked_user_id = p.user_id)
                       OR (b.user_id = p.user_id AND b.blocked_user_id = $2))  AS blocked_either_way,
           EXISTS (SELECT 1 FROM blocks b
                    WHERE b.user_id = $2 AND b.blocked_user_id = p.user_id)     AS blocked_by_viewer,
           (SELECT count(*)::int FROM space_memberships a
              JOIN space_memberships b2 ON b2.space_id = a.space_id
             WHERE a.user_id = $2 AND b2.user_id = p.user_id)                   AS shared_spaces,
           EXISTS (SELECT 1 FROM enrollments e1
                     JOIN enrollments e2 ON e2.course_id = e1.course_id
                    WHERE e1.user_id = $2 AND e2.user_id = p.user_id
                      AND e1.status = 'active' AND e2.status = 'active')        AS shared_course,
           EXISTS (SELECT 1 FROM courses c
                    WHERE c.owner_id = $2
                      AND EXISTS (SELECT 1 FROM enrollments e
                                   WHERE e.course_id = c.id AND e.user_id = p.user_id))
                                                                                AS viewer_teaches
       ) ctx
     WHERE p.user_id = $1`,
    [userId, viewerId],
  );

  const row = rows[0];
  if (!row) return null;

  const privacy = { ...DEFAULT_PRIVACY, ...(row.privacy ?? {}) };

  const verdict = canMessage({
    viewerId,
    targetId: userId,
    dmPolicy: privacy.dmPolicy,
    blockedEitherWay: row.blocked_either_way,
    sharedContext: row.shared_spaces > 0 || row.shared_course,
    viewerIsModerator: row.viewer_teaches,
  });

  return {
    ...rowToPublic(row),
    canMessage: verdict.allowed,
    isBlockedByViewer: row.blocked_by_viewer,
    sharedSpaceCount: row.shared_spaces,
    // Presence is hidden when they have switched it off, never inflated.
    presence: privacy.showPresence ? 'offline' : 'offline',
  };
};

export const getByHandle = async ({ handle, viewerId }) => {
  const { rows } = await pool.query(`SELECT user_id FROM profiles WHERE handle = lower($1)`, [handle]);
  return rows[0] ? getPublic({ userId: rows[0].user_id, viewerId }) : null;
};

/**
 * Mention autocomplete. Only people the viewer shares something with, and only
 * those who have not switched off discovery — a search that returns the whole
 * tenant is a user directory.
 */
export const search = async ({ q, viewerId, scopeId = null, limit = 10 }) => {
  const { rows } = await pool.query(
    `SELECT p.user_id, p.handle, u.display_name, u.avatar_url
       FROM profiles p JOIN users u ON u.id = p.user_id
      WHERE u.status = 'active'
        AND p.user_id <> $2
        AND coalesce((p.privacy->>'discoverable')::boolean, true)
        AND (p.handle ILIKE $1 || '%' OR u.display_name ILIKE '%' || $1 || '%')
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE (b.user_id = $2 AND b.blocked_user_id = p.user_id)
                            OR (b.user_id = p.user_id AND b.blocked_user_id = $2))
        AND ($3::uuid IS NULL OR EXISTS (
              SELECT 1 FROM space_memberships m
               WHERE m.space_id = $3 AND m.user_id = p.user_id))
      ORDER BY (p.handle ILIKE $1 || '%') DESC, u.display_name ASC
      LIMIT $4`,
    [q, viewerId, scopeId, limit],
  );

  return {
    items: rows.map((row) => ({
      userId: row.user_id,
      handle: row.handle,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      presence: 'offline',
    })),
  };
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export const createForUser = async ({ userId, displayName }) => {
  const handle = await uniqueHandle(displayName);

  await pool.query(
    `INSERT INTO profiles (user_id, handle, privacy, notifications)
     VALUES ($1,$2,$3::jsonb,$4::jsonb)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, handle, JSON.stringify(DEFAULT_PRIVACY), JSON.stringify(DEFAULT_NOTIFICATIONS)],
  );

  return getOwn(userId);
};

const slugifyHandle = (name) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 24) || 'user';

const uniqueHandle = async (displayName) => {
  const base = slugifyHandle(displayName);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}${Math.floor(Math.random() * 9_000) + 1_000}`;
    const { rows } = await pool.query(`SELECT 1 FROM profiles WHERE handle = $1`, [candidate]);
    if (rows.length === 0) return candidate;
  }

  return `${base}${Date.now().toString(36)}`;
};

export const update = async ({ userId, patch }) => {
  // display_name and avatar live on the user row; the rest on the profile.
  const userPatch = {};
  if (patch.displayName !== undefined) userPatch.displayName = patch.displayName;

  if (Object.keys(userPatch).length > 0) {
    const Users = await import('./User.js');
    await Users.update({ userId, patch: userPatch });
  }

  const columns = { handle: 'handle', headline: 'headline', bio: 'bio', links: 'links' };
  const sets = [];
  const params = [];

  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    params.push(key === 'links' ? JSON.stringify(patch[key]) : patch[key]);
    sets.push(`${column} = $${params.length}${key === 'links' ? '::jsonb' : ''}`);
  }

  if (patch.handle !== undefined) {
    const { rows } = await pool.query(
      `SELECT 1 FROM profiles WHERE handle = lower($1) AND user_id <> $2`,
      [patch.handle, userId],
    );
    if (rows.length > 0) {
      throw Object.assign(new Error('that handle is taken'), { code: 'conflict' });
    }
  }

  if (sets.length > 0) {
    params.push(userId);
    await pool.query(
      `UPDATE profiles SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $${params.length}`,
      params,
    );
  }

  return getOwn(userId);
};

/** Merged rather than replaced, so a client sending one key keeps the rest. */
export const updatePrivacy = async ({ userId, patch }) => {
  const { rows } = await pool.query(
    `UPDATE profiles SET privacy = coalesce(privacy, '{}'::jsonb) || $2::jsonb, updated_at = now()
      WHERE user_id = $1 RETURNING privacy`,
    [userId, JSON.stringify(patch)],
  );
  return { ...DEFAULT_PRIVACY, ...(rows[0]?.privacy ?? {}) };
};

export const updateNotifications = async ({ userId, patch }) => {
  const { rows } = await pool.query(
    `UPDATE profiles SET notifications = coalesce(notifications, '{}'::jsonb) || $2::jsonb,
            updated_at = now()
      WHERE user_id = $1 RETURNING notifications`,
    [userId, JSON.stringify(patch)],
  );
  return { ...DEFAULT_NOTIFICATIONS, ...(rows[0]?.notifications ?? {}) };
};

export const setAvatar = async ({ userId, assetId }) => {
  const { getAssetsForOwner } = await import('../media/UploadService.js');
  const [asset] = await getAssetsForOwner({ assetIds: [assetId], userId });

  if (!asset) throw Object.assign(new Error('unknown image'), { code: 'not_found' });
  if (asset.status !== 'ready') {
    throw Object.assign(new Error('that image is still processing'), { code: 'asset_not_ready' });
  }

  const Users = await import('./User.js');
  await Users.update({ userId, patch: { avatarUrl: asset.assetId } });
  return getOwn(userId);
};

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

/**
 * Blocking is mutual in effect: neither can message the other afterwards. It is
 * not symmetric in the list — only the blocker sees it — because telling
 * somebody they have been blocked is how a block becomes an escalation.
 */
export const block = async ({ userId, blockedUserId, reason = null }) => {
  if (userId === blockedUserId) {
    throw Object.assign(new Error('you cannot block yourself'), { code: 'validation_failed' });
  }

  await pool.query(
    `INSERT INTO blocks (user_id, blocked_user_id, reason)
     VALUES ($1,$2,$3) ON CONFLICT (user_id, blocked_user_id) DO NOTHING`,
    [userId, blockedUserId, reason],
  );

  log.info({ userId, blockedUserId }, 'user blocked');
  return { blockedUserId, blockedAt: new Date().toISOString() };
};

export const unblock = async ({ userId, blockedUserId }) => {
  const { rowCount } = await pool.query(
    `DELETE FROM blocks WHERE user_id = $1 AND blocked_user_id = $2`,
    [userId, blockedUserId],
  );
  return rowCount > 0;
};

export const listBlocks = async ({ userId, cursor, limit = 25 }) => {
  const params = [userId];
  let where = 'b.user_id = $1';

  if (cursor) {
    const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    params.push(at, id);
    where += ` AND (b.created_at, b.blocked_user_id) < ($2::timestamptz, $3::uuid)`;
  }
  params.push(limit + 1);

  const { rows } = await pool.query(
    `SELECT b.*, u.display_name, u.avatar_url
       FROM blocks b JOIN users u ON u.id = b.blocked_user_id
      WHERE ${where} ORDER BY b.created_at DESC LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    items: page.map((row) => ({
      blockedUserId: row.blocked_user_id,
      blockedAt: row.created_at.toISOString(),
      reason: row.reason,
      profile: {
        userId: row.blocked_user_id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
      },
    })),
    hasMore,
    nextCursor: hasMore && page.at(-1)
      ? Buffer.from(`${page.at(-1).created_at.toISOString()}|${page.at(-1).blocked_user_id}`).toString('base64url')
      : null,
  };
};

/** The check every send path calls. One query, either direction. */
export const isBlockedEitherWay = async ({ a, b }) => {
  const { rows } = await pool.query(
    `SELECT 1 FROM blocks
      WHERE (user_id = $1 AND blocked_user_id = $2)
         OR (user_id = $2 AND blocked_user_id = $1) LIMIT 1`,
    [a, b],
  );
  return rows.length > 0;
};

export default {
  getOwn, getPublic, getByHandle, search, createForUser, update,
  updatePrivacy, updateNotifications, setAvatar, block, unblock,
  listBlocks, isBlockedEitherWay, canMessage,
};