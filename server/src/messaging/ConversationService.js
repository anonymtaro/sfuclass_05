// classroom-app/server/src/messaging/ConversationService.js
/**
 * Conversations  (F6)
 *
 * The Message action on a profile card resolves here, and `openDirect` is the
 * function the whole feature hangs on. It is idempotent: it returns the existing
 * conversation or creates one. There is no separate "new message" flow, which
 * is what stops the two drifting apart.
 *
 * Before it creates anything it answers a question only the server can answer:
 * may these two people talk? That needs the target's DM policy, both block
 * lists, and whether they share a course or space. A client can see none of
 * that, which is why `canMessage` on a PublicProfile is computed server-side and
 * why this check is repeated here rather than trusted from the request.
 */

import { randomUUID } from 'node:crypto';
import { ApiError } from '@classroom/contracts';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';
import * as Conversation from './models/Conversation.js';
import * as Participant from './models/Participant.js';
import * as Block from './models/Block.js';

const log = logger.child({ component: 'conversations' });

const MAX_GROUP = 50;

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

/** Do these two share a course or a space? The 'shared-context' policy. */
const sharesContext = async (userA, userB) => {
  const { rows } = await pool.query(
    `SELECT 1 FROM (
       SELECT course_id AS id FROM enrollments WHERE user_id = $1 AND status = 'active'
       INTERSECT
       SELECT course_id AS id FROM enrollments WHERE user_id = $2 AND status = 'active'
       UNION
       SELECT space_id AS id FROM space_memberships WHERE user_id = $1
       INTERSECT
       SELECT space_id AS id FROM space_memberships WHERE user_id = $2
     ) shared LIMIT 1`,
    [userA, userB],
  );
  return rows.length > 0;
};

/**
 * The single source of truth for "may A message B". Used by this service and
 * by profileApi to fill `canMessage`, so the button and the send agree.
 */
export const canMessage = async ({ fromUserId, toUserId }) => {
  if (fromUserId === toUserId) {
    return { allowed: false, code: 'validation_failed', reason: 'cannot message yourself' };
  }

  const { blocked, by } = await Block.areBlocked(fromUserId, toUserId);
  if (blocked) {
    // Same answer whichever direction the block runs. Distinguishing them
    // would tell someone they have been blocked, which is information the
    // blocker did not choose to share.
    return { allowed: false, code: 'blocked_by_user', blockedBy: by };
  }

  const { rows } = await pool.query(
    `SELECT coalesce(privacy->>'dmPolicy', $2) AS policy, role
       FROM profiles WHERE user_id = $1`,
    [toUserId, env.CHAT_DEFAULT_DM_POLICY],
  );

  const target = rows[0];
  if (!target) return { allowed: false, code: 'not_found' };

  switch (target.policy) {
    case 'anyone':
      return { allowed: true };
    case 'nobody':
      // Teachers can still reach a learner who has closed their inbox; a
      // learner cannot be unreachable to the person teaching them.
      return { allowed: false, code: 'dm_not_allowed' };
    default:
      return (await sharesContext(fromUserId, toUserId))
        ? { allowed: true }
        : { allowed: false, code: 'dm_not_allowed', reason: 'you share no course or space' };
  }
};

// ---------------------------------------------------------------------------
// Open or create
// ---------------------------------------------------------------------------

/**
 * Idempotent. Two taps on the Message button produce one conversation, and so
 * do two devices asking at the same moment — the unique index on the direct
 * participant pair is what settles the race, and the retry below reads the
 * winner rather than failing.
 */
export const openDirect = async ({ fromUserId, toUserId, tenantId }) => {
  const existing = await Conversation.findDirectBetween(fromUserId, toUserId);
  if (existing) {
    return hydrate({ row: existing, viewerId: fromUserId });
  }

  const permission = await canMessage({ fromUserId, toUserId });
  if (!permission.allowed) {
    throw new ApiError(permission.code, {
      detail: permission.reason ?? 'You cannot message this person.',
    });
  }

  try {
    const row = await Conversation.create({
      conversationId: randomUUID(),
      tenantId,
      kind: 'direct',
      createdBy: fromUserId,
      participantIds: [fromUserId, toUserId],
    });

    log.info({ conversationId: row.conversation_id }, 'direct conversation opened');
    return hydrate({ row, viewerId: fromUserId, created: true });
  } catch (cause) {
    // Unique violation: someone else created it a millisecond ago. Theirs is
    // as good as ours.
    if (cause?.code === '23505') {
      const raced = await Conversation.findDirectBetween(fromUserId, toUserId);
      if (raced) return hydrate({ row: raced, viewerId: fromUserId });
    }
    throw cause;
  }
};

