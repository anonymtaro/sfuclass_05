import { useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useCourse } from '@classroom/core-client';
import BlockPalette from './BlockPalette.jsx';
import ModuleNode from './ModuleNode.jsx';
import LessonInspector from './LessonInspector.jsx';
import PathGraphEditor from './PathGraphEditor.jsx';
import PublishDialog from './PublishDialog.jsx';
import './builder.css';

const STATUS_TEXT = {
  connecting: 'Connecting…',
  synced: 'All changes shared',
  offline: 'Offline — changes are kept and will sync',
};

/**
 * The builder shell.
 *
 * State lives in a Yjs document served by realtime/collabServer.js — the same
 * websocket the whiteboard uses. That means: no save button, no optimistic
 * local copy to reconcile, and two authors dragging in the same course converge
 * rather than overwrite. `useCourse()` owns the document and exposes intents;
 * nothing in this folder touches Yjs directly.
 *
 * Three drags, one handler:
 *   palette → module body   create a lesson of that type at the drop position
 *   lesson  → module body   move or reorder, possibly across modules
 *   module  → module list   reorder modules
 *
 * Ordering is the author's, so it is stored as an explicit order field rather
 * than inferred from array position on the server — a concurrent insert must not
 * silently renumber somebody else's work.
 */
export default function BuilderCanvas({ courseId }) {
  const {
    course,
    modules,
    lessonsByModule,
    status,
    collaborators,
    loading,
    error,
    readOnly,
    limitNotice,
    addModule,
    renameModule,
    removeModule,
    moveModule,
    addLesson,
    moveLesson,
    updateLesson,
    removeLesson,
    undo,
    redo,
  } = useCourse(courseId);

  const [selectedLessonId, setSelectedLessonId] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [view, setView] = useState('tree'); // 'tree' | 'path'
  const [publishOpen, setPublishOpen] = useState(false);

  const sensors = useSensors(
    // A small distance keeps a click on a card from being read as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const selectedLesson = useMemo(() => {
    for (const list of Object.values(lessonsByModule ?? {})) {
      const hit = list.find((l) => l.id === selectedLessonId);
      if (hit) return hit;
    }
    return null;
  }, [lessonsByModule, selectedLessonId]);

  const onDragStart = ({ active }) => setDragging(active);

  const onDragEnd = ({ active, over }) => {
    setDragging(null);
    if (!over || readOnly) return;

    const from = active.data.current ?? {};
    const to = over.data.current ?? {};

    // Dropped on a lesson → land next to it; dropped on a body → append.
    const targetModuleId = to.moduleId ?? (to.source === 'module' ? over.id : null);
    if (!targetModuleId) {
      if (from.source === 'module' && to.source === 'module' && active.id !== over.id) {
        moveModule(active.id, modules.findIndex((m) => m.id === over.id));
      }
      return;
    }

    const siblings = lessonsByModule[targetModuleId] ?? [];
    const index = to.source === 'lesson' ? siblings.findIndex((l) => l.id === over.id) : siblings.length;

    if (from.source === 'palette') {
      const id = addLesson({ moduleId: targetModuleId, type: from.lessonType, index });
      setSelectedLessonId(id);
      return;
    }

    if (from.source === 'lesson') {
      moveLesson(active.id, { toModuleId: targetModuleId, index });
    }
  };

  const appendBlock = (type) => {
    const target = modules.at(-1) ?? { id: addModule({ title: 'Module 1' }) };
    const id = addLesson({ moduleId: target.id, type });
    setSelectedLessonId(id);
  };

  if (loading && !course) return <p className="cb cb-note">Opening the course…</p>;

  if (error) {
    return (
      <p className="cb cb-note cb-note--danger">
        The course could not be opened. Nothing was lost — reload once the connection is back.
      </p>
    );
  }

  return (
    <div className="cb" style={{ display: 'grid', gap: 12, height: '100%', minHeight: 0 }}>
      <div className="cb-toolbar">
        <strong style={{ flex: '1 1 auto' }}>{course.title}</strong>

        <span className="cb-status" data-state={status}>
          <span className="cb-status__dot" aria-hidden="true" />
          {STATUS_TEXT[status] ?? status}
        </span>

        {collaborators?.length ? (
          <span className="cb-collaborators" aria-label={`${collaborators.length} people editing`}>
            {collaborators.slice(0, 4).map((c) =>
              c.avatarUrl ? (
                <img key={c.id} src={c.avatarUrl} alt={c.displayName} title={c.displayName} />
              ) : (
                <span key={c.id} title={c.displayName}>
                  {c.displayName.slice(0, 1)}
                </span>
              ),
            )}
          </span>
        ) : null}

        <span className="cb-row">
          <button type="button" className="cb-btn" disabled={readOnly} onClick={undo}>
            Undo
          </button>
          <button type="button" className="cb-btn" disabled={readOnly} onClick={redo}>
            Redo
          </button>
        </span>

        <span className="cb-row">
          <button
            type="button"
            className={`cb-btn${view === 'tree' ? ' cb-btn--primary' : ''}`}
            onClick={() => setView('tree')}
          >
            Structure
          </button>
          <button
            type="button"
            className={`cb-btn${view === 'path' ? ' cb-btn--primary' : ''}`}
            onClick={() => setView('path')}
          >
            Prerequisites
          </button>
        </span>

        <button
          type="button"
          className="cb-btn cb-btn--primary"
          disabled={readOnly}
          onClick={() => setPublishOpen(true)}
        >
          Publish…
        </button>
      </div>

      {view === 'path' ? (
        <PathGraphEditor courseId={courseId} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          <div className={`cb-shell${selectedLesson ? '' : ' cb-shell--no-inspector'}`}>
            <BlockPalette onAppend={appendBlock} blocked={limitNotice} disabled={readOnly} />

            <section className="cb-column" aria-label="Course structure">
              <header className="cb-column__head">
                <p className="cb-column__title">Structure</p>
                <button
                  type="button"
                  className="cb-btn"
                  disabled={readOnly}
                  onClick={() => addModule({ title: `Module ${modules.length + 1}` })}
                >
                  Add module
                </button>
              </header>

              <div className="cb-column__body">
                {modules.length === 0 ? (
                  <p className="cb-note">
                    Start with a module, then drag blocks into it. A module is what learners see as
                    a section.
                  </p>
                ) : null}

                <SortableContext
                  items={modules.map((m) => m.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {modules.map((m) => (
                    <ModuleNode
                      key={m.id}
                      module={m}
                      lessons={lessonsByModule[m.id] ?? []}
                      selectedLessonId={selectedLessonId}
                      onSelectLesson={setSelectedLessonId}
                      onRename={renameModule}
                      onRemove={removeModule}
                      onAddLesson={(moduleId) =>
                        setSelectedLessonId(addLesson({ moduleId, type: 'doc' }))
                      }
                      readOnly={readOnly}
                    />
                  ))}
                </SortableContext>
              </div>
            </section>

            {selectedLesson ? (
              <LessonInspector
                lesson={selectedLesson}
                courseId={courseId}
                readOnly={readOnly}
                onChange={(patch) => updateLesson(selectedLesson.id, patch)}
                onDelete={() => {
                  removeLesson(selectedLesson.id);
                  setSelectedLessonId(null);
                }}
                onClose={() => setSelectedLessonId(null)}
              />
            ) : null}
          </div>

          {/* The overlay is what the pointer carries; the source stays in place
              at reduced opacity so the author keeps their bearings. */}
          <DragOverlay dropAnimation={null}>
            {dragging ? (
              <div className="cb-lesson" style={{ cursor: 'grabbing' }}>
                <span className="cb-lesson__icon" aria-hidden="true">
                  ⠿
                </span>
                <span className="cb-lesson__main">
                  <span className="cb-lesson__title">
                    {dragging.data.current?.source === 'palette'
                      ? `New ${dragging.data.current.lessonType}`
                      : 'Moving'}
                  </span>
                </span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {publishOpen ? (
        <PublishDialog courseId={courseId} onClose={() => setPublishOpen(false)} />
      ) : null}
    </div>
  );
}