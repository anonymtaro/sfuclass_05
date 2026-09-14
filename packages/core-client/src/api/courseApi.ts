/**
 * Course API  (F3)
 *
 * Covers authoring and reading. Progress is deliberately not here — it belongs
 * to the learner rather than to the curriculum, changes far more often, and has
 * its own file.
 *
 * Two conventions the builder depends on:
 *
 *   Reordering sends the whole new order, not a diff. A drag-and-drop produces
 *   one array; the server rewrites sparse positions in a single statement. A
 *   diff would need conflict resolution that nobody wants to write.
 *
 *   Publishing is validated separately from publishing. `validatePublish()`
 *   returns blocking errors and non-blocking warnings so the dialog can show
 *   both before anything is committed.
 */

import { Course } from '@classroom/contracts';
import type { z } from 'zod';
import type { HttpClient } from '../http/httpClient.js';

type ListQuery = Partial<z.infer<typeof Course.ListCoursesQuerySchema>>;

export interface CourseApi {
  list(query?: ListQuery, signal?: AbortSignal): Promise<z.infer<typeof Course.CourseListSchema>>;
  get(courseId: string, signal?: AbortSignal): Promise<z.infer<typeof Course.CourseDetailSchema>>;
  getBySlug(slug: string, signal?: AbortSignal): Promise<z.infer<typeof Course.CourseDetailSchema>>;
  create(input: z.infer<typeof Course.CreateCourseSchema>): Promise<z.infer<typeof Course.CourseSchema>>;
  update(
    courseId: string,
    input: z.infer<typeof Course.UpdateCourseSchema>,
  ): Promise<z.infer<typeof Course.CourseSchema>>;
  remove(courseId: string): Promise<void>;

  createModule(
    courseId: string,
    input: z.infer<typeof Course.CreateModuleSchema>,
  ): Promise<z.infer<typeof Course.ModuleSchema>>;
  updateModule(
    moduleId: string,
    input: Partial<z.infer<typeof Course.CreateModuleSchema>>,
  ): Promise<z.infer<typeof Course.ModuleSchema>>;
  deleteModule(moduleId: string): Promise<void>;
  reorderModules(courseId: string, orderedIds: string[]): Promise<void>;

  createLesson(
    moduleId: string,
    input: z.infer<typeof Course.CreateLessonSchema>,
  ): Promise<z.infer<typeof Course.LessonSchema>>;
  updateLesson(
    lessonId: string,
    input: Record<string, unknown>,
  ): Promise<z.infer<typeof Course.LessonSchema>>;
  deleteLesson(lessonId: string): Promise<void>;
  /** `targetModuleId` moves the lesson between modules in the same call. */
  reorderLessons(moduleId: string, orderedIds: string[], targetModuleId?: string): Promise<void>;

  getPath(courseId: string, signal?: AbortSignal): Promise<z.infer<typeof Course.LearningPathSchema>>;
  updatePath(
    courseId: string,
    edges: z.infer<typeof Course.UpdatePathSchema>['edges'],
  ): Promise<z.infer<typeof Course.LearningPathSchema>>;

