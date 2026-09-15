/**
 * Curriculum  (F3)
 *
 * A course is a tree for authoring and a graph for learning:
 *
 *   Course → Module → Lesson          the tree the builder edits, ordered
 *   LearningPath                      a DAG over modules, which is what decides
 *                                     what a given learner may open next
 *
 * Lessons are a discriminated union on `type`, so a live lesson carries a room
 * and a schedule while a quiz carries questions, and neither has to pretend to
 * have the other's fields.
 *
 * Publishing is versioned. Learners always read a published version; the
 * builder always edits the draft. That separation is what makes it safe to
 * restructure a course while a cohort is halfway through it.
 */

import { z } from 'zod';
import {
  ActorRefSchema,
  DurationSecondsSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  MoneySchema,
  PaginationQuerySchema,
  SlugSchema,
  TimeZoneSchema,
  TimestampsSchema,
  UserIdSchema,
  VisibilitySchema,
  displayText,
  entityId,
  paginated,
  richText,
} from './common.schema.ts';
import { AssetIdSchema, AssetRefSchema } from './media.schema.ts';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const CourseIdSchema = entityId('CourseId');
export const ModuleIdSchema = entityId('ModuleId');
export const LessonIdSchema = entityId('LessonId');
export const PathIdSchema = entityId('PathId');
export const EnrollmentIdSchema = entityId('EnrollmentId');

export type CourseId = z.infer<typeof CourseIdSchema>;
export type ModuleId = z.infer<typeof ModuleIdSchema>;
export type LessonId = z.infer<typeof LessonIdSchema>;

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

export const LESSON_TYPES = ['live', 'video', 'doc', 'quiz', 'task'] as const;
export const LessonTypeSchema = z.enum(LESSON_TYPES);
export type LessonType = z.infer<typeof LessonTypeSchema>;

const LessonBaseSchema = z.object({
  lessonId: LessonIdSchema,
  moduleId: ModuleIdSchema,
  title: displayText(200),
  summary: richText(1000).nullable().default(null),
  /** Sparse ordering (100, 200, 300…) so a drag-and-drop reorder rewrites one row. */
  position: z.number().int(),
  /** Shown in the sidebar; authored, not measured. */
  estimatedMinutes: z.number().int().min(0).max(600).default(0),
  /** A preview lesson is readable before enrolment. */
  preview: z.boolean().default(false),
  /** Draft lessons are invisible to learners even in a published version. */
  draft: z.boolean().default(true),
});

export const LiveLessonSchema = LessonBaseSchema.extend({
  type: z.literal('live'),
  /** Assigned by LiveSessionLink.js when the session opens; null until then. */
  roomId: z.uuid().nullable().default(null),
  scheduledStart: IsoDateTimeSchema.nullable().default(null),
  scheduledEnd: IsoDateTimeSchema.nullable().default(null),
  timeZone: TimeZoneSchema.nullable().default(null),
  /** Recording of a past session, once the pipeline has finished. */
  recordingAssetId: AssetIdSchema.nullable().default(null),
  /** Cohort-independent open room, rather than a one-off session. */
  recurring: z.boolean().default(false),
});

export const VideoLessonSchema = LessonBaseSchema.extend({
  type: z.literal('video'),
  assetId: AssetIdSchema.nullable().default(null),
  asset: AssetRefSchema.nullable().default(null),
  /** Seconds watched before the lesson counts as complete. Null means 95%. */
  completionThresholdSec: DurationSecondsSchema.nullable().default(null),
  allowDownload: z.boolean().default(false),
});

export const DocLessonSchema = LessonBaseSchema.extend({
  type: z.literal('doc'),
  /** Markdown, sanitised server-side before it is stored. */
  body: richText(200_000).default(''),
  attachmentIds: z.array(AssetIdSchema).max(20).default([]),
});

export const QuizQuestionSchema = z.object({
  questionId: z.uuid(),
  prompt: richText(2000),
  kind: z.enum(['single', 'multiple', 'boolean', 'text']),
  options: z
    .array(z.object({ optionId: z.uuid(), label: richText(500) }))
    .max(10)
    .default([]),
  /** Stripped from the learner-facing payload; present only for the author. */
  correctOptionIds: z.array(z.uuid()).max(10).default([]),
  explanation: richText(2000).nullable().default(null),
  points: z.number().int().min(0).max(100).default(1),
});

