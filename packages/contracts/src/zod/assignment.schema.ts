/**
 * Assignments  (F4, depends on media/)
 *
 *   Assignment → Submission → Grade
 *
 * An assignment belongs to a task lesson. A learner submits files or text, a
 * teacher grades against a rubric, and the result rolls up into a gradebook.
 *
 * Two rules shape the schema:
 *
 *   1. A submission is immutable once graded. Resubmission creates a new
 *      attempt rather than editing the old one, so feedback always refers to
 *      something that still exists exactly as it was read.
 *   2. Files are ordinary media assets. Nothing here defines a second upload
 *      path; a submission references assetIds that are already `ready`.
 */

import { z } from 'zod';
import {
  ActorRefSchema,
  IsoDateTimeSchema,
  PaginationQuerySchema,
  TimestampsSchema,
  UserIdSchema,
  displayText,
  entityId,
  paginated,
  richText,
} from './common.schema.js';
import { AssetIdSchema, AssetRefSchema } from './media.schema.js';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const AssignmentIdSchema = entityId('AssignmentId');
export const SubmissionIdSchema = entityId('SubmissionId');
export const RubricCriterionIdSchema = entityId('RubricCriterionId');

export type AssignmentId = z.infer<typeof AssignmentIdSchema>;
export type SubmissionId = z.infer<typeof SubmissionIdSchema>;

// ---------------------------------------------------------------------------
// Rubric
// ---------------------------------------------------------------------------

export const RubricLevelSchema = z.object({
  label: displayText(60),
  points: z.number().min(0).max(1000),
  description: richText(1000).nullable().default(null),
});

export const RubricCriterionSchema = z.object({
  criterionId: RubricCriterionIdSchema,
  title: displayText(120),
  description: richText(2000).nullable().default(null),
  maxPoints: z.number().min(0).max(1000),
  /** Optional descriptive bands. Without them the criterion is free-scored. */
  levels: z.array(RubricLevelSchema).max(6).default([]),
});
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export const RubricSchema = z
  .object({
    criteria: z.array(RubricCriterionSchema).min(1).max(20),
    /** Sum of maxPoints. Denormalised so a client never has to add it up. */
    totalPoints: z.number().min(0),
  })
  .refine(
    (r) => Math.abs(r.criteria.reduce((sum, c) => sum + c.maxPoints, 0) - r.totalPoints) < 0.001,
    { error: 'totalPoints must equal the sum of the criteria', path: ['totalPoints'] },
  );
export type Rubric = z.infer<typeof RubricSchema>;

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export const SUBMISSION_KINDS = ['file', 'text', 'link', 'any'] as const;
export const SubmissionKindSchema = z.enum(SUBMISSION_KINDS);

/**
 * What happens to a late submission.
 *   blocked   the submit button stops working at the deadline
 *   accepted  allowed, flagged late, graded normally
 *   penalised allowed, flagged, `latePenaltyPercent` deducted
 */
export const LATE_POLICIES = ['blocked', 'accepted', 'penalised'] as const;
export const LatePolicySchema = z.enum(LATE_POLICIES);

export const AssignmentSchema = z
  .object({
    assignmentId: AssignmentIdSchema,
    courseId: z.uuid(),
    lessonId: z.uuid().nullable().default(null),
    title: displayText(200),
    instructions: richText(20_000).default(''),
    briefAssetIds: z.array(AssetIdSchema).max(10).default([]),

    submissionKind: SubmissionKindSchema.default('any'),
    maxAttempts: z.number().int().min(1).max(20).default(1),
    maxFiles: z.number().int().min(0).max(20).default(5),
    /** Empty means any type the platform accepts. Extensions, without the dot. */
    allowedExtensions: z.array(z.string().max(16)).max(30).default([]),

    dueAt: IsoDateTimeSchema.nullable().default(null),
    latePolicy: LatePolicySchema.default('accepted'),
    latePenaltyPercent: z.number().min(0).max(100).default(0),

    rubric: RubricSchema.nullable().default(null),
    /** Used when there is no rubric. */
    maxPoints: z.number().min(0).max(1000).default(100),
    passPercent: z.number().min(0).max(100).default(50),

    /** Learners see each other's submissions after they have submitted. */
    peerVisible: z.boolean().default(false),
    /** Grades stay hidden until the teacher releases them all at once. */
    releaseGradesManually: z.boolean().default(false),

    published: z.boolean().default(false),
    submissionCount: z.number().int().nonnegative().default(0),
    gradedCount: z.number().int().nonnegative().default(0),
  })
  .merge(TimestampsSchema);
