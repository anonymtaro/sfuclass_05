// classroom-app/server/src/courses/PrerequisiteResolver.js
/**
 * Unlock rules  (F3)  [NEW]
 *
 * Decides what one learner may open right now, given the course graph and their
 * progress. Pure: it takes data and returns data, so it can run on the server
 * to enforce access and be reused to render locks in the sidebar without a
 * second implementation drifting away from the first.
 *
 * The rule is deliberately simple: a module unlocks when **every** module with
 * an edge into it is satisfied. `requirement: 'complete'` means finished;
 * `'pass'` means its quizzes were passed, which is stricter and is what a
 * competency-based course wants.
 *
 * Every locked module carries a reason naming what is missing. "Locked" with no
 * explanation is the single most common complaint about course platforms, and
 * it is entirely avoidable.
 */

import { allPrerequisitesOf, entryModules } from './CurriculumGraph.js';

/**
 * @typedef {{ lessonId: string, status: string, scorePercent: number|null }} LessonProgress
 */

/** A module is complete when every non-draft lesson in it is complete. */
const moduleCompletion = (module, progressByLesson) => {
  const lessons = module.lessons.filter((lesson) => !lesson.draft);
  if (lessons.length === 0) return { complete: true, passed: true, done: 0, total: 0 };

  let done = 0;
  let quizzes = 0;
  let quizzesPassed = 0;

  for (const lesson of lessons) {
    const progress = progressByLesson.get(lesson.lessonId);
    if (progress?.status === 'completed') done += 1;

    if (lesson.type === 'quiz') {
      quizzes += 1;
      const threshold = lesson.passPercent ?? 70;
      if ((progress?.scorePercent ?? -1) >= threshold) quizzesPassed += 1;
    }
  }

  return {
    complete: done === lessons.length,
    // 'pass' also requires completion: passing the quiz but skipping the
    // lessons around it is not finishing the module.
    passed: done === lessons.length && quizzesPassed === quizzes,
    done,
    total: lessons.length,
  };
};

/**
 * @param {{ modules: object[], edges: object[], progress: LessonProgress[], isInstructor?: boolean }} input
 * @returns {{ modules: object[], unlockedModuleIds: string[], nextLessonId: string|null }}
 */
export const resolve = ({ modules, edges = [], progress = [], isInstructor = false }) => {
  const progressByLesson = new Map(progress.map((entry) => [entry.lessonId, entry]));
  const moduleIds = modules.map((module) => module.moduleId);
  const byId = new Map(modules.map((module) => [module.moduleId, module]));

  const completion = new Map(
    modules.map((module) => [module.moduleId, moduleCompletion(module, progressByLesson)]),
  );

  // An author previewing their own course sees it unlocked. Walking a
  // twenty-module path to check the last lesson is not a review workflow.
  if (isInstructor) {
    return {
      modules: modules.map((module) => ({ ...module, locked: false, lockedReason: null })),
      unlockedModuleIds: moduleIds,
      nextLessonId: null,
    };
  }

  const entries = new Set(entryModules(moduleIds, edges));

  const resolved = modules.map((module) => {
    if (entries.has(module.moduleId)) {
      return { ...module, locked: false, lockedReason: null };
    }

    const missing = edges
      .filter((edge) => edge.to === module.moduleId)
      .filter((edge) => {
        const state = completion.get(edge.from);
        if (!state) return true; // the prerequisite is gone; treat as unmet
        return edge.requirement === 'pass' ? !state.passed : !state.complete;
      });

    if (missing.length === 0) {
      return { ...module, locked: false, lockedReason: null };
    }

    const names = missing
      .map((edge) => byId.get(edge.from)?.title)
      .filter(Boolean);

    return {
      ...module,
      locked: true,
      lockedReason:
        names.length === 1
          ? `Finish “${names[0]}” first.`
          : `Finish ${names.map((name) => `“${name}”`).join(' and ')} first.`,
      // Machine-readable alongside the sentence, so the UI can link to them.
      blockedBy: missing.map((edge) => edge.from),
    };
  });

  const unlockedModuleIds = resolved.filter((module) => !module.locked).map((m) => m.moduleId);

  return {
    modules: resolved,
    unlockedModuleIds,
    nextLessonId: findNextLesson(resolved, progressByLesson),
  };
};

/**
 * What the Continue button opens: the first unfinished lesson in the first
 * unlocked module, in curriculum order. An in-progress lesson beats an
 * untouched one — someone who stopped halfway through a video wants to go back
 * to it, not to the next thing.
 */
export const findNextLesson = (modules, progressByLesson) => {
  let firstUntouched = null;

  for (const module of modules) {
    if (module.locked) continue;

    for (const lesson of module.lessons) {
      if (lesson.draft) continue;
      const progress = progressByLesson.get(lesson.lessonId);

      if (progress?.status === 'in-progress') return lesson.lessonId;
      if (!progress || progress.status === 'not-started') {
        firstUntouched ??= lesson.lessonId;
      }
    }
  }

  return firstUntouched;
};

/**
 * The access check behind opening a lesson. Returns a reason rather than a
 * boolean, so the route can answer `prerequisite_not_met` with something the
 * learner can read.
 */
export const canOpenLesson = ({ lessonId, modules, edges, progress, isInstructor = false }) => {
  const resolved = resolve({ modules, edges, progress, isInstructor });

  const owner = resolved.modules.find((module) =>
    module.lessons.some((lesson) => lesson.lessonId === lessonId),
  );

  if (!owner) return { allowed: false, code: 'not_found' };

  const lesson = owner.lessons.find((entry) => entry.lessonId === lessonId);

  // A preview lesson is readable before enrolling, which is how a course page
  // shows a sample.
  if (lesson?.preview) return { allowed: true };

  if (owner.locked) {
    return {
      allowed: false,
      code: 'prerequisite_not_met',
      reason: owner.lockedReason,
      blockedBy: owner.blockedBy ?? [],
    };
  }

  if (lesson?.draft) return { allowed: false, code: 'not_found' };

  return { allowed: true };
};

/** Every module that must be finished before this one, transitively. */
export const pathTo = (moduleId, edges) => allPrerequisitesOf(moduleId, edges);

export default { resolve, canOpenLesson, findNextLesson };