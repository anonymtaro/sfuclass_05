import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import LessonCard from './LessonCard.jsx';
import './builder.css';

/**
 * A module is both a sortable item (modules reorder among themselves) and a drop
 * target (lessons and palette blocks land inside it). dnd-kit allows one element
 * to be both, which is why the head carries the sortable grip and the body is a
 * separate droppable.
 *
 * The title is an input bound straight to the shared document: typing is a Yjs
 * update, so two authors renaming the same module converge instead of one
 * overwriting the other. There is no save button because there is nothing to
 * save.
 */
export default function ModuleNode({
  module,
  lessons,
  selectedLessonId,
  onSelectLesson,
  onRename,
  onRemove,
  onAddLesson,
  readOnly = false,
}) {
  const [collapsed, setCollapsed] = useState(false);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: module.id,
    data: { source: 'module' },
    disabled: readOnly,
  });

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `module-body:${module.id}`,
    data: { source: 'module-body', moduleId: module.id },
  });

  return (
    <section
      ref={setNodeRef}
      className={[
        'cb-module',
        isDragging ? 'cb-module--dragging' : '',
        isOver ? 'cb-module--over' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      aria-label={module.title || 'Untitled module'}
      {...attributes}
    >
      <header className="cb-module__head">
        <button
          type="button"
          className="cb-grip"
          aria-label={`Reorder ${module.title || 'module'}`}
          disabled={readOnly}
          {...listeners}
        >
          ⠿
        </button>

        <button
          type="button"
          className="cb-btn cb-btn--ghost"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? '▸' : '▾'}
        </button>

        <input
          className="cb-module__title"
          value={module.title}
          placeholder="Untitled module"
          readOnly={readOnly}
          aria-label="Module title"
          onChange={(e) => onRename(module.id, e.target.value)}
        />

        <span className="cb-module__count">
          {lessons.length} {lessons.length === 1 ? 'lesson' : 'lessons'}
        </span>

        {readOnly ? null : (
          <>
            <button
              type="button"
              className="cb-btn cb-btn--ghost"
              onClick={() => onAddLesson(module.id)}
              aria-label={`Add a lesson to ${module.title || 'this module'}`}
            >
              +
            </button>
            <button
              type="button"
              className="cb-btn cb-btn--ghost"
              aria-label={`Delete ${module.title || 'this module'}`}
              onClick={() => {
                const ok =
                  lessons.length === 0 ||
                  window.confirm(
                    `Delete “${module.title || 'this module'}” and its ${lessons.length} lesson(s)?`,
                  );
                if (ok) onRemove(module.id);
              }}
            >
              🗑
            </button>
          </>
        )}
      </header>

      {collapsed ? null : (
        <div className="cb-module__body" ref={setDropRef} role="listbox" aria-label="Lessons">
          <SortableContext items={lessons.map((l) => l.id)} strategy={verticalListSortingStrategy}>
            {lessons.length === 0 ? (
              <p className="cb-module__empty">Drop a block here</p>
            ) : (
              lessons.map((lesson) => (
                <LessonCard
                  key={lesson.id}
                  lesson={lesson}
                  selected={lesson.id === selectedLessonId}
                  onSelect={onSelectLesson}
                  disabled={readOnly}
                />
              ))
            )}
          </SortableContext>
        </div>
      )}
    </section>
  );
}