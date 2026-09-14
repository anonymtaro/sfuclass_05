import { useDraggable } from '@dnd-kit/core';
import { LessonTypes } from '@classroom/contracts';
import './builder.css';

export const BLOCKS = [
  {
    type: LessonTypes.VIDEO,
    icon: '▶',
    name: 'Video',
    hint: 'Uploaded and transcoded to HLS',
  },
  {
    type: LessonTypes.DOC,
    icon: '📄',
    name: 'Document',
    hint: 'PDF, slides or written text',
  },
  {
    type: LessonTypes.QUIZ,
    icon: '✓',
    name: 'Quiz',
    hint: 'Questions with a pass mark',
  },
  {
    type: LessonTypes.LIVE,
    icon: '●',
    name: 'Live session',
    hint: 'Opens a classroom at a set time',
  },
  {
    type: LessonTypes.TASK,
    icon: '✎',
    name: 'Task',
    hint: 'Assignment with a submission',
  },
];

function Block({ block, onAppend, disabled }) {
  // `data` travels with the drag and is what BuilderCanvas reads in onDragEnd to
  // tell "a new block from the palette" apart from "an existing lesson moving".
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette:${block.type}`,
    data: { source: 'palette', lessonType: block.type },
    disabled,
  });

  return (
    <div
      ref={setNodeRef}
      className={`cb-block${isDragging ? ' cb-block--dragging' : ''}`}
      {...listeners}
      {...attributes}
      // Dragging is the fast path; clicking appends to the last module so the
      // builder is usable without a pointer at all.
      onClick={() => !disabled && onAppend?.(block.type)}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={`${block.name} — drag into a module, or press Enter to add it to the end`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!disabled) onAppend?.(block.type);
        }
      }}
    >
      <span className="cb-block__icon" aria-hidden="true">
        {block.icon}
      </span>
      <span>
        <span className="cb-block__name">{block.name}</span>
        <span className="cb-block__hint">{block.hint}</span>
      </span>
    </div>
  );
}

/**
 * The five lesson types, as drag sources.
 *
 * The palette holds no state and creates nothing. Dropping one emits an intent
 * that BuilderCanvas turns into a lesson in the shared Yjs document, so a block
 * dragged in on one screen appears on a co-author's screen in the same place.
 *
 * `blocked` is the course-limit case: LimitResolver says this plan is at its
 * course or lesson ceiling, so the blocks stay visible but refuse to drag and
 * the reason is printed rather than silently swallowed.
 */
export default function BlockPalette({ onAppend, blocked = null, disabled = false }) {
  return (
    <section className="cb cb-column" aria-label="Blocks">
      <header className="cb-column__head">
        <p className="cb-column__title">Blocks</p>
      </header>

      <div className="cb-column__body">
        <div className="cb-palette">
          {BLOCKS.map((b) => (
            <Block key={b.type} block={b} onAppend={onAppend} disabled={disabled || Boolean(blocked)} />
          ))}
        </div>

        {blocked ? <p className="cb-note cb-note--warn">{blocked}</p> : null}

        <p className="cb-note">
          Drag a block into a module, or drop it between two modules to start a new one.
        </p>
      </div>
    </section>
  );
}