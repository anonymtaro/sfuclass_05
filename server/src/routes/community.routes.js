/**
 * community.routes — spaces · threads · posts · feed · notifications (F2)
 *
 * Spaces are auto-provisioned when a course is published, so there is no "create space for
 * course" route: SpaceService does it on the publish event. What is here is the standalone
 * case and everything a member does inside a space.
 *
 * Feeds are cursor-paginated in both directions. A community timeline that uses OFFSET
 * starts skipping and repeating posts the moment someone writes while you scroll.
 *
 * Read paths prefer the read replica; writes never touch it. That routing is
 * FeedService's job, not this file's — the routes just say which they are.
 */

import { Router } from 'express';
import { z } from 'zod';

import * as SpaceService from '../community/SpaceService.js';
import * as FeedService from '../community/FeedService.js';
import * as PresenceService from '../community/PresenceService.js';
import * as ModerationService from '../community/ModerationService.js';
import * as NotificationService from '../community/NotificationService.js';
import { route, validate, requireAuth, tenantOf, paging, q, notFound, forbidden } from './_helpers.js';

const router = Router();
router.use(requireAuth);

const idParam = z.object({ id: z.string().uuid() });
const pageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  direction: z.enum(['forward', 'backward']).optional(),
});

/* ------------------------------------------------------------------ *
 * Spaces
 * ------------------------------------------------------------------ */

router.get(
  '/spaces',
  validate({ query: pageQuery.extend({ joined: z.coerce.boolean().optional() }) }),
  route(async (req) =>
    SpaceService.list({
      tenantId: tenantOf(req),
      userId: req.user.id,
      joinedOnly: q(req).joined === true,
      ...paging(req),
    }),
  ),
);

router.post(
  '/spaces',
  validate({
    body: z.object({
      name: z.string().min(1).max(120),
      description: z.string().max(2000).optional(),
      visibility: z.enum(['open', 'closed']).default('open'),
    }),
  }),
  route(async (req, res) => {
    res.status(201);
    return SpaceService.create({ tenantId: tenantOf(req), createdBy: req.user.id, ...req.body });
  }),
);

router.get(
  '/spaces/:id',
  validate({ params: idParam }),
  route(async (req) => {
    const space = await SpaceService.getForUser(req.params.id, req.user.id);
    if (!space) throw notFound('No such space');
    return space;
  }),
);

router.post(
  '/spaces/:id/members',
  validate({ params: idParam, body: z.object({ userId: z.string().uuid().optional() }).default({}) }),
  route(async (req, res) => {
    const targetId = req.body.userId ?? req.user.id;
    if (targetId !== req.user.id) {
      const membership = await SpaceService.membershipOf(req.params.id, req.user.id);
      if (!membership || !['owner', 'moderator'].includes(membership.role)) {
        throw forbidden('Only a moderator can add someone else');
      }
    }
    res.status(201);
    return SpaceService.join({ spaceId: req.params.id, userId: targetId, actorId: req.user.id });
  }),
);

router.delete(
  '/spaces/:id/members/:userId',
  validate({ params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }) }),
  route(async (req) => {
    await SpaceService.leave({ spaceId: req.params.id, userId: req.params.userId, actorId: req.user.id });
    return null;
  }),
);

router.get(
  '/spaces/:id/presence',
  validate({ params: idParam }),
  route(async (req) => ({ online: await PresenceService.listForSpace(req.params.id) })),
);

/* ------------------------------------------------------------------ *
 * Threads and posts
 * ------------------------------------------------------------------ */

router.get(
  '/spaces/:id/threads',
  validate({ params: idParam, query: pageQuery.extend({ sort: z.enum(['recent', 'active']).optional() }) }),
  route(async (req) =>
    FeedService.threadsInSpace({ spaceId: req.params.id, userId: req.user.id, sort: q(req).sort ?? 'active', ...paging(req) }),
  ),
);

router.post(
  '/spaces/:id/threads',
  validate({
    params: idParam,
    body: z.object({
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(20_000),
      attachmentIds: z.array(z.string().uuid()).max(10).default([]),
    }),
  }),
  route(async (req, res) => {
    res.status(201);
    return FeedService.createThread({ spaceId: req.params.id, authorId: req.user.id, ...req.body });
  }),
);

router.get(
  '/threads/:id',
  validate({ params: idParam, query: pageQuery }),
  route(async (req) => FeedService.getThread({ threadId: req.params.id, userId: req.user.id, ...paging(req) })),
);