  validatePublish(
    courseId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Course.PublishValidationSchema>>;
  publish(
    courseId: string,
    input?: z.infer<typeof Course.PublishCourseSchema>,
  ): Promise<z.infer<typeof Course.CourseSchema>>;
  unpublish(courseId: string): Promise<z.infer<typeof Course.CourseSchema>>;

  enroll(
    courseId: string,
    input?: z.infer<typeof Course.EnrollSchema>,
  ): Promise<z.infer<typeof Course.EnrollmentSchema>>;
  unenroll(courseId: string, userId?: string): Promise<void>;
  listEnrollments(
    courseId: string,
    query?: { cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Course.EnrollmentListSchema>>;
  listMyEnrollments(signal?: AbortSignal): Promise<z.infer<typeof Course.EnrollmentListSchema>>;
}

export const createCourseApi = (http: HttpClient): CourseApi => ({
  list: (query = {}, signal) =>
    http.get('/courses', {
      schema: Course.CourseListSchema,
      query: {
        cursor: query.cursor,
        limit: query.limit,
        order: query.order,
        status: query.status,
        q: query.q,
        instructorId: query.instructorId,
        enrolled: query.enrolled,
      },
      signal,
    }),

  get: (courseId, signal) =>
    http.get(`/courses/${encodeURIComponent(courseId)}`, {
      schema: Course.CourseDetailSchema,
      signal,
    }),

  /** Public course pages are addressed by slug, not id. */
  getBySlug: (slug, signal) =>
    http.get(`/courses/by-slug/${encodeURIComponent(slug)}`, {
      schema: Course.CourseDetailSchema,
      signal,
    }),

  create: (input) => http.post('/courses', input, { schema: Course.CourseSchema }),

  update: (courseId, input) =>
    http.patch(`/courses/${encodeURIComponent(courseId)}`, input, {
      schema: Course.CourseSchema,
    }),

  remove: async (courseId) => {
    await http.delete(`/courses/${encodeURIComponent(courseId)}`);
  },

  createModule: (courseId, input) =>
    http.post(`/courses/${encodeURIComponent(courseId)}/modules`, input, {
      schema: Course.ModuleSchema,
    }),

  updateModule: (moduleId, input) =>
    http.patch(`/modules/${encodeURIComponent(moduleId)}`, input, {
      schema: Course.ModuleSchema,
    }),

  deleteModule: async (moduleId) => {
    await http.delete(`/modules/${encodeURIComponent(moduleId)}`);
  },

  reorderModules: async (courseId, orderedIds) => {
    await http.post(`/courses/${encodeURIComponent(courseId)}/modules/reorder`, { orderedIds });
  },

  createLesson: (moduleId, input) =>
    http.post(`/modules/${encodeURIComponent(moduleId)}/lessons`, input, {
      schema: Course.LessonSchema,
    }),

  /**
   * The payload shape depends on the lesson type, and the type cannot change
   * after creation, so the server picks the right variant. Typing this as a
   * partial union here would be less honest than it looks.
   */
  updateLesson: (lessonId, input) =>
    http.patch(`/lessons/${encodeURIComponent(lessonId)}`, input, {
      schema: Course.LessonSchema,
    }),

  deleteLesson: async (lessonId) => {
    await http.delete(`/lessons/${encodeURIComponent(lessonId)}`);
  },

  reorderLessons: async (moduleId, orderedIds, targetModuleId) => {
    await http.post(`/modules/${encodeURIComponent(moduleId)}/lessons/reorder`, {
      orderedIds,
      targetModuleId,
    });
  },

  getPath: (courseId, signal) =>
    http.get(`/courses/${encodeURIComponent(courseId)}/path`, {
      schema: Course.LearningPathSchema,
      signal,
    }),

  /** Rejected with `curriculum_cycle` if the edges would break the DAG. */
  updatePath: (courseId, edges) =>
    http.put(
      `/courses/${encodeURIComponent(courseId)}/path`,
      { edges },
      { schema: Course.LearningPathSchema },
    ),

  validatePublish: (courseId, signal) =>
    http.get(`/courses/${encodeURIComponent(courseId)}/publish/validate`, {
      schema: Course.PublishValidationSchema,
      signal,
    }),

  publish: (courseId, input = { force: false }) =>
    http.post(`/courses/${encodeURIComponent(courseId)}/publish`, input, {
      schema: Course.CourseSchema,
    }),

  /** Existing learners keep the version they are on; only new enrolment stops. */
  unpublish: (courseId) =>
    http.post(`/courses/${encodeURIComponent(courseId)}/unpublish`, undefined, {
      schema: Course.CourseSchema,
    }),

  enroll: (courseId, input = {}) =>
    http.post(`/courses/${encodeURIComponent(courseId)}/enroll`, input, {
      schema: Course.EnrollmentSchema,
    }),

  unenroll: async (courseId, userId) => {
    await http.delete(`/courses/${encodeURIComponent(courseId)}/enroll`, {
      query: { userId },
    });
  },

  listEnrollments: (courseId, query = {}, signal) =>
    http.get(`/courses/${encodeURIComponent(courseId)}/enrollments`, {
      schema: Course.EnrollmentListSchema,
      query: { cursor: query.cursor, limit: query.limit },
      signal,
    }),

  listMyEnrollments: (signal) =>
    http.get('/enrollments', { schema: Course.EnrollmentListSchema, signal }),
});