/**
 * Progress API  (F3)
 *
 * Separate from courseApi because the two have opposite shapes. A course is
 * read often and written rarely, by an author. Progress is written constantly,
 * by every learner, and read mostly as a summary.
 *
 * The important call is `reportPosition()`. A video lesson reports where
 * playback is every few seconds, which is by far the highest-frequency mutation
 * in the product. Three consequences:
 *
 *   - it is fire-and-forget: a lost position report costs a few seconds of
 *     resume accuracy, so it must never block playback or surface an error
 *   - it is throttled by the caller (LessonPlayer), not here
 *   - it never retries; the next tick supersedes it anyway
 */

import { Course } from '@classroom/contracts';
import type { z } from 'zod';
import type { HttpClient } from '../http/httpClient.js';

export interface ProgressApi {
  getCourseProgress(
    courseId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Course.CourseProgressSchema>>;
  getLessonProgress(
    lessonId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Course.LessonProgressSchema>>;

  /** Explicit state change: started, or finished. Retried like any mutation. */
  update(
    lessonId: string,
    input: z.infer<typeof Course.UpdateLessonProgressSchema>,
  ): Promise<z.infer<typeof Course.LessonProgressSchema>>;
  complete(lessonId: string): Promise<z.infer<typeof Course.LessonProgressSchema>>;

  /** High-frequency, best-effort. Never throws. */
  reportPosition(lessonId: string, positionSec: number): void;

  submitQuiz(
    lessonId: string,
    input: z.infer<typeof Course.SubmitQuizSchema>,
  ): Promise<z.infer<typeof Course.QuizResultSchema>>;

  listCertificates(signal?: AbortSignal): Promise<{
    items: z.infer<typeof Course.CertificateSchema>[];
  }>;
  getCertificate(
    certificateId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Course.CertificateSchema>>;
}

const CertificateListSchema = Course.CertificateSchema.array().transform((items) => ({ items }));

export const createProgressApi = (http: HttpClient): ProgressApi => ({
  getCourseProgress: (courseId, signal) =>
    http.get(`/progress/courses/${encodeURIComponent(courseId)}`, {
      schema: Course.CourseProgressSchema,
      signal,
    }),

  getLessonProgress: (lessonId, signal) =>
    http.get(`/progress/lessons/${encodeURIComponent(lessonId)}`, {
      schema: Course.LessonProgressSchema,
      signal,
    }),

  update: (lessonId, input) =>
    http.patch(`/progress/lessons/${encodeURIComponent(lessonId)}`, input, {
      schema: Course.LessonProgressSchema,
    }),

  complete: (lessonId) =>
    http.patch(
      `/progress/lessons/${encodeURIComponent(lessonId)}`,
      { status: 'completed' },
      { schema: Course.LessonProgressSchema },
    ),

  /**
   * Deliberately not async and deliberately swallowing failures. A player that
   * pauses because a heartbeat 500'd would be a worse product than one that
   * occasionally resumes ten seconds early.
   */
  reportPosition: (lessonId, positionSec) => {
    void http
      .patch(
        `/progress/lessons/${encodeURIComponent(lessonId)}`,
        { positionSec: Math.floor(positionSec) },
        { retry: { attempts: 1 }, timeoutMs: 5_000 },
      )
      .catch(() => undefined);
  },

  submitQuiz: (lessonId, input) =>
    http.post(`/progress/lessons/${encodeURIComponent(lessonId)}/quiz`, input, {
      schema: Course.QuizResultSchema,
    }),

  listCertificates: (signal) =>
    http.get('/progress/certificates', { schema: CertificateListSchema, signal }),

  getCertificate: (certificateId, signal) =>
    http.get(`/progress/certificates/${encodeURIComponent(certificateId)}`, {
      schema: Course.CertificateSchema,
      signal,
    }),
});