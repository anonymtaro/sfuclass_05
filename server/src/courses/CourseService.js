// classroom-app/server/src/courses/CourseService.js
/**
 * Course authoring  (F3)  [NEW]
 *
 * CRUD, validation and publishing. The rules live here; the SQL lives in
 * models/.
 *
 * Publishing is the part worth reading. A course has a draft that the author
 * edits and a published version that learners read, and they are not the same
 * thing. Publishing snapshots the draft into a new version number; learners on
 * an older version stay there until they finish. Without that, restructuring a
 * course mid-cohort leaves progress rows pointing at modules that have moved or
 * gone — and the learner sees a course that changed underneath them.
 */

import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';
import * as Courses from './models/Course.js';
import * as Modules from './models/Module.js';
import * as Lessons from './models/Lesson.js';
import * as Paths from './models/LearningPath.js';
import * as Enrollments from './models/Enrollment.js';
import { validate as validateGraph, entryModules } from './CurriculumGraph.js';
import { resolve as resolveLocks } from './PrerequisiteResolver.js';

const log = logger.child({ component: 'course-service' });

const slugify = (title) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'course';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The whole tree. One call, because the builder and the viewer both need all of
 * it and three round trips to render a sidebar is three round trips.
 */
export const getCourseDetail = async ({ courseId, slug, userId = null, isInstructor = false }) => {
  const course = courseId
    ? await Courses.findById(courseId)
    : await Courses.findBySlug(slug);

  if (!course) throw Object.assign(new Error('course not found'), { code: 'not_found' });

  const [modules, lessons, path] = await Promise.all([
    Modules.listByCourse(course.courseId),
    Lessons.listByCourse(course.courseId),
    Paths.findByCourse(course.courseId),
  ]);

  const byModule = new Map();
  for (const lesson of lessons) {
    if (!byModule.has(lesson.moduleId)) byModule.set(lesson.moduleId, []);
    // Answers are stripped for anyone who is not teaching the course.
    byModule.get(lesson.moduleId).push(isInstructor ? lesson : Lessons.forLearner(lesson));
  }

  let withLessons = modules.map((module) => ({
    ...module,
    // A draft lesson is invisible to learners even in a published version.
    lessons: (byModule.get(module.moduleId) ?? []).filter(
      (lesson) => isInstructor || !lesson.draft,
    ),
  }));

  if (userId && !isInstructor) {
    const { getCourseProgress } = await import('./ProgressService.js');
    const progress = await getCourseProgress({ userId, courseId: course.courseId });
    withLessons = resolveLocks({
      modules: withLessons,
      edges: path?.edges ?? [],
      progress: progress.lessons,
    }).modules;
  }

  return { ...course, modules: withLessons, path };
};

export const listCourses = (query) => Courses.list(query);

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export const createCourse = async ({ ownerId, title, slug, ...rest }) => {
  let candidate = slug ?? slugify(title);

  // Collisions are common — two cohorts of "Introduction to Python" — so a
  // suffix is appended rather than the request being rejected.
  if (await Courses.slugExists(candidate)) {
    candidate = `${candidate}-${randomUUID().slice(0, 6)}`;
  }

  const course = await Courses.insert({ ownerId, title, slug: candidate, ...rest });
  log.info({ courseId: course.courseId, ownerId }, 'course created');
  return course;
};

export const updateCourse = async ({ courseId, patch }) => {
  if (patch.slug && (await Courses.slugExists(patch.slug, courseId))) {
    throw Object.assign(new Error('that address is already taken'), { code: 'conflict' });
  }
  return Courses.update(courseId, patch);
};

