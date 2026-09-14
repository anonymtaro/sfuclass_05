/**
 * messaging.routes — conversations · messages · search (F6)
 *
 * The route that carries the product decision: `POST /conversations/direct` is a single
 * idempotent open-or-create. Clicking a person anywhere in the app — participant list,
 * community thread, public channel, course roster — hits this one endpoint, and it returns
 * the existing conversation or makes one. There is no separate "new message" flow to keep
 * in sync, and no way for two clicks to produce two threads.
 *
 * History is keyset-paginated by (conversation_id, created_at, id). Not a nicety: a channel
 * that reaches six figures still has to open in one frame.
 *
 * Sending is at-least-once from the client's side. `clientId` is the dedupe key, so an
 * outbox that retries after a reconnect produces one message, and the ack carries the
 * clientId back so the optimistic bubble can be reconciled.
 *
 * Blocking and DM policy are enforced here, on send — never hidden in the UI.
 */

import { Router } from 'express';
import { z } from 'zod';

import * as ConversationService from '../messaging/ConversationService.js';
import * as DirectMessageService from '../messaging/DirectMessageService.js';
import * as PublicChatService from '../messaging/PublicChatService.js';
import * as ChatAttachmentService from '../messaging/ChatAttachmentService.js';
import * as ChatSearchService from '../messaging/ChatSearchService.js';
import * as UnreadService from '../messaging/UnreadService.js';
import * as ChatModerationService from '../messaging/ChatModerationService.js';
import { env } from '../config/env.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { route, validate, requireAuth, tenantOf, paging, q, notFound, forbidden, badRequest } from './_helpers.js';

const router = Router();
router.use(requireAuth);

const idParam = z.object({ id: z.string().uuid() });
const pageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  direction: z.enum(['forward', 'backward']).optional(),
});

/* ------------------------------------------------------------------ *
 * Conversations
 * ------------------------------------------------------------------ */

router.get(
  '/conversations',
  validate({ query: pageQuery.extend({ kind: z.enum(['direct', 'group', 'channel']).optional() }) }),
  route(async (req) =>
    ConversationService.listForUser({ userId: req.user.id, tenantId: tenantOf(req), kind: q(req).kind, ...paging(req) }),
  ),
);

/**
 * Open or create. Idempotent by construction: a 1:1 conversation is identified by its
 * participant set, so the same pair always resolves to the same row.
 */
router.post(
  '/conversations/direct',
  rateLimit({ key: 'chat:open-dm', points: 60, durationSec: 300, by: ['user'] }),
  validate({ body: z.object({ userId: z.string().uuid() }) }),
  route(async (req, res) => {
    if (req.body.userId === req.user.id) throw badRequest('You cannot message yourself');

    const result = await ConversationService.openOrCreateDirect(req.user.id, req.body.userId, {
      tenantId: tenantOf(req),
    });
    if (!result.allowed) {
      // Blocked, or the recipient's DM policy is narrower than this relationship.
      throw forbidden(result.reason ?? 'You cannot message this person');
    }

    res.status(result.created ? 201 : 200);
    return result.conversation;
  }),
);

/** A small group chat is the same object with more participants. */
router.post(
  '/conversations/group',
  validate({
    body: z.object({
      userIds: z.array(z.string().uuid()).min(2).max(50),
      title: z.string().max(120).optional(),
    }),
  }),
  route(async (req, res) => {
    res.status(201);
    return ConversationService.createGroup({
      tenantId: tenantOf(req),
      createdBy: req.user.id,
      userIds: req.body.userIds,
      title: req.body.title ?? null,
    });
  }),
);

router.get(
  '/conversations/:id',
  validate({ params: idParam }),
  route(async (req) => {
    const conversation = await ConversationService.getForUser(req.params.id, req.user.id);
    if (!conversation) throw notFound('No such conversation');
    return conversation;
  }),
);

router.patch(
  '/conversations/:id',
  validate({
    params: idParam,
    body: z.object({ title: z.string().max(120).optional(), muted: z.boolean().optional() }),
  }),
  route(async (req) => ConversationService.updateParticipantState(req.params.id, req.user.id, req.body)),
);

