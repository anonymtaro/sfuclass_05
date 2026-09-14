/**
 * assignment.routes — assignments · submissions · grading (F4)
 *
 * Depends on media/: a submission is an Assignment plus one or more Assets that were
 * uploaded through the presign flow. This file never receives a file; it receives asset
 * ids that are already scanned and `ready`, and refuses the ones that are not.
 *
 * Two rules that are easy to get wrong and expensive to fix later:
 *  - A submitted assignment locks. Resubmission is an explicit action with its own route
 *    and its own permission, so "I edited it after the deadline" cannot happen silently.
 *  - A learner can read their own grade and nobody else's; a teacher reads the gradebook.
 *    That check lives in the service, and the route states which case it is.
 */

import { Router } from 'express';
import { z } from 'zod';

import * as AssignmentService from '../assignments/AssignmentService.js';
import * as SubmissionService from '../assignments/SubmissionService.js';
import * as GradingService from '../assignments/GradingService.js';
import { route, validate, requireAuth, requireRole, tenantOf, paging, q, notFound, forbidden } from './_helpers.js';

const router = Router();
router.use(requireAuth);

const TEACHERS = ['owner', 'teacher'];
const idParam = z.object({ id: z.string().uuid() });

const rubricSchema = z
  .array(
    z.object({
      criterion: z.string().min(1).max(200),
      maxPoints: z.number().min(0).max(1000),
      description: z.string().max(1000).optional(),
    }),
  )
  .max(50);

/* ------------------------------------------------------------------ *
 * Assignments
 * ------------------------------------------------------------------ */