export type Assignment = z.infer<typeof AssignmentSchema>;

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 *   draft      saved, not handed in; the learner may still change it
 *   submitted  handed in, waiting for a grade
 *   returned   graded and released to the learner
 *   resubmit   the teacher asked for another attempt
 */
export const SUBMISSION_STATUSES = ['draft', 'submitted', 'returned', 'resubmit'] as const;
export const SubmissionStatusSchema = z.enum(SUBMISSION_STATUSES);
export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>;

export const SubmissionSchema = z
  .object({
    submissionId: SubmissionIdSchema,
    assignmentId: AssignmentIdSchema,
    learner: ActorRefSchema,
    attempt: z.number().int().positive().default(1),
    status: SubmissionStatusSchema.default('draft'),

    text: richText(50_000).nullable().default(null),
    links: z.array(z.string().url().max(2048)).max(10).default([]),
    files: z.array(AssetRefSchema).max(20).default([]),

    submittedAt: IsoDateTimeSchema.nullable().default(null),
    late: z.boolean().default(false),
    /** Set once submitted; a locked submission is read-only for the learner. */
    lockedAt: IsoDateTimeSchema.nullable().default(null),

    grade: z.lazy(() => GradeSchema).nullable().default(null),
  })
  .merge(TimestampsSchema);
export type Submission = z.infer<typeof SubmissionSchema>;

// ---------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------

export const CriterionScoreSchema = z.object({
  criterionId: RubricCriterionIdSchema,
  points: z.number().min(0).max(1000),
  comment: richText(2000).nullable().default(null),
});

export const GradeSchema = z
  .object({
    submissionId: SubmissionIdSchema,
    grader: ActorRefSchema,
    /** After any late penalty. `rawPoints` keeps the number before it. */
    points: z.number().min(0).max(1000),
    rawPoints: z.number().min(0).max(1000),
    maxPoints: z.number().min(0).max(1000),
    percent: z.number().min(0).max(100),
    passed: z.boolean(),
    criteria: z.array(CriterionScoreSchema).default([]),
    feedback: richText(20_000).nullable().default(null),
    /** Audio or annotated-file feedback. */
    feedbackAssetIds: z.array(AssetIdSchema).max(10).default([]),
    /** Null while the teacher is still grading the cohort. */
    releasedAt: IsoDateTimeSchema.nullable().default(null),
    gradedAt: IsoDateTimeSchema,
  })
  .describe('The result of grading one submission attempt.');
export type Grade = z.infer<typeof GradeSchema>;

// ---------------------------------------------------------------------------
// Gradebook
// ---------------------------------------------------------------------------

export const GradebookEntrySchema = z.object({
  learner: ActorRefSchema,
  assignmentId: AssignmentIdSchema,
  status: SubmissionStatusSchema.nullable(),
  submissionId: SubmissionIdSchema.nullable(),
  attempt: z.number().int().nonnegative().default(0),
  percent: z.number().min(0).max(100).nullable().default(null),
  late: z.boolean().default(false),
  submittedAt: IsoDateTimeSchema.nullable().default(null),
  gradedAt: IsoDateTimeSchema.nullable().default(null),
});

