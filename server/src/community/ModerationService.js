// classroom-app/server/src/community/ModerationService.js
/**
 * Moderation  (F2)  [NEW]
 *
 * Reports, mutes, suspensions and removals.
 *
 * Three principles, and they are why this is a service rather than a few
 * UPDATE statements scattered through the routes:
 *
 *   Nothing is ever hard-deleted. Removed content is emptied and flagged; the
 *   row stays. A moderator reviewing a pattern of behaviour needs to see what
 *   was said, and a person appealing a decision needs it to still exist.
 *
 *   Every action is written to an audit log with an actor and a reason. "Who
 *   deleted this and why" is the first question asked in every moderation
 *   dispute, and it is unanswerable after the fact unless it was recorded at
 *   the time.
 *
 *   Reports are deduplicated per reporter and target, but counted. Ten people
 *   reporting one post is a signal; one person reporting it ten times is not.
 */

import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';
import * as Threads from './models/Thread.js';
import * as Posts from './models/Post.js';
import * as Memberships from './models/Membership.js';
import { assertModerator } from './SpaceService.js';

const log = logger.child({ component: 'moderation' });

/** Reports at or above this escalate the item for priority review. */
const ESCALATION_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Anyone may report. The insert is idempotent per (reporter, target) so a
 * frustrated user cannot inflate the count by pressing the button repeatedly.
 */
export const report = async ({ reporterId, targetType, targetId, reason, detail = null }) => {
  const { rows } = await pool.query(
    `INSERT INTO moderation_reports (reporter_id, target_type, target_id, reason, detail)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (reporter_id, target_type, target_id) DO UPDATE
       SET reason = EXCLUDED.reason, detail = EXCLUDED.detail, updated_at = now()
     RETURNING id, created_at`,
    [reporterId, targetType, targetId, reason, detail],
  );

  const { rows: counted } = await pool.query(
    `SELECT count(DISTINCT reporter_id)::int AS reporters
       FROM moderation_reports
      WHERE target_type = $1 AND target_id = $2 AND status = 'received'`,
    [targetType, targetId],
  );

  const reporters = counted[0].reporters;

  // Distinct reporters, not reports: the threshold is about consensus.
  if (reporters >= ESCALATION_THRESHOLD) {
    await escalate({ targetType, targetId, reporters });
  }

  log.info({ targetType, targetId, reason, reporters }, 'content reported');

  return {
    reportId: rows[0].id,
    status: 'received',
    createdAt: rows[0].created_at.toISOString(),
  };
};

const escalate = async ({ targetType, targetId, reporters }) => {
  await pool.query(
    `UPDATE moderation_reports SET status = 'reviewing', escalated_at = now()
      WHERE target_type = $1 AND target_id = $2 AND status = 'received'`,
    [targetType, targetId],
  );

  log.warn({ targetType, targetId, reporters }, 'content escalated for review');

  // Moderators of the owning space are told; this is not left to whoever
  // happens to open the queue.
  const spaceId = await spaceOf({ targetType, targetId });
  if (!spaceId) return;

  const { rows } = await pool.query(
    `SELECT user_id FROM space_memberships WHERE space_id = $1 AND role IN ('owner','moderator')`,
    [spaceId],
  );

  const { notifyMany } = await import('./NotificationService.js');
  await notifyMany({
    userIds: rows.map((row) => row.user_id),
    type: 'space.invite', // reuses the moderation channel; see NotificationService
    title: 'Content needs review',
    body: `${reporters} people reported the same item.`,
    href: `/spaces/${spaceId}/moderation`,
    data: { targetType, targetId },
  }).catch(() => undefined);
};