export const deleteCourse = async ({ courseId }) => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS active FROM enrollments WHERE course_id = $1 AND status = 'active'`,
    [courseId],
  );

  // Deleting a course with people in it is almost always a mistake, and it is
  // unrecoverable from the learner's side.
  if (rows[0].active > 0) {
    throw Object.assign(
      new Error(`${rows[0].active} learners are still enrolled; archive the course instead`),
      { code: 'conflict' },
    );
  }

  return Courses.softDelete(courseId);
};

// --- modules and lessons ---------------------------------------------------

export const addModule = (courseId, input) => Modules.insert({ courseId, ...input });
export const updateModule = (moduleId, patch) => Modules.update(moduleId, patch);

/** Deleting a module has to take its edges with it, or the path dangles. */
export const deleteModule = async ({ courseId, moduleId }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await Modules.softDelete(moduleId, client);
    await Paths.removeModule(courseId, moduleId, client);
    await client.query('COMMIT');
    return true;
  } catch (cause) {
    await client.query('ROLLBACK');
    throw cause;
  } finally {
    client.release();
  }
};

export const reorderModules = (courseId, orderedIds) => Modules.reorder(courseId, orderedIds);

export const addLesson = (moduleId, input) => Lessons.insert({ moduleId, ...input });
export const updateLesson = (lessonId, patch) => Lessons.update(lessonId, patch);
export const deleteLesson = (lessonId) => Lessons.softDelete(lessonId);
export const reorderLessons = (moduleId, orderedIds, targetModuleId) =>
  Lessons.reorder(moduleId, orderedIds, targetModuleId);

// --- learning path ---------------------------------------------------------

export const updatePath = async ({ courseId, edges }) => {
  const modules = await Modules.listByCourse(courseId);
  const moduleIds = modules.map((module) => module.moduleId);

  const result = validateGraph({ moduleIds, edges });
  if (!result.valid) {
    throw Object.assign(new Error(result.errors[0].message), {
      code: result.errors[0].code === 'curriculum_cycle' ? 'curriculum_cycle' : 'validation_failed',
      errors: result.errors,
    });
  }

  return Paths.save({ courseId, edges, entryModuleIds: entryModules(moduleIds, edges) });
};

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Everything that would stop a learner, and everything that merely looks
 * unfinished. The builder shows both before the author commits.
 */
export const validateForPublish = async (courseId) => {
  const [course, modules, lessons, path] = await Promise.all([
    Courses.findById(courseId),
    Modules.listByCourse(courseId),
    Lessons.listByCourse(courseId),
    Paths.findByCourse(courseId),
  ]);

  const errors = [];
  const warnings = [];

  if (!course) throw Object.assign(new Error('course not found'), { code: 'not_found' });
  if (modules.length === 0) {
    errors.push({ path: 'modules', message: 'A course needs at least one module.' });
  }

  const live = lessons.filter((lesson) => !lesson.draft);
  if (live.length === 0) {
    errors.push({ path: 'lessons', message: 'A course needs at least one published lesson.' });
  }

  // A lesson that cannot be opened is worse than a missing one: the learner
  // clicks it and nothing happens.
  for (const lesson of live) {
    if (lesson.type === 'video' && !lesson.assetId) {
      errors.push({ path: `lessons.${lesson.lessonId}`, message: `“${lesson.title}” has no video.` });
    }
    if (lesson.type === 'quiz' && (lesson.questions?.length ?? 0) === 0) {
      errors.push({ path: `lessons.${lesson.lessonId}`, message: `“${lesson.title}” has no questions.` });
    }
    if (lesson.type === 'task' && !lesson.assignmentId) {
      errors.push({ path: `lessons.${lesson.lessonId}`, message: `“${lesson.title}” has no assignment.` });
    }
    if (lesson.type === 'live' && !lesson.scheduledStart && !lesson.recurring) {
      warnings.push({ path: `lessons.${lesson.lessonId}`, message: `“${lesson.title}” has no date yet.` });
    }
  }

  const graph = validateGraph({
    moduleIds: modules.map((module) => module.moduleId),
    edges: path?.edges ?? [],
  });
  errors.push(...graph.errors);
  warnings.push(...graph.warnings);

  const empty = modules.filter(
    (module) => !live.some((lesson) => lesson.moduleId === module.moduleId),
  );
  for (const module of empty) {
    warnings.push({ path: `modules.${module.moduleId}`, message: `“${module.title}” is empty.` });
  }

  if (!course.coverAssetId) {
    warnings.push({ path: 'cover', message: 'No cover image.' });
  }

  return { publishable: errors.length === 0, errors, warnings };
};

/**
 * `force` publishes despite warnings. It never publishes despite errors — the
 * server does not take the client's word for that.
 */
export const publishCourse = async ({ courseId, force = false, changelog = null, actorId }) => {
  const validation = await validateForPublish(courseId);

  if (!validation.publishable) {
    throw Object.assign(new Error('this course cannot be published yet'), {
      code: 'validation_failed',
      errors: validation.errors,
    });
  }
  if (validation.warnings.length > 0 && !force) {
    return { published: false, ...validation };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE courses
          SET status = 'published',
              version = version + 1,
              published_version = version + 1,
              published_at = now(),
              updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING version`,
      [courseId],
    );

    const version = rows[0]?.version;
    if (!version) throw Object.assign(new Error('course not found'), { code: 'not_found' });

    // The snapshot is what a learner on this version reads, whatever the
    // author does to the draft afterwards.
    await client.query(
      `INSERT INTO course_versions (course_id, version, snapshot, changelog, published_by)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [
        courseId,
        version,
        JSON.stringify(await getCourseDetail({ courseId, isInstructor: true })),
        changelog,
        actorId,
      ],
    );

    await client.query('COMMIT');

    log.info({ courseId, version, actorId }, 'course published');

    // A published course gets a discussion space, once.
    void import('../community/SpaceService.js')
      .then(({ provisionForCourse }) => provisionForCourse({ courseId }))
      .catch((cause) => log.error({ err: cause, courseId }, 'space not provisioned'));

    return { published: true, version, ...validation };
  } catch (cause) {
    await client.query('ROLLBACK');
    throw cause;
  } finally {
    client.release();
  }
};

/** Existing learners keep their version; only new enrolment stops. */
export const unpublishCourse = ({ courseId }) => Courses.update(courseId, { status: 'draft' });

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

export const enroll = async ({ courseId, userId, source = 'self' }) => {
  const course = await Courses.findById(courseId);
  if (!course) throw Object.assign(new Error('course not found'), { code: 'not_found' });

  if (course.status !== 'published' && source === 'self') {
    throw Object.assign(new Error('this course is not published'), { code: 'course_not_published' });
  }

  return Enrollments.enroll({
    courseId,
    userId,
    courseVersion: course.publishedVersion ?? course.version,
    source,
  });
};

export const unenroll = ({ courseId, userId }) => Enrollments.cancel({ courseId, userId });

// ---------------------------------------------------------------------------
// Whiteboard snapshots  (called by classroom/interaction/Whiteboard.js)
// ---------------------------------------------------------------------------

/**
 * The board is a Yjs update blob against a lesson. Stored here rather than in
 * the lesson payload because it is binary, rewritten every thirty seconds
 * during a session, and of no interest to anything that reads a lesson.
 */
export const saveWhiteboardSnapshot = async (lessonId, update) => {
  await pool.query(
    `INSERT INTO lesson_whiteboards (lesson_id, snapshot, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (lesson_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = now()`,
    [lessonId, Buffer.from(update)],
  );
};

export const loadWhiteboardSnapshot = async (lessonId) => {
  const { rows } = await pool.query(
    `SELECT snapshot FROM lesson_whiteboards WHERE lesson_id = $1`,
    [lessonId],
  );
  return rows[0]?.snapshot ? new Uint8Array(rows[0].snapshot) : null;
};

export default {
  getCourseDetail, listCourses, createCourse, updateCourse, deleteCourse,
  publishCourse, validateForPublish, updatePath, enroll,
  saveWhiteboardSnapshot, loadWhiteboardSnapshot,
};