export const QuizLessonSchema = LessonBaseSchema.extend({
  type: z.literal('quiz'),
  questions: z.array(QuizQuestionSchema).min(1).max(100),
  passPercent: z.number().int().min(0).max(100).default(70),
  maxAttempts: z.number().int().min(1).max(20).nullable().default(null),
  shuffle: z.boolean().default(false),
});

export const TaskLessonSchema = LessonBaseSchema.extend({
  type: z.literal('task'),
  /** The assignment that carries the rubric and the submissions (F4). */
  assignmentId: z.uuid().nullable().default(null),
  instructions: richText(20_000).default(''),
});

export const LessonSchema = z.discriminatedUnion('type', [
  LiveLessonSchema,
  VideoLessonSchema,
  DocLessonSchema,
  QuizLessonSchema,
  TaskLessonSchema,
]);
export type Lesson = z.infer<typeof LessonSchema>;

// ---------------------------------------------------------------------------
// Modules and course
// ---------------------------------------------------------------------------

export const ModuleSchema = z
  .object({
    moduleId: ModuleIdSchema,
    courseId: CourseIdSchema,
    title: displayText(200),
    summary: richText(1000).nullable().default(null),
    position: z.number().int(),
    lessons: z.array(LessonSchema).default([]),
    /** Resolved for the current learner by PrerequisiteResolver.js. */
    locked: z.boolean().default(false),
    lockedReason: z.string().max(200).nullable().default(null),
  })
  .merge(TimestampsSchema);
export type Module = z.infer<typeof ModuleSchema>;

export const COURSE_STATUSES = ['draft', 'published', 'archived'] as const;
export const CourseStatusSchema = z.enum(COURSE_STATUSES);
export type CourseStatus = z.infer<typeof CourseStatusSchema>;

export const CourseSchema = z
  .object({
    courseId: CourseIdSchema,
    slug: SlugSchema,
    title: displayText(200),
    subtitle: displayText(300).nullable().default(null),
    description: richText(20_000).default(''),
    language: LocaleSchema,
    visibility: VisibilitySchema.default('members'),
    status: CourseStatusSchema.default('draft'),

    coverAssetId: AssetIdSchema.nullable().default(null),
    coverUrl: z.string().url().nullable().default(null),

    owner: ActorRefSchema,
    instructors: z.array(ActorRefSchema).max(20).default([]),

    /** Null means the course is included with the plan rather than sold. */
    price: MoneySchema.nullable().default(null),

    /** Monotonic. A learner reads a version; the builder edits the draft. */
    version: z.number().int().positive().default(1),
    publishedAt: IsoDateTimeSchema.nullable().default(null),
    publishedVersion: z.number().int().positive().nullable().default(null),

    /** Auto-provisioned by SpaceService on publish (F2). */
    spaceId: z.uuid().nullable().default(null),

    moduleCount: z.number().int().nonnegative().default(0),
    lessonCount: z.number().int().nonnegative().default(0),
    estimatedMinutes: z.number().int().nonnegative().default(0),
    enrollmentCount: z.number().int().nonnegative().default(0),
  })
  .merge(TimestampsSchema);
export type Course = z.infer<typeof CourseSchema>;

/** The full tree the builder and the viewer both load. */
export const CourseDetailSchema = CourseSchema.extend({
  modules: z.array(ModuleSchema).default([]),
  path: z.lazy(() => LearningPathSchema).nullable().default(null),
});
export type CourseDetail = z.infer<typeof CourseDetailSchema>;

// ---------------------------------------------------------------------------
// Learning path — the DAG
// ---------------------------------------------------------------------------

/**
 * `from` must be completed before `to` unlocks. CurriculumGraph.js rejects any
 * edge that would introduce a cycle, which is the one invariant that keeps a
 * course from becoming unfinishable.
 */
export const PathEdgeSchema = z.object({
  from: ModuleIdSchema,
  to: ModuleIdSchema,
  /** 'complete' needs the module finished; 'pass' needs its quizzes passed. */
  requirement: z.enum(['complete', 'pass']).default('complete'),
});

