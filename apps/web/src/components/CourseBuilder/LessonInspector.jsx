import { useState } from 'react';
import { LessonTypes } from '@classroom/contracts';
import MediaLibrary from '../Media/MediaLibrary.jsx';
import { flagsFor } from './LessonCard.jsx';
import './builder.css';

/** datetime-local wants a local ISO string without the timezone suffix. */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function AssetField({ label, hint, lesson, accept, readOnly, onChange }) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="cb-field">
      <span className="cb-field__label">{label}</span>

      <div className="cb-row">
        <span style={{ flex: '1 1 auto', minWidth: 0 }}>
          {lesson.assetId ? (
            <>
              {lesson.assetName ?? 'Selected file'}
              {lesson.assetStatus && lesson.assetStatus !== 'ready' ? (
                <span className="cb-flag cb-flag--warn" style={{ marginInlineStart: 6 }}>
                  {lesson.assetStatus}
                </span>
              ) : null}
            </>
          ) : (
            <span className="cb-muted">Nothing chosen</span>
          )}
        </span>

        {readOnly ? null : (
          <>
            <button type="button" className="cb-btn" onClick={() => setPickerOpen(true)}>
              {lesson.assetId ? 'Replace' : 'Choose'}
            </button>
            {lesson.assetId ? (
              <button
                type="button"
                className="cb-btn cb-btn--ghost"
                onClick={() => onChange({ assetId: null, assetName: null, assetStatus: null })}
              >
                Remove
              </button>
            ) : null}
          </>
        )}
      </div>

      {hint ? <span className="cb-field__hint">{hint}</span> : null}

      {pickerOpen ? (
        <MediaLibrary
          mode="picker"
          accept={accept}
          onPick={(asset) => {
            onChange({ assetId: asset.id, assetName: asset.filename, assetStatus: asset.status });
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * The property panel for whatever is selected.
 *
 * Every field writes straight through `onChange` into the shared document, so
 * edits appear on a co-author's screen as they are typed and there is nothing to
 * save. That is also why there is no local draft state here: a controlled input
 * fed by the document is the only version of the truth.
 *
 * The type-specific sections mirror what the server requires before a course can
 * be published (CurriculumGraph and CourseService), so the panel and
 * PublishDialog never disagree about what "ready" means.
 */
export default function LessonInspector({ lesson, courseId, readOnly, onChange, onDelete, onClose }) {
  const flags = flagsFor(lesson);

  return (
    <aside className="cb cb-column" aria-label="Lesson settings">
      <header className="cb-column__head">
        <p className="cb-column__title">Lesson</p>
        <button type="button" className="cb-btn cb-btn--ghost" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <div className="cb-column__body">
        {flags.length ? (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {flags.map((f) => (
              <span key={f.text} className={`cb-flag cb-flag--${f.tone}`}>
                {f.text}
              </span>
            ))}
          </div>
        ) : null}

        <label className="cb-field">
          <span className="cb-field__label">Title</span>
          <input
            value={lesson.title ?? ''}
            readOnly={readOnly}
            maxLength={140}
            onChange={(e) => onChange({ title: e.target.value })}
          />
        </label>

        <label className="cb-field">
          <span className="cb-field__label">What learners will see before opening it</span>
          <textarea
            rows={3}
            value={lesson.summary ?? ''}
            readOnly={readOnly}
            maxLength={400}
            onChange={(e) => onChange({ summary: e.target.value })}
          />
        </label>

        {lesson.type === LessonTypes.VIDEO ? (
          <>
            <AssetField
              label="Video"
              hint="Uploaded once, transcoded to an HLS ladder. Captions are generated automatically."
              lesson={lesson}
              accept="video/*"
              readOnly={readOnly}
              onChange={onChange}
            />

            <label className="cb-switch">
              <input
                type="checkbox"
                checked={Boolean(lesson.requireFullWatch)}
                disabled={readOnly}
                onChange={(e) => onChange({ requireFullWatch: e.target.checked })}
              />
              <span>
                Count as complete only when watched to the end
                <span className="cb-field__hint">
                  Otherwise opening the lesson marks it complete.
                </span>
              </span>
            </label>
          </>
        ) : null}

        {lesson.type === LessonTypes.DOC ? (
          <>
            <AssetField
              label="File"
              hint="PDF or slides. Leave empty to write the lesson inline instead."
              lesson={lesson}
              accept="application/pdf,image/*"
              readOnly={readOnly}
              onChange={onChange}
            />

            <label className="cb-field">
              <span className="cb-field__label">Or write it here</span>
              <textarea
                rows={8}
                value={lesson.body ?? ''}
                readOnly={readOnly}
                onChange={(e) => onChange({ body: e.target.value })}
              />
            </label>
          </>
        ) : null}

        {lesson.type === LessonTypes.QUIZ ? (
          <>
            <p className="cb-note">
              {lesson.questionCount
                ? `${lesson.questionCount} question(s).`
                : 'No questions yet — a quiz cannot be published empty.'}
            </p>

            <label className="cb-field">
              <span className="cb-field__label">Pass mark</span>
              <input
                type="number"
                min={0}
                max={100}
                value={lesson.passMark ?? 60}
                readOnly={readOnly}
                onChange={(e) => onChange({ passMark: Number(e.target.value) })}
              />
              <span className="cb-field__hint">Percent of points needed to complete the lesson.</span>
            </label>

            <label className="cb-field">
              <span className="cb-field__label">Attempts allowed</span>
              <input
                type="number"
                min={1}
                max={10}
                value={lesson.attempts ?? 3}
                readOnly={readOnly}
                onChange={(e) => onChange({ attempts: Number(e.target.value) })}
              />
            </label>
          </>
        ) : null}

        {lesson.type === LessonTypes.LIVE ? (
          <>
            <label className="cb-field">
              <span className="cb-field__label">Starts</span>
              <input
                type="datetime-local"
                value={toLocalInput(lesson.scheduledAt)}
                readOnly={readOnly}
                onChange={(e) =>
                  onChange({
                    scheduledAt: e.target.value ? new Date(e.target.value).toISOString() : null,
                  })
                }
              />
              <span className="cb-field__hint">
                Stored in UTC and shown to each learner in their own timezone. Reminders go out 24
                hours and 10 minutes before.
              </span>
            </label>

            <label className="cb-field">
              <span className="cb-field__label">Length</span>
              <input
                type="number"
                min={5}
                max={480}
                step={5}
                value={lesson.durationMinutes ?? 60}
                readOnly={readOnly}
                onChange={(e) => onChange({ durationMinutes: Number(e.target.value) })}
              />
            </label>

            <label className="cb-switch">
              <input
                type="checkbox"
                checked={Boolean(lesson.waitingRoom)}
                disabled={readOnly}
                onChange={(e) => onChange({ waitingRoom: e.target.checked })}
              />
              <span>
                Hold people in a waiting room
                <span className="cb-field__hint">You admit them one by one when you're ready.</span>
              </span>
            </label>

            <label className="cb-switch">
              <input
                type="checkbox"
                checked={Boolean(lesson.record)}
                disabled={readOnly}
                onChange={(e) => onChange({ record: e.target.checked })}
              />
              <span>
                Record the session
                <span className="cb-field__hint">
                  The recording becomes a video asset in this course and counts against storage.
                </span>
              </span>
            </label>

            <p className="cb-note">
              A classroom is created from this lesson at the scheduled time — there is no separate
              room to set up or link.
            </p>
          </>
        ) : null}

        {lesson.type === LessonTypes.TASK ? (
          <>
            <label className="cb-field">
              <span className="cb-field__label">Due</span>
              <input
                type="datetime-local"
                value={toLocalInput(lesson.dueAt)}
                readOnly={readOnly}
                onChange={(e) =>
                  onChange({ dueAt: e.target.value ? new Date(e.target.value).toISOString() : null })
                }
              />
            </label>

            <label className="cb-field">
              <span className="cb-field__label">Points</span>
              <input
                type="number"
                min={0}
                max={1000}
                value={lesson.points ?? 100}
                readOnly={readOnly}
                onChange={(e) => onChange({ points: Number(e.target.value) })}
              />
            </label>

            <label className="cb-switch">
              <input
                type="checkbox"
                checked={Boolean(lesson.allowResubmit)}
                disabled={readOnly}
                onChange={(e) => onChange({ allowResubmit: e.target.checked })}
              />
              <span>
                Allow resubmission until the due date
                <span className="cb-field__hint">
                  After the due date submissions lock and grading opens.
                </span>
              </span>
            </label>
          </>
        ) : null}

        {lesson.prerequisiteTitles?.length ? (
          <div className="cb-field">
            <span className="cb-field__label">Unlocks after</span>
            <ul className="cb-chiplist">
              {lesson.prerequisiteTitles.map((t) => (
                <li key={t} className="cb-chip">
                  {t}
                </li>
              ))}
            </ul>
            <span className="cb-field__hint">Edit these in the Prerequisites view.</span>
          </div>
        ) : null}
      </div>

      {readOnly ? null : (
        <div className="cb-column__head" style={{ borderTop: '1px solid var(--cb-line)', borderBottom: 0 }}>
          <button
            type="button"
            className="cb-btn cb-btn--danger"
            onClick={() => {
              if (window.confirm(`Delete “${lesson.title || 'this lesson'}”?`)) onDelete();
            }}
          >
            Delete lesson
          </button>
        </div>
      )}
    </aside>
  );
}