/**
 * useCourse  (F3)
 *
 * Serves both readers and authors, because they look at the same tree and the
 * builder needs to see exactly what a learner will see.
 *
 * The interesting behaviour is reordering. A drag-and-drop must feel
 * instantaneous, so the tree is reordered locally first and the request goes
 * out behind it. If the request fails the previous order is restored — which is
 * why `reorderModules` snapshots before it mutates rather than trying to invert
 * the operation afterwards.
 *
 * Publishing is two calls on purpose: `validate()` reports blocking errors and
 * non-blocking warnings so the dialog can show both, and `publish()` commits.
 * A single call that silently decided for the author would be faster and worse.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type Course } from '@classroom/contracts';
import type { CourseApi } from '../api/courseApi.js';

export interface UseCourseOptions {
  api: CourseApi;
  courseId: string | null;
  /** Skip the initial fetch; used when a parent already has the detail. */
  initial?: Course.CourseDetail;
}

export interface UseCourseResult {
  course: Course.CourseDetail | null;
  loading: boolean;
  saving: boolean;
  error: ApiError | null;
  validation: Course.PublishValidation | null;

  refresh(): Promise<void>;
  update(input: Course.UpdateCourse): Promise<void>;

  addModule(title: string): Promise<void>;
  renameModule(moduleId: string, title: string): Promise<void>;
  removeModule(moduleId: string): Promise<void>;
  reorderModules(orderedIds: string[]): Promise<void>;

  addLesson(moduleId: string, input: Course.CreateLesson): Promise<void>;
  updateLesson(lessonId: string, input: Record<string, unknown>): Promise<void>;
  removeLesson(moduleId: string, lessonId: string): Promise<void>;
  reorderLessons(moduleId: string, orderedIds: string[], targetModuleId?: string): Promise<void>;

  validate(): Promise<Course.PublishValidation>;
  publish(force?: boolean): Promise<void>;

  /** Flat lesson list in curriculum order, for players and progress bars. */
  lessons: Course.Lesson[];
}

export const useCourse = (options: UseCourseOptions): UseCourseResult => {
  const { api, courseId } = options;

  const [course, setCourse] = useState<Course.CourseDetail | null>(options.initial ?? null);
  const [loading, setLoading] = useState(!options.initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [validation, setValidation] = useState<Course.PublishValidation | null>(null);

  /** Snapshot for rolling back an optimistic reorder. */
  const rollback = useRef<Course.CourseDetail | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!courseId) return;
      setLoading(true);
      try {
        setCourse(await api.get(courseId, signal));
        setError(null);
      } catch (cause) {
        if (!signal?.aborted) setError(ApiError.is(cause) ? cause : null);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [api, courseId],
  );

  useEffect(() => {
    if (options.initial) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, options.initial]);

  /** Wraps a mutation: flag saving, refetch on success, surface ApiErrors. */
  const mutate = useCallback(
    async (fn: () => Promise<void>, refetch = true) => {
      setSaving(true);
      setError(null);
      try {
        await fn();
        if (refetch) await load();
      } catch (cause) {
        setError(ApiError.is(cause) ? cause : null);
        throw cause;
      } finally {
        setSaving(false);
      }
    },
    [load],
  );

  const reorderModules = useCallback(
    async (orderedIds: string[]) => {
      if (!course || !courseId) return;
      rollback.current = course;

      // Local first: the drag has already happened visually.
      const byId = new Map(course.modules.map((m) => [m.moduleId as string, m]));
      const reordered = orderedIds
        .map((id) => byId.get(id))
        .filter((m): m is Course.Module => Boolean(m));
      setCourse({ ...course, modules: reordered });

      try {
        await api.reorderModules(courseId, orderedIds);
      } catch (cause) {
        setCourse(rollback.current);
        setError(ApiError.is(cause) ? cause : null);
      }
    },
    [api, course, courseId],
  );

  const reorderLessons = useCallback(
    async (moduleId: string, orderedIds: string[], targetModuleId?: string) => {
      if (!course) return;
      rollback.current = course;

      // A cross-module move rearranges two lists, so a refetch is cheaper to
      // reason about than a local splice. Same-module stays optimistic.
      if (!targetModuleId) {
        const module = course.modules.find((m) => m.moduleId === moduleId);
        if (module) {
          const byId = new Map(module.lessons.map((l) => [l.lessonId as string, l]));
          const lessons = orderedIds
            .map((id) => byId.get(id))
            .filter((l): l is Course.Lesson => Boolean(l));
          setCourse({
            ...course,
            modules: course.modules.map((m) =>
              m.moduleId === moduleId ? { ...m, lessons } : m,
            ),
          });
        }
      }

      try {
        await api.reorderLessons(moduleId, orderedIds, targetModuleId);
        if (targetModuleId) await load();
      } catch (cause) {
        setCourse(rollback.current);
        setError(ApiError.is(cause) ? cause : null);
      }
    },
    [api, course, load],
  );

  const lessons = useMemo(
    () => course?.modules.flatMap((module) => module.lessons) ?? [],
    [course],
  );

  return {
    course,
    loading,
    saving,
    error,
    validation,
    lessons,

    refresh: () => load(),

    update: (input) =>
      mutate(async () => {
        if (courseId) await api.update(courseId, input);
      }),

    addModule: (title) =>
      mutate(async () => {
        if (courseId) await api.createModule(courseId, { title });
      }),

    renameModule: (moduleId, title) =>
      mutate(async () => {
        await api.updateModule(moduleId, { title });
      }),

    removeModule: (moduleId) =>
      mutate(async () => {
        await api.deleteModule(moduleId);
      }),

    reorderModules,

    addLesson: (moduleId, input) =>
      mutate(async () => {
        await api.createLesson(moduleId, input);
      }),

    updateLesson: (lessonId, input) =>
      mutate(async () => {
        await api.updateLesson(lessonId, input);
      }),

    removeLesson: (_moduleId, lessonId) =>
      mutate(async () => {
        await api.deleteLesson(lessonId);
      }),

    reorderLessons,

    validate: async () => {
      if (!courseId) throw new ApiError('not_found', { detail: 'No course selected' });
      const result = await api.validatePublish(courseId);
      setValidation(result);
      return result;
    },

    /**
     * `force` publishes despite warnings, never despite errors — the server
     * rejects those regardless of what the client asks for.
     */
    publish: (force = false) =>
      mutate(async () => {
        if (courseId) await api.publish(courseId, { force });
      }),
  };
};