export const LearningPathSchema = z
  .object({
    pathId: PathIdSchema,
    courseId: CourseIdSchema,
    edges: z.array(PathEdgeSchema).max(500).default([]),
    /** Modules with no incoming edge; the places a learner may start. */
    entryModuleIds: z.array(ModuleIdSchema).default([]),
  })
  .merge(TimestampsSchema);
export type LearningPath = z.infer<typeof LearningPathSchema>;

// ---------------------------------------------------------------------------
// Enrolment and progress
// ---------------------------------------------------------------------------

export const ENROLLMENT_STATUSES = ['active', 'completed', 'expired', 'cancelled'] as const;
export const EnrollmentStatusSchema = z.enum(ENROLLMENT_STATUSES);

export const EnrollmentSchema = z
  .object({
    enrollmentId: EnrollmentIdSchema,
    courseId: CourseIdSchema,
    userId: UserIdSchema,
    status: EnrollmentStatusSchema.default('active'),
    /** The version the learner is on; a republish does not move them silently. */
    courseVersion: z.number().int().positive(),
    source: z.enum(['self', 'invite', 'purchase', 'admin']).default('self'),
    startedAt: IsoDateTimeSchema.nullable().default(null),
    completedAt: IsoDateTimeSchema.nullable().default(null),
    expiresAt: IsoDateTimeSchema.nullable().default(null),
  })
  .merge(TimestampsSchema);
export type Enrollment = z.infer<typeof EnrollmentSchema>;

export const LessonProgressSchema = z.object({
  lessonId: LessonIdSchema,
  status: z.enum(['not-started', 'in-progress', 'completed']).default('not-started'),
  /** Where playback resumes, in seconds. Video lessons only. */
  positionSec: DurationSecondsSchema.default(0),
  /** Quiz score as a percentage, once attempted. */
  scorePercent: z.number().min(0).max(100).nullable().default(null),
  attempts: z.number().int().nonnegative().default(0),
  completedAt: IsoDateTimeSchema.nullable().default(null),
  updatedAt: IsoDateTimeSchema,
});
export type LessonProgress = z.infer<typeof LessonProgressSchema>;

export const CourseProgressSchema = z.object({
  courseId: CourseIdSchema,
  userId: UserIdSchema,
  completedLessons: z.number().int().nonnegative(),
  totalLessons: z.number().int().nonnegative(),
  percent: z.number().min(0).max(100),
  /** What the Continue button opens. */
  nextLessonId: LessonIdSchema.nullable().default(null),
  lastActivityAt: IsoDateTimeSchema.nullable().default(null),
  lessons: z.array(LessonProgressSchema).default([]),
});
export type CourseProgress = z.infer<typeof CourseProgressSchema>;