router.get(
  '/assignments',
  validate({
    query: z.object({
      courseId: z.string().uuid().optional(),
      lessonId: z.string().uuid().optional(),
      status: z.enum(['open', 'closed', 'draft']).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  route(async (req) =>
    AssignmentService.list({
      tenantId: tenantOf(req),
      userId: req.user.id,
      courseId: q(req).courseId,
      lessonId: q(req).lessonId,
      status: q(req).status,
      ...paging(req),
    }),
  ),
);

router.post(
  '/assignments',
  requireRole(...TEACHERS),
  validate({
    body: z.object({
      courseId: z.string().uuid(),
      lessonId: z.string().uuid().nullish(),
      title: z.string().min(1).max(200),
      instructions: z.string().max(20_000).optional(),
      dueAt: z.coerce.date().nullish(),
      timeZone: z.string().max(64).optional(),
      maxPoints: z.number().min(0).max(1000).default(100),
      allowLate: z.boolean().default(false),
      allowResubmission: z.boolean().default(true),
      maxAttachments: z.number().int().min(0).max(20).default(5),
      rubric: rubricSchema.optional(),
    }),
  }),
  route(async (req, res) => {
    res.status(201);
    return AssignmentService.create({ tenantId: tenantOf(req), createdBy: req.user.id, ...req.body });
  }),
);

router.get(
  '/assignments/:id',
  validate({ params: idParam }),
  route(async (req) => {
    const assignment = await AssignmentService.getForUser(req.params.id, req.user.id);
    if (!assignment) throw notFound('No such assignment');
    return assignment;
  }),
);

router.patch(
  '/assignments/:id',
  requireRole(...TEACHERS),
  validate({
    params: idParam,
    body: z.object({
      title: z.string().min(1).max(200).optional(),
      instructions: z.string().max(20_000).optional(),
      dueAt: z.coerce.date().nullish(),
      maxPoints: z.number().min(0).max(1000).optional(),
      allowLate: z.boolean().optional(),
      allowResubmission: z.boolean().optional(),
      rubric: rubricSchema.optional(),
      status: z.enum(['draft', 'open', 'closed']).optional(),
    }),
  }),
  route(async (req) => AssignmentService.update(req.params.id, req.body, { actorId: req.user.id })),
);

router.delete(
  '/assignments/:id',
  requireRole(...TEACHERS),
  validate({ params: idParam }),
  route(async (req) => {
    await AssignmentService.archive(req.params.id, { actorId: req.user.id });
    return null;
  }),
);

/* ------------------------------------------------------------------ *
 * Submissions
 * ------------------------------------------------------------------ */

/** A learner's own submission, or 404 if they have not started one. */
router.get(
  '/assignments/:id/submission',
  validate({ params: idParam }),
  route(async (req) => {
    const submission = await SubmissionService.forLearner({ assignmentId: req.params.id, userId: req.user.id });
    if (!submission) throw notFound('No submission yet');
    return submission;
  }),
);

router.post(
  '/assignments/:id/submission',
  validate({
    params: idParam,
    body: z.object({
      note: z.string().max(10_000).optional(),
      assetIds: z.array(z.string().uuid()).max(20).default([]),
      clientId: z.string().max(128).optional(),
    }),
  }),
  route(async (req, res) => {
    const result = await SubmissionService.submit({
      assignmentId: req.params.id,
      userId: req.user.id,
      note: req.body.note ?? null,
      assetIds: req.body.assetIds,
      clientId: req.body.clientId ?? null,
    });

    if (result.rejected) {
      // Late without permission, locked, or an asset that never passed the virus scan.
      throw Object.assign(new Error(result.reason), {
        status: 409,
        code: result.code ?? 'SUBMISSION_REJECTED',
        details: result.details ?? null,
        expose: true,
      });
    }

    res.status(201);
    return result.submission;
  }),
);

/** Explicit, permissioned, and audited — never a silent overwrite of a locked submission. */
router.post(
  '/submissions/:id/resubmit',
  validate({
    params: idParam,
    body: z.object({ note: z.string().max(10_000).optional(), assetIds: z.array(z.string().uuid()).max(20).default([]) }),
  }),
  route(async (req) =>
    SubmissionService.resubmit({ submissionId: req.params.id, userId: req.user.id, ...req.body }),
  ),
);

router.get(
  '/assignments/:id/submissions',
  requireRole(...TEACHERS),
  validate({
    params: idParam,
    query: z.object({
      status: z.enum(['submitted', 'graded', 'missing', 'late']).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  route(async (req) =>
    SubmissionService.listForAssignment({ assignmentId: req.params.id, status: q(req).status, ...paging(req) }),
  ),
);

router.get(
  '/submissions/:id',
  validate({ params: idParam }),
  route(async (req) => {
    const submission = await SubmissionService.get(req.params.id);
    if (!submission) throw notFound('No such submission');
    if (submission.userId !== req.user.id && !TEACHERS.includes(req.user.role)) {
      throw forbidden("You cannot read another learner's submission");
    }
    return submission;
  }),
);

/* ------------------------------------------------------------------ *
 * Grading
 * ------------------------------------------------------------------ */

router.put(
  '/submissions/:id/grade',
  requireRole(...TEACHERS),
  validate({
    params: idParam,
    body: z.object({
      score: z.number().min(0).max(1000),
      feedback: z.string().max(20_000).optional(),
      rubricScores: z.array(z.object({ criterion: z.string().max(200), points: z.number().min(0) })).max(50).optional(),
      publish: z.boolean().default(true), // false = save a draft grade the learner cannot see
    }),
  }),
  route(async (req) => GradingService.grade({ submissionId: req.params.id, graderId: req.user.id, ...req.body })),
);

router.post(
  '/submissions/:id/return',
  requireRole(...TEACHERS),
  validate({ params: idParam, body: z.object({ note: z.string().max(2000).optional() }).default({}) }),
  route(async (req) =>
    GradingService.returnForRevision({ submissionId: req.params.id, graderId: req.user.id, note: req.body.note ?? null }),
  ),
);

router.get(
  '/courses/:id/gradebook',
  requireRole(...TEACHERS),
  validate({ params: idParam, query: z.object({ format: z.enum(['json', 'csv']).optional() }) }),
  route(async (req, res) => {
    const format = q(req).format ?? 'json';
    const gradebook = await GradingService.gradebook({ courseId: req.params.id, format });

    if (format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="gradebook-${req.params.id}.csv"`);
      res.set('Cache-Control', 'no-store');
      res.send(gradebook.csv);
      return undefined;
    }
    return gradebook;
  }),
);

/** A learner's own grades across a course. */
router.get(
  '/courses/:id/grades',
  validate({ params: idParam }),
  route(async (req) => GradingService.forLearner({ courseId: req.params.id, userId: req.user.id })),
);

export default router;