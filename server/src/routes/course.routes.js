/**
 * course.routes — courses · modules · lessons · paths · publishing (F3)
 *
 * The curriculum is a DAG, not a list, so two things are routes rather than fields:
 * prerequisite edges (`/paths/:id/edges`) and publication (`/courses/:id/publish`).
 * Validation of the graph — cycles, orphans, unreachable modules — happens in
 * CurriculumGraph before a version can be published, never at read time.
 *
 * Collaborative editing of the builder tree does NOT go through here. That is a Yjs
 * document over realtime/collabServer.js; these routes are for structural operations and
 * for clients that are not currently in a collaborative session.
 */

import { Router } from 'express';
import { z } from 'zod';

import * as CourseService from '../courses/CourseService.js';
import * as CurriculumGraph from '../courses/CurriculumGraph.js';
import * as PrerequisiteResolver from '../courses/PrerequisiteResolver.js';
import * as LiveSessionLink from '../courses/LiveSessionLink.js';
import * as ScheduleService from '../scheduling/ScheduleService.js';
import { route, validate, requireAuth, requireRole, tenantOf, paging, q, notFound } from './_helpers.js';

const router = Router();
const TEACHERS = ['owner', 'teacher'];

const idParam = z.object({ id: z.string().uuid() });

const lessonSchema = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(['live', 'video', 'doc', 'quiz', 'task']),
  moduleId: z.string().uuid(),
  position: z.number().int().min(0).optional(),
  assetId: z.string().uuid().nullish(),
  durationMinutes: z.number().int().min(0).max(600).optional(),
  body: z.record(z.unknown()).optional(),
});

router.use(requireAuth);

/* ------------------------------------------------------------------ *
 * Courses
 * ------------------------------------------------------------------ */

