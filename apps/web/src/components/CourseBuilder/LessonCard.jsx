import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LessonTypes } from '@classroom/contracts';
import { BLOCKS } from './BlockPalette.jsx';
import './builder.css';

const ICONS = Object.fromEntries(BLOCKS.map((b) => [b.type, b.icon]));

function duration(minutes) {
  if (!minutes) return null;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Flags are the point of this card.
 *
 * An author scanning a course wants to know which lessons are not ready, and
 * "not ready" means different things per type: a video whose asset is still
 * transcoding, a live session with no time on the calendar, a task with no due
 * date. PublishDialog refuses to publish for exactly these reasons, so the same
 * conditions are surfaced here rather than saved up for the publish attempt.
 */
function flagsFor(lesson) {
  const flags = [];

  if (lesson.type === LessonTypes.VIDEO) {
    if (!lesson.assetId) flags.push({ text: 'No video', tone: 'danger' });
    else if (lesson.assetStatus && lesson.assetStatus !== 'ready') {
      flags.push({ text: 'Transcoding', tone: 'warn' });
    }
  }

  if (lesson.type === LessonTypes.DOC && !lesson.assetId && !lesson.body) {
    flags.push({ text: 'Empty', tone: 'danger' });
  }

  if (lesson.type === LessonTypes.LIVE && !lesson.scheduledAt) {
    flags.push({ text: 'No time set', tone: 'danger' });
  }

  if (lesson.type === LessonTypes.QUIZ && !(lesson.questionCount > 0)) {
    flags.push({ text: 'No questions', tone: 'danger' });
  }

  if (lesson.type === LessonTypes.TASK && !lesson.dueAt) {
    flags.push({ text: 'No due date', tone: 'warn' });
  }

  if (lesson.draft) flags.push({ text: 'Unpublished', tone: 'draft' });

  return flags;
}

export default function LessonCard({ lesson, selected, onSelect, disabled = false }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: lesson.id,
    data: { source: 'lesson', moduleId: lesson.moduleId },
    disabled,
  });

  const flags = flagsFor(lesson);

  const meta = [
    lesson.type === LessonTypes.LIVE && lesson.scheduledAt
      ? new Date(lesson.scheduledAt).toLocaleString()
      : null,
    duration(lesson.durationMinutes),
    lesson.prerequisiteCount ? `${lesson.prerequisiteCount} prerequisite(s)` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      ref={setNodeRef}
      className={`cb-lesson${isDragging ? ' cb-lesson--dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      aria-selected={selected}
      role="option"
      onClick={() => onSelect?.(lesson.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect?.(lesson.id);
      }}
      tabIndex={0}
      {...attributes}
    >
      {/* The grip is the only drag handle, so clicking the card selects it and a
          drag never starts by accident while someone is reading. */}
      <button
        type="button"
        className="cb-grip"
        aria-label={`Reorder ${lesson.title}`}
        disabled={disabled}
        {...listeners}
      >
        ⠿
      </button>

      <span className="cb-lesson__icon" aria-hidden="true">
        {ICONS[lesson.type] ?? '•'}
      </span>

      <span className="cb-lesson__main">
        <span className="cb-lesson__title">{lesson.title || 'Untitled lesson'}</span>
        {meta ? <span className="cb-lesson__meta">{meta}</span> : null}
      </span>

      <span style={{ display: 'flex', gap: 4 }}>
        {flags.map((f) => (
          <span key={f.text} className={`cb-flag cb-flag--${f.tone}`}>
            {f.text}
          </span>
        ))}
      </span>
    </div>
  );
}

export { flagsFor };