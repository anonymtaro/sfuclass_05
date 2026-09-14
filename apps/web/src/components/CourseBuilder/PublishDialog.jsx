import { useEffect, useRef, useState } from 'react';
import { courseApi, useCourse } from '@classroom/core-client';
import './builder.css';

const MARK = { error: '✕', warning: '!', info: 'i' };

/**
 * Publishing is one server call and it is the server that decides.
 *
 * `courseApi.validate` runs CurriculumGraph (cycles, unreachable modules) and
 * CourseService's readiness rules (a video with no asset, a live lesson with no
 * time, an empty quiz) against the saved draft — not against what this client
 * happens to have in memory. Errors block; warnings do not.
 *
 * Publishing writes a new immutable version. Learners already partway through
 * stay on the version they started, which is why "what changes for people
 * already enrolled" is stated here rather than left to be discovered.
 */
export default function PublishDialog({ courseId, onClose }) {
  const { course, refresh } = useCourse(courseId);
  const dialogRef = useRef(null);

  const [report, setReport] = useState(null);
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (el && !el.open) el.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    courseApi
      .validate(courseId)
      .then((r) => !cancelled && setReport(r))
      .catch(() => !cancelled && setError('The course could not be checked. Try again in a moment.'));
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const errors = report?.issues?.filter((i) => i.severity === 'error') ?? [];
  const warnings = report?.issues?.filter((i) => i.severity === 'warning') ?? [];
  const blocked = errors.length > 0;

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await courseApi.publish(courseId, { note: note.trim() || undefined, notify });
      setDone(result);
      refresh();
    } catch (e) {
      // A race: somebody changed the draft between validate and publish, and the
      // server re-validated. Show the fresh reason rather than a generic failure.
      setError(
        e?.code === 'VALIDATION_FAILED'
          ? 'The course changed while you were here. Re-checking…'
          : 'Publishing did not go through. Nothing was changed.',
      );
      if (e?.code === 'VALIDATION_FAILED') {
        courseApi.validate(courseId).then(setReport).catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="cb cb-dialog"
      aria-label="Publish course"
      onClose={() => onClose?.()}
      onCancel={(e) => {
        e.preventDefault();
        onClose?.();
      }}
    >
      <div className="cb-dialog__head">
        <p className="cb-dialog__title">
          {done ? 'Published' : `Publish “${course?.title ?? 'course'}”`}
        </p>
        <button type="button" className="cb-btn cb-btn--ghost" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="cb-dialog__body">
        {done ? (
          <>
            <p style={{ margin: 0 }}>
              Version {done.version} is live. Learners who are partway through stay on the version
              they started.
            </p>
            {done.spaceCreated ? (
              <p className="cb-note">A community space was created for this course.</p>
            ) : null}
          </>
        ) : (
          <>
            {!report && !error ? <p className="cb-muted">Checking the course…</p> : null}

            {report ? (
              <div className="cb-diff">
                <span>
                  {report.moduleCount} modules · {report.lessonCount} lessons ·{' '}
                  {report.liveCount} live sessions
                </span>
                <span className="cb-muted">
                  {course?.publishedVersion
                    ? `Currently published: version ${course.publishedVersion}. This becomes version ${course.publishedVersion + 1}.`
                    : 'This is the first version.'}
                </span>
                {report.changedSince?.length ? (
                  <span className="cb-muted">
                    Changed since the last version: {report.changedSince.join(', ')}
                  </span>
                ) : null}
              </div>
            ) : null}

            {report?.issues?.length ? (
              <div className="cb-issues">
                {[...errors, ...warnings].map((issue, i) => (
                  <div key={`${issue.code}-${i}`} className="cb-issue" data-severity={issue.severity}>
                    <span className="cb-issue__mark" aria-hidden="true">
                      {MARK[issue.severity]}
                    </span>
                    <span>
                      {issue.message}
                      {issue.where ? <span className="cb-issue__where">{issue.where}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            ) : report ? (
              <p className="cb-note">Everything checks out.</p>
            ) : null}

            {blocked ? (
              <p className="cb-note cb-note--danger">
                {errors.length} thing(s) have to be fixed before this can go out. Warnings are yours
                to judge.
              </p>
            ) : null}

            <label className="cb-field">
              <span className="cb-field__label">What changed (optional)</span>
              <input
                value={note}
                maxLength={200}
                placeholder="Rewrote module 2, added the live Q&A"
                onChange={(e) => setNote(e.target.value)}
              />
              <span className="cb-field__hint">
                Kept with the version, so you can tell two versions apart later.
              </span>
            </label>

            <label className="cb-switch">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
              <span>
                Tell enrolled learners
                <span className="cb-field__hint">
                  One notification through the usual channels — in-app, push, and the daily digest
                  for anyone who batches them.
                </span>
              </span>
            </label>

            {error ? <p className="cb-note cb-note--danger">{error}</p> : null}
          </>
        )}
      </div>

      <div className="cb-dialog__foot">
        <button type="button" className="cb-btn" onClick={onClose}>
          {done ? 'Close' : 'Cancel'}
        </button>
        {done ? null : (
          <button
            type="button"
            className="cb-btn cb-btn--primary"
            disabled={busy || blocked || !report}
            onClick={publish}
          >
            {busy ? 'Publishing…' : 'Publish'}
          </button>
        )}
      </div>
    </dialog>
  );
}