router.delete(
  '/conversations/:id/participants/me',
  validate({ params: idParam }),
  route(async (req) => {
    await ConversationService.leave(req.params.id, req.user.id);
    return null;
  }),
);

/* ------------------------------------------------------------------ *
 * Channels (public, space-bound, course-bound)
 * ------------------------------------------------------------------ */

router.get(
  '/channels',
  validate({ query: z.object({ scope: z.enum(['public', 'space', 'course']).optional() }) }),
  route(async (req) => ({
    channels: await PublicChatService.listChannels({ tenantId: tenantOf(req), userId: req.user.id, scope: q(req).scope }),
  })),
);

/**
 * Full history is readable by any member, including the part that happened before they
 * arrived — a new joiner should see the room they walked into.
 */
router.get(
  '/channels/:id/messages',
  validate({ params: idParam, query: pageQuery }),
  route(async (req) =>
    PublicChatService.history({ channelId: req.params.id, userId: req.user.id, ...paging(req, { defaultLimit: 50 }) }),
  ),
);

router.post(
  '/channels/:id/messages',
  rateLimit({ key: 'chat:send', points: env.CHAT_RATE_PER_MIN, durationSec: 60, by: ['user'] }),
  validate({
    params: idParam,
    body: z.object({
      body: z.string().max(env.CHAT_MAX_MESSAGE_LEN),
      attachmentIds: z.array(z.string().uuid()).max(10).default([]),
      replyToId: z.string().uuid().nullish(),
      clientId: z.string().max(128),
    }),
  }),
  route(async (req, res) => {
    if (!req.body.body.trim() && req.body.attachmentIds.length === 0) {
      throw badRequest('A message needs text or an attachment');
    }
    const result = await PublicChatService.post({
      channelId: req.params.id,
      userId: req.user.id,
      ...req.body,
    });
    if (!result.allowed) throw forbidden(result.reason ?? 'You cannot post in this channel');

    res.status(result.deduped ? 200 : 201);
    return { message: result.message, clientId: req.body.clientId, deduped: Boolean(result.deduped) };
  }),
);

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

router.get(
  '/conversations/:id/messages',
  validate({ params: idParam, query: pageQuery.extend({ around: z.string().uuid().optional() }) }),
  route(async (req) =>
    DirectMessageService.history({
      conversationId: req.params.id,
      userId: req.user.id,
      around: q(req).around ?? null, // jump-to-message from search, then page both ways
      ...paging(req, { defaultLimit: 50 }),
    }),
  ),
);

router.post(
  '/conversations/:id/messages',
  rateLimit({ key: 'chat:send', points: env.CHAT_RATE_PER_MIN, durationSec: 60, by: ['user'] }),
  validate({
    params: idParam,
    body: z.object({
      body: z.string().max(env.CHAT_MAX_MESSAGE_LEN),
      attachmentIds: z.array(z.string().uuid()).max(10).default([]),
      replyToId: z.string().uuid().nullish(),
      clientId: z.string().max(128),
    }),
  }),
  route(async (req, res) => {
    if (!req.body.body.trim() && req.body.attachmentIds.length === 0) {
      throw badRequest('A message needs text or an attachment');
    }

    const result = await DirectMessageService.send({
      conversationId: req.params.id,
      senderId: req.user.id,
      ...req.body,
    });
    if (!result.allowed) throw forbidden(result.reason ?? 'You cannot send to this conversation');

    // Same clientId twice = one message. The outbox may retry after a reconnect.
    res.status(result.deduped ? 200 : 201);
    return { message: result.message, clientId: req.body.clientId, deduped: Boolean(result.deduped) };
  }),
);

router.patch(
  '/messages/:id',
  validate({ params: idParam, body: z.object({ body: z.string().min(1).max(env.CHAT_MAX_MESSAGE_LEN) }) }),
  route(async (req) => DirectMessageService.edit({ messageId: req.params.id, userId: req.user.id, body: req.body.body })),
);

