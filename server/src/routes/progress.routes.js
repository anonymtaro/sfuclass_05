/**
 * progress.routes — completion, resume position, certificates (F3)
 *
 * Progress writes arrive constantly (a video player reports its position every few
 * seconds) and they arrive out of order, because the offline queue replays them after a
 * reconnect. Two consequences shape this file:
 *
 *  - Position updates are idempotent and monotonic. The service keeps the furthest
 *    position seen, so a replayed stale beat can never rewind a learner.
 *  - The heartbeat route is deliberately cheap and batched: one call carries several
 *    lessons, so an Expo client coming back online sends one request, not forty.
 *
 * Completion is a decision, not a report: the client says "I finished", the server decides
 * whether the prerequisites allow it and whether that completes the path — and issues the
 * certificate if it does.
 */

import { Router } from 'express';
import { z } from 'zod';

import * as ProgressService from '../courses/ProgressService.js';
import * as CertificateService from '../courses/CertificateService.js';
import * as AssetDelivery from '../media/AssetDelivery.js';
import { route, validate, requireAuth, tenantOf, q, notFound, forbidden } from './_helpers.js';

const router = Router();

const idParam = z.object({ id: z.string().uuid() });

/**
 * Public verification, registered before the auth guard on purpose — an employer checking
 * a certificate has no account here. It returns the holder's name, the path and the issue
 * date, and nothing else about the learner.
 */
router.get(
  '/certificates/verify/:serial',
  validate({ params: z.object({ serial: z.string().min(8).max(64) }) }),
  route(async (req) => {
    const record = await CertificateService.verifyBySerial(req.params.serial);
    if (!record) throw notFound('No certificate with that serial');
    return record;
  }),
);

router.use(requireAuth);

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

router.get(
  '/progress/courses/:id',
  validate({
    params: idParam,
    query: z.object({ userId: z.string().uuid().optional() }),
  }),
  route(async (req) => {
    const targetId = q(req).userId ?? req.user.id;
    if (targetId !== req.user.id && !['owner', 'teacher'].includes(req.user.role)) {
      throw forbidden("You cannot read another learner's progress");
    }
    return ProgressService.forCourse({ courseId: req.params.id, userId: targetId });
  }),
);

/** The "continue where I left off" card on the dashboard. */
router.get(
  '/progress/resume',
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(20).optional() }) }),
  route(async (req) =>
    ProgressService.resumeList({ userId: req.user.id, tenantId: tenantOf(req), limit: q(req).limit ?? 5 }),
  ),
);

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * Batched heartbeat. `positionSeconds` is monotonic per lesson — the service keeps the max
 * it has seen, so replayed offline beats cannot rewind anyone.
 */
router.post(
  '/progress/heartbeat',
  validate({
    body: z.object({
      beats: z
        .array(
          z.object({
            lessonId: z.string().uuid(),
            positionSeconds: z.number().min(0).max(86_400),
            watchedSeconds: z.number().min(0).max(86_400).optional(),
            at: z.coerce.date().optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
  }),
  route(async (req) => {
    const applied = await ProgressService.recordBeats({ userId: req.user.id, beats: req.body.beats });
    return { applied: applied.length, lessons: applied };
  }),
);

router.post(
  '/progress/lessons/:id/complete',
  validate({
    params: idParam,
    body: z.object({ clientId: z.string().max(128).optional(), score: z.number().min(0).max(100).optional() }).default({}),
  }),
  route(async (req) => {
    const result = await ProgressService.completeLesson({
      lessonId: req.params.id,
      userId: req.user.id,
      score: req.body.score ?? null,
      clientId: req.body.clientId ?? null, // dedupe key for the offline replay queue
    });

    if (result.blockedBy?.length) {
      throw Object.assign(new Error('Prerequisites are not met'), {
        status: 409,
        code: 'PREREQUISITES_UNMET',
        details: { blockedBy: result.blockedBy },
        expose: true,
      });
    }
    return result;
  }),
);

/** Undo, for a learner who marked the wrong lesson. Never available once a cert is issued. */
router.delete(
  '/progress/lessons/:id/complete',
  validate({ params: idParam }),
  route(async (req) => {
    await ProgressService.uncompleteLesson({ lessonId: req.params.id, userId: req.user.id });
    return null;
  }),
);

/* ------------------------------------------------------------------ *
 * Certificates
 * ------------------------------------------------------------------ */

router.get(
  '/progress/certificates',
  route(async (req) => ({ certificates: await CertificateService.listForUser(req.user.id) })),
);

/**
 * The PDF is a signed asset in S3, so the route hands back a short-lived CloudFront URL
 * rather than streaming bytes through the API.
 */
router.get(
  '/progress/certificates/:id',
  validate({ params: idParam }),
  route(async (req) => {
    const certificate = await CertificateService.get(req.params.id);
    if (!certificate || certificate.userId !== req.user.id) throw notFound('No such certificate');
    return {
      ...certificate,
      downloadUrl: await AssetDelivery.signedUrl(certificate.assetId, { ttlSeconds: 300 }),
    };
  }),
);

export default router;