router.get(
  '/courses',
  validate({
    query: z.object({
      status: z.enum(['draft', 'published', 'archived']).optional(),
      enrolled: z.coerce.boolean().optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  route(async (req) =>
    CourseService.list({
      tenantId: tenantOf(req),
      userId: req.user.id,
      status: q(req).status,
      enrolledOnly: q(req).enrolled === true,
      ...paging(req),
    }),
  ),
);

router.post(
  '/courses',
  requireRole(...TEACHERS),
  validate({
    body: z.object({
      title: z.string().min(1).max(200),
      summary: z.string().max(2000).optional(),
      coverAssetId: z.string().uuid().nullish(),
      visibility: z.enum(['private', 'tenant', 'public']).default('tenant'),
    }),
  }),
  route(async (req, res) => {
    const course = await CourseService.create({ tenantId: tenantOf(req), createdBy: req.user.id, ...req.body });
    res.status(201).set('Location', `/courses/${course.id}`);
    return course;
  }),
);

router.get(
  '/courses/:id',
  validate({ params: idParam }),
  route(async (req) => {
    const course = await CourseService.getForUser(req.params.id, req.user.id, tenantOf(req));
    if (!course) throw notFound('No such course');
    return course;
  }),
);

router.patch(
  '/courses/:id',
  requireRole(...TEACHERS),
  validate({
    params: idParam,
    body: z.object({
      title: z.string().min(1).max(200).optional(),
      summary: z.string().max(2000).optional(),
      coverAssetId: z.string().uuid().nullish(),
      visibility: z.enum(['private', 'tenant', 'public']).optional(),
    }),
  }),
  route(async (req) => CourseService.update(req.params.id, req.body, { actorId: req.user.id })),
);

router.delete(
  '/courses/:id',
  requireRole(...TEACHERS),
  validate({ params: idParam }),
  route(async (req) => {
    // Soft delete: enrolments, progress and certificates outlive the course page.
    await CourseService.archive(req.params.id, { actorId: req.user.id });
    return null;
  }),
);

/**
 * Publish a version. Validation first — a cyclic prerequisite graph or a live lesson with
 * no scheduled session is a 422, not a broken course discovered by a learner.
 */
router.post(
  '/courses/:id/publish',
  requireRole(...TEACHERS),
  validate({ params: idParam, body: z.object({ note: z.string().max(500).optional() }).default({}) }),
  route(async (req) => {
    const report = await CurriculumGraph.validateCourse(req.params.id);
    if (!report.ok) {
      throw Object.assign(new Error('Course cannot be published'), {
        status: 422,
        code: 'CURRICULUM_INVALID',
        details: report.problems,
        expose: true,
      });
    }
    return CourseService.publish(req.params.id, { actorId: req.user.id, note: req.body.note ?? null });
  }),
);

router.get(
  '/courses/:id/versions',
  requireRole(...TEACHERS),
  validate({ params: idParam }),
  route(async (req) => ({ versions: await CourseService.listVersions(req.params.id) })),
);

/* ------------------------------------------------------------------ *
 * Structure
 * ------------------------------------------------------------------ */

router.get(
  '/courses/:id/curriculum',
  validate({ params: idParam }),
  route(async (req) => {
    const curriculum = await CourseService.getCurriculum(req.params.id);
    // Unlock state is per learner, so it is resolved on read rather than stored.
    const unlocked = await PrerequisiteResolver.resolveFor(req.user.id, req.params.id);
    return { ...curriculum, unlocked };
  }),
);

router.post(
  '/courses/:id/modules',
  requireRole(...TEACHERS),
  validate({
    params: idParam,
    body: z.object({ title: z.string().min(1).max(200), position: z.number().int().min(0).optional() }),
  }),
  route(async (req, res) => {
    res.status(201);
    return CourseService.addModule(req.params.id, req.body, { actorId: req.user.id });
  }),
);

router.patch(
  '/modules/:id',
  requireRole(...TEACHERS),
  validate({
    params: idParam,
    body: z.object({ title: z.string().min(1).max(200).optional(), position: z.number().int().min(0).optional() }),
  }),
  route(async (req) => CourseService.updateModule(req.params.id, req.body, { actorId: req.user.id })),
);

router.delete(
  '/modules/:id',
  requireRole(...TEACHERS),
  validate({ params: idParam }),
  route(async (req) => {
    await CourseService.removeModule(req.params.id, { actorId: req.user.id });
    return null;
  }),
);

router.post(
  '/lessons',
  requireRole(...TEACHERS),
  validate({ body: lessonSchema }),
  route(async (req, res) => {
    res.status(201);
    return CourseService.addLesson(req.body, { actorId: req.user.id });
  }),
);

router.patch(
  '/lessons/:id',
  requireRole(...TEACHERS),
  validate({ params: idParam, body: lessonSchema.partial().omit({ moduleId: true }) }),
  route(async (req) => CourseService.updateLesson(req.params.id, req.body, { actorId: req.user.id })),
);

router.delete(
  '/lessons/:id',
  requireRole(...TEACHERS),
  validate({ params: idParam }),
  route(async (req) => {
    await CourseService.removeLesson(req.params.id, { actorId: req.user.id });
    return null;
  }),
);

/** Bulk reorder after a drag-and-drop, as one transaction — not N PATCHes that half-apply. */
router.put(
  '/courses/:id/order',
  requireRole(...TEACHERS),
  validate({
    params: idParam,
    body: z.object({
      modules: z.array(z.object({ id: z.string().uuid(), position: z.number().int().min(0) })).max(200),
      lessons: z
        .array(z.object({ id: z.string().uuid(), moduleId: z.string().uuid(), position: z.number().int().min(0) }))
        .max(2000),
    }),
  }),
  route(async (req) => CourseService.reorder(req.params.id, req.body, { actorId: req.user.id })),
);

/* ------------------------------------------------------------------ *
 * Learning paths (the DAG)
 * ------------------------------------------------------------------ */

router.put(
  '/paths/:id/edges',
  requireRole(...TEACHERS),
  validate({
    params: idParam,
    body: z.object({
      edges: z.array(z.object({ from: z.string().uuid(), to: z.string().uuid() })).max(2000),
    }),
  }),
  route(async (req) => {
    const result = await CurriculumGraph.setEdges(req.params.id, req.body.edges, { actorId: req.user.id });
    if (!result.ok) {
      throw Object.assign(new Error('Prerequisite graph is invalid'), {
        status: 422,
        code: 'GRAPH_INVALID',
        details: result.problems, // includes the cycle, so the editor can highlight it
        expose: true,
      });
    }
    return result.path;
  }),
);

/* ------------------------------------------------------------------ *
 * Enrolment and live sessions
 * ------------------------------------------------------------------ */

router.post(
  '/courses/:id/enrolments',
  validate({
    params: idParam,
    body: z.object({ userId: z.string().uuid().optional() }).default({}),
  }),
  route(async (req, res) => {
    // Enrolling someone else is a teacher action; enrolling yourself is not.
    const targetId = req.body.userId ?? req.user.id;
    if (targetId !== req.user.id && !TEACHERS.includes(req.user.role)) {
      throw Object.assign(new Error('Only a teacher can enrol another learner'), {
        status: 403,
        code: 'FORBIDDEN',
        expose: true,
      });
    }
    res.status(201);
    return CourseService.enrol({ courseId: req.params.id, userId: targetId, actorId: req.user.id });
  }),
);

router.delete(
  '/courses/:id/enrolments/:userId',
  requireRole(...TEACHERS),
  validate({ params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }) }),
  route(async (req) => {
    await CourseService.unenrol({ courseId: req.params.id, userId: req.params.userId, actorId: req.user.id });
    return null;
  }),
);

router.get(
  '/courses/:id/roster',
  requireRole(...TEACHERS),
  validate({ params: idParam, query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().optional() }) }),
  route(async (req) => CourseService.roster(req.params.id, paging(req))),
);

/** Upcoming live sessions for a course — the scheduling domain answers, this only routes. */
router.get(
  '/courses/:id/sessions',
  validate({ params: idParam }),
  route(async (req) => ({ sessions: await ScheduleService.listForCourse(req.params.id) })),
);

/** Open (or reopen) the classroom Room behind a live lesson. */
router.post(
  '/lessons/:id/live',
  requireRole(...TEACHERS),
  validate({ params: idParam, body: z.object({ sessionId: z.string().uuid().optional() }).default({}) }),
  route(async (req) =>
    LiveSessionLink.openRoom({
      lessonId: req.params.id,
      sessionId: req.body.sessionId ?? null,
      hostId: req.user.id,
      tenantId: tenantOf(req),
    }),
  ),
);

export default router;