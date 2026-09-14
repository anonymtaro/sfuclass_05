/**
 * profile.routes — public profile · block · report (F6)
 *
 * The profile is the anchor for direct messages, so what this file returns decides what a
 * "Message" button may do. Three things follow from that:
 *
 *  - A profile read is filtered by the viewer. Visibility and DM policy are applied before
 *    serialisation; the client is never handed a field it then has to hide. `canMessage`
 *    comes back computed, so the button's presence and the send permission agree.
 *  - A block is symmetric and enforced server-side on send. This route only records it.
 *  - Profiles are enumerable by id, so lookups are rate-limited — a chat product is a
 *    user-directory scraper if you let it be.
 */

import { Router } from 'express';
import { z } from 'zod';

import * as Profile from '../identity/Profile.js';
import * as ConversationService from '../messaging/ConversationService.js';
import * as ChatModerationService from '../messaging/ChatModerationService.js';
import * as UploadService from '../media/UploadService.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { route, validate, requireAuth, tenantOf, paging, q, notFound, badRequest } from './_helpers.js';

const router = Router();
router.use(requireAuth);

const userIdParam = z.object({ userId: z.string().uuid() });

/* ------------------------------------------------------------------ *
 * Own profile
 * ------------------------------------------------------------------ */

router.get(
  '/profiles/me',
  route(async (req) => Profile.getOwn(req.user.id)),
);

router.patch(
  '/profiles/me',
  validate({
    body: z.object({
      displayName: z.string().min(1).max(80).optional(),
      bio: z.string().max(1000).optional(),
      headline: z.string().max(140).optional(),
      avatarAssetId: z.string().uuid().nullish(),
      timeZone: z.string().max(64).optional(),
      locale: z.string().max(10).optional(),
      links: z.array(z.object({ label: z.string().max(40), url: z.string().url() })).max(5).optional(),
    }),
  }),
  route(async (req) => Profile.updateOwn(req.user.id, req.body)),
);

/**
 * Who may DM me. `nobody` still lets a teacher reach a learner in a course they share —
 * that exception lives in ConversationService, not in the setting.
 */
router.put(
  '/profiles/me/privacy',
  validate({
    body: z.object({
      visibility: z.enum(['tenant', 'shared-only', 'private']).optional(),
      dmPolicy: z.enum(['anyone', 'shared-only', 'nobody']).optional(),
      showPresence: z.boolean().optional(),
      showReadReceipts: z.boolean().optional(),
    }),
  }),
  route(async (req) => Profile.updatePrivacy(req.user.id, req.body)),
);

/** Avatar upload goes through the media presign flow like any other asset. */
router.post(
  '/profiles/me/avatar',
  validate({
    body: z.object({
      filename: z.string().min(1).max(255),
      contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
      sizeBytes: z.number().int().min(1).max(10 * 1024 * 1024),
    }),
  }),
  route(async (req, res) => {
    res.status(201);
    return UploadService.createMultipart({
      tenantId: tenantOf(req),
      userId: req.user.id,
      purpose: 'avatar',
      contextId: null,
      ...req.body,
    });
  }),
);

/* ------------------------------------------------------------------ *
 * Other people
 * ------------------------------------------------------------------ */

router.get(
  '/profiles/:userId',
  rateLimit({ key: 'profile:read', points: 300, durationSec: 300, by: ['user'] }),
  validate({ params: userIdParam }),
  route(async (req) => {
    const profile = await Profile.getPublic(req.params.userId, {
      viewerId: req.user.id,
      tenantId: tenantOf(req),
    });
    if (!profile) throw notFound('No such profile');

    // Computed, not guessed by the client: the button and the send check agree.
    const messaging = await ConversationService.canMessage(req.user.id, req.params.userId);
    return { ...profile, canMessage: messaging.allowed, messageBlockedReason: messaging.reason ?? null };
  }),
);

/** Directory search. Narrow by design: it only returns people the viewer may see. */
router.get(
  '/profiles',
  rateLimit({ key: 'profile:search', points: 60, durationSec: 60, by: ['user'] }),
  validate({
    query: z.object({
      q: z.string().min(2).max(80),
      courseId: z.string().uuid().optional(),
      spaceId: z.string().uuid().optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(25).optional(),
    }),
  }),
  route(async (req) =>
    Profile.search({
      viewerId: req.user.id,
      tenantId: tenantOf(req),
      query: q(req).q,
      courseId: q(req).courseId,
      spaceId: q(req).spaceId,
      ...paging(req, { defaultLimit: 15, maxLimit: 25 }),
    }),
  ),
);

/** What we have in common — the ProfileModal shows this under the bio. */
router.get(
  '/profiles/:userId/shared',
  validate({ params: userIdParam }),
  route(async (req) => Profile.sharedContext(req.user.id, req.params.userId)),
);

/* ------------------------------------------------------------------ *
 * Blocking
 * ------------------------------------------------------------------ */

router.get(
  '/profiles/me/blocks',
  route(async (req) => ({ blocked: await Profile.listBlocks(req.user.id) })),
);

router.put(
  '/profiles/:userId/block',
  validate({ params: userIdParam, body: z.object({ reason: z.string().max(500).optional() }).default({}) }),
  route(async (req) => {
    if (req.params.userId === req.user.id) throw badRequest('You cannot block yourself');
    // Symmetric: neither side can send afterwards. Enforcement is in the messaging domain.
    return Profile.block({ userId: req.user.id, blockedId: req.params.userId, reason: req.body.reason ?? null });
  }),
);

router.delete(
  '/profiles/:userId/block',
  validate({ params: userIdParam }),
  route(async (req) => {
    await Profile.unblock({ userId: req.user.id, blockedId: req.params.userId });
    return null;
  }),
);

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

router.post(
  '/profiles/:userId/report',
  rateLimit({ key: 'profile:report', points: 20, durationSec: 3600, by: ['user'] }),
  validate({
    params: userIdParam,
    body: z.object({
      reason: z.enum(['spam', 'abuse', 'harassment', 'impersonation', 'nsfw', 'other']),
      note: z.string().max(2000).optional(),
      messageIds: z.array(z.string().uuid()).max(20).default([]), // evidence, if it came from chat
    }),
  }),
  route(async (req, res) => {
    res.status(202);
    return ChatModerationService.reportUser({
      reporterId: req.user.id,
      reportedId: req.params.userId,
      tenantId: tenantOf(req),
      ...req.body,
    });
  }),
);

export default router;