export const CertificateSchema = z.object({
  certificateId: z.uuid(),
  courseId: CourseIdSchema,
  userId: UserIdSchema,
  /** Public verification code printed on the PDF. */
  serial: z.string().min(8).max(32),
  issuedAt: IsoDateTimeSchema,
  assetId: AssetIdSchema,
  downloadUrl: z.string().url().nullable().default(null),
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const CreateCourseSchema = z.strictObject({
  title: displayText(200),
  slug: SlugSchema.optional(),
  subtitle: displayText(300).optional(),
  description: richText(20_000).optional(),
  language: LocaleSchema.optional(),
  visibility: VisibilitySchema.optional(),
});

export const UpdateCourseSchema = CreateCourseSchema.partial()
  .extend({
    coverAssetId: AssetIdSchema.nullable().optional(),
    price: MoneySchema.nullable().optional(),
    instructorIds: z.array(UserIdSchema).max(20).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { error: 'nothing to update' });

export const CreateModuleSchema = z.strictObject({
  title: displayText(200),
  summary: richText(1000).optional(),
  /** Appended to the end when omitted. */
  position: z.number().int().optional(),
});

/**
 * Lesson creation mirrors the union: the payload is the lesson minus the fields
 * the server owns, so a quiz cannot be created without questions.
 */
export const CreateLessonSchema = z.discriminatedUnion('type', [
  LiveLessonSchema.omit({ lessonId: true, moduleId: true, roomId: true, recordingAssetId: true })
    .partial({ position: true })
    .extend({ type: z.literal('live') }),
  VideoLessonSchema.omit({ lessonId: true, moduleId: true, asset: true })
    .partial({ position: true })
    .extend({ type: z.literal('video') }),
  DocLessonSchema.omit({ lessonId: true, moduleId: true })
    .partial({ position: true })
    .extend({ type: z.literal('doc') }),
  QuizLessonSchema.omit({ lessonId: true, moduleId: true })
    .partial({ position: true })
    .extend({ type: z.literal('quiz') }),
  TaskLessonSchema.omit({ lessonId: true, moduleId: true })
    .partial({ position: true })
    .extend({ type: z.literal('task') }),
]);

/** Drag-and-drop result: the whole new order, not a diff. */
export const ReorderSchema = z.strictObject({
  /** Ids in their new order; the server rewrites positions in one statement. */
  orderedIds: z.array(z.uuid()).min(1).max(500),
  /** Present when a lesson moved between modules. */
  targetModuleId: ModuleIdSchema.optional(),
});

export const UpdatePathSchema = z.strictObject({
  edges: z.array(PathEdgeSchema).max(500),
});

export const PublishCourseSchema = z.strictObject({
  /** Publishes despite non-blocking warnings (empty modules, missing cover). */
  force: z.boolean().default(false),
  changelog: richText(2000).optional(),
});

export const PublishValidationSchema = z.object({
  publishable: z.boolean(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).default([]),
  warnings: z.array(z.object({ path: z.string(), message: z.string() })).default([]),
});

export const EnrollSchema = z.strictObject({
  /** Admins may enrol someone else; learners may only enrol themselves. */
  userId: UserIdSchema.optional(),
});

export const UpdateLessonProgressSchema = z.strictObject({
  status: z.enum(['in-progress', 'completed']).optional(),
  positionSec: DurationSecondsSchema.optional(),
});

export const SubmitQuizSchema = z.strictObject({
  answers: z
    .array(
      z.object({
        questionId: z.uuid(),
        optionIds: z.array(z.uuid()).max(10).default([]),
        text: richText(5000).optional(),
      }),
    )
    .min(1),
});

export const QuizResultSchema = z.object({
  scorePercent: z.number().min(0).max(100),
  passed: z.boolean(),
  attempt: z.number().int().positive(),
  /** Per-question feedback, withheld until the attempt limit is reached. */
  feedback: z
    .array(
      z.object({
        questionId: z.uuid(),
        correct: z.boolean(),
        explanation: z.string().nullable(),
      }),
    )
    .default([]),
});

export const ListCoursesQuerySchema = PaginationQuerySchema.extend({
  status: CourseStatusSchema.optional(),
  q: z.string().trim().max(128).optional(),
  instructorId: UserIdSchema.optional(),
  /** Only courses the caller is enrolled in. */
  enrolled: z.boolean().optional(),
});

export const CourseListSchema = paginated(CourseSchema);
export const EnrollmentListSchema = paginated(EnrollmentSchema);

// ---------------------------------------------------------------------------
// Inferred request and response types
// ---------------------------------------------------------------------------

export type CreateCourse = z.infer<typeof CreateCourseSchema>;
export type UpdateCourse = z.infer<typeof UpdateCourseSchema>;
export type CreateModule = z.infer<typeof CreateModuleSchema>;
export type CreateLesson = z.infer<typeof CreateLessonSchema>;
export type Reorder = z.infer<typeof ReorderSchema>;
export type UpdatePath = z.infer<typeof UpdatePathSchema>;
export type PublishCourse = z.infer<typeof PublishCourseSchema>;
export type PublishValidation = z.infer<typeof PublishValidationSchema>;
export type EnrollInput = z.infer<typeof EnrollSchema>;
export type UpdateLessonProgress = z.infer<typeof UpdateLessonProgressSchema>;
export type SubmitQuiz = z.infer<typeof SubmitQuizSchema>;
export type QuizResult = z.infer<typeof QuizResultSchema>;
export type Certificate = z.infer<typeof CertificateSchema>;
export type ListCoursesQuery = z.infer<typeof ListCoursesQuerySchema>;
export type PathEdge = z.infer<typeof PathEdgeSchema>;
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;