const spaceOf = async ({ targetType, targetId }) => {
  if (targetType === 'thread') {
    const thread = await Threads.findById(targetId);
    return thread?.spaceId ?? null;
  }
  if (targetType === 'post') {
    const post = await Posts.findById(targetId);
    if (!post) return null;
    const thread = await Threads.findById(post.threadId);
    return thread?.spaceId ?? null;
  }
  return null;
};

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export const listReports = async ({ spaceId, actorId, status = 'received', cursor, limit = 25 }) => {
  await assertModerator({ spaceId, userId: actorId });

  const params = [spaceId, status];
  let where = 'r.status = $2';

  if (cursor) {
    const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    params.push(at, id);
    where += ` AND (r.created_at, r.id) < ($3::timestamptz, $4::uuid)`;
  }
  params.push(limit + 1);

  // Grouped by target: a moderator reviews an item once, not once per report.
  const { rows } = await pool.query(
    `SELECT r.target_type, r.target_id,
            count(DISTINCT r.reporter_id)::int AS reporters,
            array_agg(DISTINCT r.reason) AS reasons,
            min(r.created_at) AS created_at,
            max(r.id::text)::uuid AS id
       FROM moderation_reports r
      WHERE ${where}
        AND coalesce(
              (SELECT t.space_id FROM threads t WHERE t.id = r.target_id),
              (SELECT th.space_id FROM posts p JOIN threads th ON th.id = p.thread_id WHERE p.id = r.target_id)
            ) = $1
      GROUP BY r.target_type, r.target_id
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    items: page.map((row) => ({
      targetType: row.target_type,
      targetId: row.target_id,
      reporters: row.reporters,
      reasons: row.reasons,
      createdAt: row.created_at.toISOString(),
    })),
    hasMore,
    nextCursor: hasMore && page.at(-1)
      ? Buffer.from(`${page.at(-1).created_at.toISOString()}|${page.at(-1).id}`).toString('base64url')
      : null,
  };
};

export const resolveReports = async ({ targetType, targetId, actorId, outcome, note = null }) => {
  const spaceId = await spaceOf({ targetType, targetId });
  await assertModerator({ spaceId, userId: actorId });

  const { rowCount } = await pool.query(
    `UPDATE moderation_reports
        SET status = $3, resolved_by = $4, resolved_at = now(), resolution_note = $5
      WHERE target_type = $1 AND target_id = $2 AND status IN ('received','reviewing')`,
    [targetType, targetId, outcome, actorId, note],
  );

  await audit({ actorId, action: `report.${outcome}`, targetType, targetId, spaceId, reason: note });
  return rowCount;
};

// ---------------------------------------------------------------------------
// Actions on content
// ---------------------------------------------------------------------------

export const removeThread = async ({ threadId, actorId, reason }) => {
  const thread = await Threads.findById(threadId);
  if (!thread) throw Object.assign(new Error('thread not found'), { code: 'not_found' });

  await assertModerator({ spaceId: thread.spaceId, userId: actorId });
  await Threads.softDelete(threadId);
  await audit({ actorId, action: 'thread.remove', targetType: 'thread', targetId: threadId, spaceId: thread.spaceId, reason });

  broadcast(thread.spaceId, {
    spaceId: thread.spaceId,
    targetType: 'thread',
    targetId: threadId,
    removedBy: 'moderator',
    removedAt: new Date().toISOString(),
  });

  // The author is told. Silent removal is how people conclude a platform is
  // arbitrary, and it costs one notification to avoid.
  if (thread.author) {
    const { notify } = await import('./NotificationService.js');
    await notify({
      userId: thread.author.userId,
      type: 'thread.reply',
      title: 'Your post was removed',
      body: reason ?? 'It did not meet the community guidelines.',
      href: `/spaces/${thread.spaceId}`,
      actorId,
    }).catch(() => undefined);
  }

  log.warn({ threadId, actorId, reason }, 'thread removed');
  return true;
};

export const removePost = async ({ postId, actorId, reason }) => {
  const post = await Posts.findById(postId);
  if (!post) throw Object.assign(new Error('post not found'), { code: 'not_found' });

  const thread = await Threads.findById(post.threadId);
  await assertModerator({ spaceId: thread.spaceId, userId: actorId });

  await Posts.softDelete(postId);
  await audit({ actorId, action: 'post.remove', targetType: 'post', targetId: postId, spaceId: thread.spaceId, reason });

  broadcast(thread.spaceId, {
    spaceId: thread.spaceId,
    targetType: 'post',
    targetId: postId,
    removedBy: 'moderator',
    removedAt: new Date().toISOString(),
  });

  return true;
};

export const restoreThread = async ({ threadId, actorId }) => {
  const thread = await Threads.findById(threadId);
  if (!thread) throw Object.assign(new Error('thread not found'), { code: 'not_found' });

  await assertModerator({ spaceId: thread.spaceId, userId: actorId });
  await Threads.restore(threadId);
  await audit({ actorId, action: 'thread.restore', targetType: 'thread', targetId: threadId, spaceId: thread.spaceId });
  return true;
};

/** Pin, lock, resolve, move. One route, one audit entry per call. */
export const applyThreadAction = async ({ threadId, actorId, action, targetSpaceId, reason }) => {
  const thread = await Threads.findById(threadId);
  if (!thread) throw Object.assign(new Error('thread not found'), { code: 'not_found' });

  await assertModerator({ spaceId: thread.spaceId, userId: actorId });

  const patches = {
    pin: { pinned: true },
    unpin: { pinned: false },
    lock: { locked: true },
    unlock: { locked: false },
    move: { spaceId: targetSpaceId },
  };

  if (action === 'delete') return removeThread({ threadId, actorId, reason });
  if (action === 'restore') return restoreThread({ threadId, actorId });

  const patch = patches[action];
  if (!patch) throw Object.assign(new Error(`unknown action: ${action}`), { code: 'validation_failed' });

  // Moving into a space the moderator does not moderate would be a way to
  // dump content somewhere they have no standing.
  if (action === 'move') await assertModerator({ spaceId: targetSpaceId, userId: actorId });

  const updated = await Threads.update(threadId, patch, actorId);
  await audit({ actorId, action: `thread.${action}`, targetType: 'thread', targetId: threadId, spaceId: thread.spaceId, reason });

  broadcastUpdate(thread.spaceId, { spaceId: thread.spaceId, threadId, change: action, actor: null });
  return updated;
};

// ---------------------------------------------------------------------------
// Actions on people
// ---------------------------------------------------------------------------

/**
 * A mute is time-boxed by default. An indefinite mute is a suspension wearing a
 * friendlier name, and pretending otherwise makes it easy to forget somebody
 * was silenced a year ago.
 */
export const mute = async ({ spaceId, userId, actorId, hours = 24, reason }) => {
  await assertModerator({ spaceId, userId: actorId });

  const until = hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;
  await Memberships.update({ spaceId, userId, patch: { mutedUntil: until } });
  await audit({ actorId, action: 'member.mute', targetType: 'user', targetId: userId, spaceId, reason });

  const { notify } = await import('./NotificationService.js');
  await notify({
    userId,
    type: 'space.invite',
    title: hours ? `You cannot post for ${hours} hours` : 'You cannot post in this space',
    body: reason ?? null,
    href: `/spaces/${spaceId}`,
    actorId,
  }).catch(() => undefined);

  log.warn({ spaceId, userId, actorId, hours }, 'member muted');
  return { mutedUntil: until };
};

export const unmute = async ({ spaceId, userId, actorId }) => {
  await assertModerator({ spaceId, userId: actorId });
  await Memberships.update({ spaceId, userId, patch: { mutedUntil: null } });
  await audit({ actorId, action: 'member.unmute', targetType: 'user', targetId: userId, spaceId });
  return true;
};

/** Loses access, keeps history. Deleting the membership would take it with it. */
export const suspend = async ({ spaceId, userId, actorId, reason }) => {
  const actor = await assertModerator({ spaceId, userId: actorId });

  const target = await Memberships.find({ spaceId, userId });
  if (target?.role === 'owner') {
    throw Object.assign(new Error('the owner cannot be suspended'), { code: 'forbidden' });
  }
  if (target?.role === 'moderator' && actor.role !== 'owner') {
    throw Object.assign(new Error('only the owner can suspend a moderator'), { code: 'forbidden' });
  }

  await Memberships.update({ spaceId, userId, patch: { suspended: true } });
  await audit({ actorId, action: 'member.suspend', targetType: 'user', targetId: userId, spaceId, reason });

  log.warn({ spaceId, userId, actorId, reason }, 'member suspended');
  return true;
};

export const reinstate = async ({ spaceId, userId, actorId }) => {
  await assertModerator({ spaceId, userId: actorId });
  await Memberships.update({ spaceId, userId, patch: { suspended: false } });
  await audit({ actorId, action: 'member.reinstate', targetType: 'user', targetId: userId, spaceId });
  return true;
};

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Append-only. Every moderation action lands here whether or not anyone ever
 * reads it, because the moment it is needed is always after the fact.
 */
const audit = async ({ actorId, action, targetType, targetId, spaceId, reason = null }) => {
  await pool
    .query(
      `INSERT INTO moderation_audit (actor_id, action, target_type, target_id, space_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [actorId, action, targetType, targetId, spaceId, reason],
    )
    .catch((cause) => log.error({ err: cause, action, targetId }, 'AUDIT WRITE FAILED'));
};

export const auditTrail = async ({ spaceId, actorId, limit = 100 }) => {
  await assertModerator({ spaceId, userId: actorId });
  const { rows } = await pool.query(
    `SELECT a.*, u.display_name AS actor_name
       FROM moderation_audit a JOIN users u ON u.id = a.actor_id
      WHERE a.space_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
    [spaceId, limit],
  );
  return rows.map((row) => ({
    action: row.action,
    actor: { userId: row.actor_id, displayName: row.actor_name },
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  }));
};

const broadcast = (spaceId, payload) => {
  void import('../realtime/presenceGateway.js')
    .then(({ broadcastToSpace }) => broadcastToSpace(spaceId, 'community:content.removed', payload))
    .catch(() => undefined);
};

const broadcastUpdate = (spaceId, payload) => {
  void import('../realtime/presenceGateway.js')
    .then(({ broadcastToSpace }) => broadcastToSpace(spaceId, 'community:thread.updated', payload))
    .catch(() => undefined);
};

export default { report, listReports, resolveReports, removeThread, removePost, mute, suspend, applyThreadAction };