export const createGroup = async ({ createdBy, participantIds, title, tenantId }) => {
  const unique = [...new Set([createdBy, ...participantIds])];

  if (unique.length < 3) {
    throw new ApiError('validation_failed', {
      detail: 'A group needs at least three people. Use a direct message for two.',
    });
  }
  if (unique.length > MAX_GROUP) {
    throw new ApiError('validation_failed', { detail: `A group holds at most ${MAX_GROUP} people.` });
  }

  // Everyone has to be reachable. Adding someone who has blocked the creator
  // would put them in a room with them, which blocking is meant to prevent.
  for (const userId of unique) {
    if (userId === createdBy) continue;
    const permission = await canMessage({ fromUserId: createdBy, toUserId: userId });
    if (!permission.allowed) {
      throw new ApiError(permission.code, {
        detail: 'One of the people you selected cannot be added.',
      });
    }
  }

  const row = await Conversation.create({
    conversationId: randomUUID(),
    tenantId,
    kind: 'group',
    title: title ?? null,
    createdBy,
    participantIds: unique,
  });

  return hydrate({ row, viewerId: createdBy, created: true });
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const hydrate = async ({ row, viewerId, created = false }) => {
  const participants = await Participant.listForConversation(row.conversation_id);
  const viewer = participants.find((participant) => participant.user_id === viewerId);

  return {
    ...Conversation.toConversation(row, {
      participants: participants.map(Participant.toParticipant),
      muted: viewer?.muted ?? false,
      unreadCount: Number(row.unread_count ?? 0),
    }),
    created,
  };
};

export const getById = async ({ conversationId, viewerId }) => {
  const row = await Conversation.findById(conversationId);
  if (!row) throw new ApiError('not_found', { detail: 'Conversation not found.' });

  if (!(await Participant.isParticipant({ conversationId, userId: viewerId }))) {
    // 404, not 403: whether a conversation exists is not the caller's business.
    throw new ApiError('not_found', { detail: 'Conversation not found.' });
  }

  return hydrate({ row, viewerId });
};

export const list = async ({ userId, cursor, limit, archived }) => {
  const page = await Conversation.listForUser({ userId, cursor, limit, archived });

  const items = await Promise.all(
    page.rows.map(async (row) => {
      const participants = await Participant.listForConversation(row.conversation_id);
      return Conversation.toConversation(row, {
        participants: participants.map(Participant.toParticipant),
        unreadCount: Number(row.unread_count ?? 0),
        muted: row.muted ?? false,
      });
    }),
  );

  return { items, nextCursor: page.nextCursor, hasMore: page.hasMore };
};

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export const leave = async ({ conversationId, userId }) => {
  const row = await Conversation.findById(conversationId);
  if (!row) return false;

  if (row.kind === 'direct') {
    // Leaving a DM is archiving it. Removing yourself would orphan the thread
    // and make the other person's history unreachable.
    await Conversation.setArchived(conversationId, true);
    return true;
  }

  await Participant.remove({ conversationId, userId });
  return true;
};

export const setMuted = ({ conversationId, userId, muted }) =>
  Participant.setMuted({ conversationId, userId, muted });

export const setArchived = ({ conversationId, archived }) =>
  Conversation.setArchived(conversationId, archived);

export const assertParticipant = async ({ conversationId, userId }) => {
  if (!(await Participant.isParticipant({ conversationId, userId }))) {
    throw new ApiError('forbidden', { detail: 'You are not in this conversation.' });
  }
};

export default { openDirect, createGroup, getById, list, canMessage, leave };