router.post(
  '/threads/:id/posts',
  validate({
    params: idParam,
    body: z.object({
      body: z.string().min(1).max(20_000),
      replyToId: z.string().uuid().nullish(),
      attachmentIds: z.array(z.string().uuid()).max(10).default([]),
      clientId: z.string().max(128).optional(),
    }),
  }),
  route(async (req, res) => {
    res.status(201);
    return FeedService.createPost({ threadId: req.params.id, authorId: req.user.id, ...req.body });
  }),
);

router.patch(
  '/posts/:id',
  validate({ params: idParam, body: z.object({ body: z.string().min(1).max(20_000) }) }),
  route(async (req) => FeedService.editPost({ postId: req.params.id, actorId: req.user.id, body: req.body.body })),
);

/** Soft delete with an audit record — moderation history must survive the deletion. */
router.delete(
  '/posts/:id',
  validate({ params: idParam }),
  route(async (req) => {
    await FeedService.deletePost({ postId: req.params.id, actorId: req.user.id });
    return null;
  }),
);

router.put(
  '/posts/:id/reactions/:emoji',
  validate({ params: z.object({ id: z.string().uuid(), emoji: z.string().min(1).max(16) }) }),
  route(async (req) =>
    FeedService.react({ postId: req.params.id, userId: req.user.id, emoji: req.params.emoji, on: true }),
  ),
);

router.delete(
  '/posts/:id/reactions/:emoji',
  validate({ params: z.object({ id: z.string().uuid(), emoji: z.string().min(1).max(16) }) }),
  route(async (req) => {
    await FeedService.react({ postId: req.params.id, userId: req.user.id, emoji: req.params.emoji, on: false });
    return null;
  }),
);

/* ------------------------------------------------------------------ *
 * Personal feed and notifications
 * ------------------------------------------------------------------ */

router.get(
  '/feed',
  validate({ query: pageQuery }),
  route(async (req) => FeedService.personalTimeline({ userId: req.user.id, tenantId: tenantOf(req), ...paging(req) })),
);

router.get(
  '/notifications',
  validate({ query: pageQuery.extend({ unreadOnly: z.coerce.boolean().optional() }) }),
  route(async (req) =>
    NotificationService.list({ userId: req.user.id, unreadOnly: q(req).unreadOnly === true, ...paging(req) }),
  ),
);

router.post(
  '/notifications/read',
  validate({
    body: z.object({ ids: z.array(z.string().uuid()).max(500).optional(), upTo: z.coerce.date().optional() }),
  }),
  route(async (req) => ({
    marked: await NotificationService.markRead({ userId: req.user.id, ids: req.body.ids, upTo: req.body.upTo }),
  })),
);

router.get(
  '/notifications/preferences',
  route(async (req) => NotificationService.getPreferences(req.user.id)),
);

router.put(
  '/notifications/preferences',
  validate({
    body: z.object({
      digest: z.enum(['off', 'daily', 'weekly']).optional(),
      push: z.record(z.boolean()).optional(),
      email: z.record(z.boolean()).optional(),
      quietHours: z.object({ start: z.string(), end: z.string(), timeZone: z.string() }).nullish(),
    }),
  }),
  route(async (req) => NotificationService.setPreferences(req.user.id, req.body)),
);

/* ------------------------------------------------------------------ *
 * Moderation
 * ------------------------------------------------------------------ */

router.post(
  '/community/reports',
  validate({
    body: z.object({
      targetType: z.enum(['post', 'thread', 'space', 'user']),
      targetId: z.string().uuid(),
      reason: z.enum(['spam', 'abuse', 'harassment', 'off-topic', 'other']),
      note: z.string().max(2000).optional(),
    }),
  }),
  route(async (req, res) => {
    res.status(202);
    return ModerationService.report({ reporterId: req.user.id, tenantId: tenantOf(req), ...req.body });
  }),
);

router.get(
  '/community/reports',
  validate({ query: pageQuery.extend({ status: z.enum(['open', 'resolved']).optional() }) }),
  route(async (req) => {
    if (!['owner', 'teacher'].includes(req.user.role)) throw forbidden('Moderators only');
    return ModerationService.queue({ tenantId: tenantOf(req), status: q(req).status ?? 'open', ...paging(req) });
  }),
);

router.post(
  '/community/reports/:id/resolve',
  validate({
    params: idParam,
    body: z.object({
      action: z.enum(['dismiss', 'delete', 'mute', 'remove']),
      note: z.string().max(2000).optional(),
      muteHours: z.number().int().min(1).max(720).optional(),
    }),
  }),
  route(async (req) => {
    if (!['owner', 'teacher'].includes(req.user.role)) throw forbidden('Moderators only');
    return ModerationService.resolve({ reportId: req.params.id, actorId: req.user.id, ...req.body });
  }),
);

export default router;