router.delete(
  '/messages/:id',
  validate({ params: idParam }),
  route(async (req) => {
    // Soft delete with an audit record: moderation needs to know what was removed.
    await DirectMessageService.remove({ messageId: req.params.id, actorId: req.user.id });
    return null;
  }),
);

/* ------------------------------------------------------------------ *
 * Read state and unread counters
 * ------------------------------------------------------------------ */

router.post(
  '/conversations/:id/read',
  validate({ params: idParam, body: z.object({ upToMessageId: z.string().uuid() }) }),
  route(async (req) =>
    UnreadService.markRead({
      conversationId: req.params.id,
      userId: req.user.id,
      upToMessageId: req.body.upToMessageId,
    }),
  ),
);

/** One call for the whole badge state — the dock renders every row from this. */
router.get(
  '/messaging/unread',
  route(async (req) => UnreadService.snapshot({ userId: req.user.id, tenantId: tenantOf(req) })),
);

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

/**
 * Chat attachments have no storage path of their own — this delegates to the media domain,
 * so quota, virus scanning, signed delivery and lifecycle rules apply for free.
 */
router.post(
  '/messaging/attachments',
  validate({
    body: z.object({
      conversationId: z.string().uuid().nullish(),
      channelId: z.string().uuid().nullish(),
      filename: z.string().min(1).max(255),
      contentType: z.string().min(1).max(255),
      sizeBytes: z.number().int().min(1),
    }),
  }),
  route(async (req, res) => {
    if (!req.body.conversationId && !req.body.channelId) {
      throw badRequest('An attachment needs a conversationId or a channelId');
    }
    res.status(201);
    return ChatAttachmentService.presign({ userId: req.user.id, tenantId: tenantOf(req), ...req.body });
  }),
);

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

router.get(
  '/messaging/search',
  rateLimit({ key: 'chat:search', points: 60, durationSec: 60, by: ['user'] }),
  validate({
    query: z.object({
      q: z.string().min(2).max(200),
      conversationId: z.string().uuid().optional(),
      channelId: z.string().uuid().optional(),
      from: z.string().uuid().optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
  }),
  route(async (req) =>
    // Scoped to what this user may read; the index is filtered, not the results.
    ChatSearchService.search({
      userId: req.user.id,
      tenantId: tenantOf(req),
      query: q(req).q,
      conversationId: q(req).conversationId,
      channelId: q(req).channelId,
      senderId: q(req).from,
      ...paging(req, { defaultLimit: 25, maxLimit: 50 }),
    }),
  ),
);

/* ------------------------------------------------------------------ *
 * Moderation
 * ------------------------------------------------------------------ */

router.post(
  '/messaging/reports',
  validate({
    body: z.object({
      messageId: z.string().uuid(),
      reason: z.enum(['spam', 'abuse', 'harassment', 'nsfw', 'other']),
      note: z.string().max(2000).optional(),
    }),
  }),
  route(async (req, res) => {
    res.status(202);
    return ChatModerationService.report({ reporterId: req.user.id, tenantId: tenantOf(req), ...req.body });
  }),
);

router.post(
  '/channels/:id/slow-mode',
  validate({ params: idParam, body: z.object({ seconds: z.number().int().min(0).max(3600) }) }),
  route(async (req) => {
    if (!['owner', 'teacher'].includes(req.user.role)) throw forbidden('Moderators only');
    return ChatModerationService.setSlowMode({
      channelId: req.params.id,
      seconds: req.body.seconds,
      actorId: req.user.id,
    });
  }),
);

router.post(
  '/channels/:id/mutes',
  validate({
    params: idParam,
    body: z.object({ userId: z.string().uuid(), minutes: z.number().int().min(1).max(43_200) }),
  }),
  route(async (req) => {
    if (!['owner', 'teacher'].includes(req.user.role)) throw forbidden('Moderators only');
    return ChatModerationService.mute({ channelId: req.params.id, actorId: req.user.id, ...req.body });
  }),
);

export default router;