export const GradebookSchema = z.object({
  courseId: z.uuid(),
  assignments: z
    .array(
      z.object({
        assignmentId: AssignmentIdSchema,
        title: displayText(200),
        maxPoints: z.number().min(0),
        dueAt: IsoDateTimeSchema.nullable(),
      }),
    )
    .default([]),
  rows: z
    .array(
      z.object({
        learner: ActorRefSchema,
        entries: z.array(GradebookEntrySchema).default([]),
        averagePercent: z.number().min(0).max(100).nullable().default(null),
      }),
    )
    .default([]),
});
export type Gradebook = z.infer<typeof GradebookSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const CreateAssignmentSchema = z.strictObject({
  courseId: z.uuid(),
  lessonId: z.uuid().optional(),
  title: displayText(200),
  instructions: richText(20_000).optional(),
  submissionKind: SubmissionKindSchema.optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  maxFiles: z.number().int().min(0).max(20).optional(),
  allowedExtensions: z.array(z.string().max(16)).max(30).optional(),
  dueAt: IsoDateTimeSchema.nullable().optional(),
  latePolicy: LatePolicySchema.optional(),
  latePenaltyPercent: z.number().min(0).max(100).optional(),
  maxPoints: z.number().min(0).max(1000).optional(),
  passPercent: z.number().min(0).max(100).optional(),
  rubric: RubricSchema.nullable().optional(),
  peerVisible: z.boolean().optional(),
  releaseGradesManually: z.boolean().optional(),
});

export const UpdateAssignmentSchema = CreateAssignmentSchema.partial()
  .omit({ courseId: true })
  .extend({ published: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, { error: 'nothing to update' });

/** Saves a draft. Repeated calls overwrite the same attempt. */
export const SaveSubmissionDraftSchema = z.strictObject({
  text: richText(50_000).optional(),
  links: z.array(z.string().url().max(2048)).max(10).optional(),
  assetIds: z.array(AssetIdSchema).max(20).optional(),
});

/**
 * Hands the work in. Separate from the draft save so a partial autosave can
 * never be mistaken for a submission.
 */
export const SubmitAssignmentSchema = z.strictObject({
  /** Confirms the learner has seen the late warning, when one applies. */
  acknowledgeLate: z.boolean().default(false),
});

export const GradeSubmissionSchema = z
  .strictObject({
    /** Used when the assignment has no rubric. */
    points: z.number().min(0).max(1000).optional(),
    /** Used when it does; the server sums them. */
    criteria: z.array(CriterionScoreSchema).max(20).optional(),
    feedback: richText(20_000).optional(),
    feedbackAssetIds: z.array(AssetIdSchema).max(10).optional(),
    /** Ask for another attempt instead of closing the assignment. */
    requestResubmit: z.boolean().default(false),
    /** Ignored when the assignment releases grades manually. */
    release: z.boolean().default(true),
  })
  .refine((v) => v.points !== undefined || (v.criteria?.length ?? 0) > 0, {
    error: 'provide either points or rubric criteria',
    path: ['points'],
  });

export const ReleaseGradesSchema = z.strictObject({
  /** Empty releases every graded submission for the assignment. */
  submissionIds: z.array(SubmissionIdSchema).max(500).default([]),
});

export const ListSubmissionsQuerySchema = PaginationQuerySchema.extend({
  status: SubmissionStatusSchema.optional(),
  learnerId: UserIdSchema.optional(),
  late: z.boolean().optional(),
  /** Only submissions that still need a grade. */
  ungraded: z.boolean().optional(),
});

export const AssignmentListSchema = paginated(AssignmentSchema);
export const SubmissionListSchema = paginated(SubmissionSchema);

// ---------------------------------------------------------------------------
// Inferred request types
// ---------------------------------------------------------------------------

export type CreateAssignment = z.infer<typeof CreateAssignmentSchema>;
export type UpdateAssignment = z.infer<typeof UpdateAssignmentSchema>;
export type SaveSubmissionDraft = z.infer<typeof SaveSubmissionDraftSchema>;
export type SubmitAssignment = z.infer<typeof SubmitAssignmentSchema>;
export type GradeSubmission = z.infer<typeof GradeSubmissionSchema>;
export type ReleaseGrades = z.infer<typeof ReleaseGradesSchema>;
export type ListSubmissionsQuery = z.infer<typeof ListSubmissionsQuerySchema>;
export type CriterionScore = z.infer<typeof CriterionScoreSchema>;
export type GradebookEntry = z.infer<typeof GradebookEntrySchema>;