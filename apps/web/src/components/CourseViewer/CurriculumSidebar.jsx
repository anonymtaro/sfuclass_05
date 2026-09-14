import { useEffect, useMemo, useState } from 'react';
import { LessonTypes } from '@classroom/contracts';
import { useCurriculum } from '@classroom/core-client';
import ProgressTracker from './ProgressTracker.jsx';
import './viewer.css';

const ICON = {
  [LessonTypes.VIDEO]: '▶',
  [LessonTypes.DOC]: '📄',
  [LessonTypes.QUIZ]: '✓',
  [LessonTypes.LIVE]: '●',
  [LessonTypes.TASK]: '✎',
};

const STATE_MARK = { complete: '✓', 'in-progress': '◐', locked: '🔒', new: '' };

function duration(minutes) {
  if (!minutes) return null;
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 || ''}`;
}

/**
 * The curriculum as a learner sees it: modules in order, lessons inside them,
 * and what is open.
 *
 * Locking is not decoration. PrerequisiteResolver evaluates the learning-path
 * DAG per learner and the server refuses a locked lesson, so a disabled row here
 * matches what the API would answer. The reason is shown rather than hidden,
 * because "locked" without "until you finish X" is just a dead end.
 *
 * The module containing the current lesson opens itself; everything else keeps
 * whatever the learner last did with it.
 */
export default function CurriculumSidebar({ courseId, onSelectLesson }) {
  const { course, modules, lessonsByModule, currentLessonId, loading, error } =
    useCurriculum(courseId);

  const [collapsed, setCollapsed] = useState(() => new Set());

  const currentModuleId = useMemo(() => {
    for (const [moduleId, lessons] of Object.entries(lessonsByModule ?? {})) {
      if (lessons.some((l) => l.id === currentLessonId)) return moduleId;
    }
    return null;
  }, [lessonsByModule, currentLessonId]);

  useEffect(() => {
    if (!currentModuleId) return;
    setCollapsed((prev) => {
      if (!prev.has(currentModuleId)) return prev;
      const next = new Set(prev);
      next.delete(currentModuleId);
      return next;
    });
  }, [currentModuleId]);

  const toggle = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (error) return <p className="cv cv-empty">This course could not be loaded.</p>;
  if (loading && !course) return <p className="cv cv-empty">Loading…</p>;

  return (
    <nav className="cv cv-sidebar" aria-label="Curriculum">
      <header className="cv-sidebar__head">
        <h2 className="cv-sidebar__title">{course.title}</h2>
        <ProgressTracker courseId={courseId} variant="bar" />
      </header>

      <div className="cv-sidebar__body">
        {modules.map((module) => {
          const lessons = lessonsByModule[module.id] ?? [];
          const done = lessons.filter((l) => l.state === 'complete').length;
          const isCollapsed = collapsed.has(module.id);
          const moduleLocked = lessons.length > 0 && lessons.every((l) => l.locked);

          return (
            <section className="cv-module" key={module.id}>
              <button
                type="button"
                className="cv-module__head"
                aria-expanded={!isCollapsed}
                onClick={() => toggle(module.id)}
              >
                <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
                <span className="cv-module__name">{module.title}</span>
                {moduleLocked ? (
                  <span className="cv-module__lock" aria-label="Locked">
                    🔒
                  </span>
                ) : (
                  <span className="cv-module__count">
                    {done}/{lessons.length}
                  </span>
                )}
              </button>

              {isCollapsed ? null : (
                <div className="cv-lessons">
                  {lessons.map((lesson) => {
                    const state = lesson.locked ? 'locked' : lesson.state ?? 'new';
                    return (
                      <button
                        key={lesson.id}
                        type="button"
                        className="cv-lesson"
                        aria-current={lesson.id === currentLessonId}
                        disabled={lesson.locked}
                        title={lesson.locked ? lesson.lockReason : undefined}
                        onClick={() => onSelectLesson?.(lesson.id)}
                      >
                        <span className="cv-lesson__state" data-state={state} aria-hidden="true">
                          {STATE_MARK[state]}
                        </span>

                        <span className="cv-lesson__icon" aria-hidden="true">
                          {ICON[lesson.type] ?? '•'}
                        </span>

                        <span className="cv-lesson__name">{lesson.title}</span>

                        <span className="cv-lesson__meta">
                          {lesson.type === LessonTypes.LIVE && lesson.scheduledAt
                            ? new Date(lesson.scheduledAt).toLocaleDateString(undefined, {
                                day: 'numeric',
                                month: 'short',
                              })
                            : duration(lesson.durationMinutes)}
                        </span>
                      </button>
                    );
                  })}

                  {/* One line, not a tooltip: a learner who cannot open a module
                      should be told what opens it. */}
                  {moduleLocked && lessons[0]?.lockReason ? (
                    <p className="cv-note" style={{ padding: '4px 16px 8px' }}>
                      {lessons[0].lockReason}
                    </p>
                  ) : null}
                </div>
              )}
            </section>
          );
        })}

        {modules.length === 0 ? <p className="cv-empty">This course has no content yet.</p> : null}
      </div>
    </nav>
  );
}