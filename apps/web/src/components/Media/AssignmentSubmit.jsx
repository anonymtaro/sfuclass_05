import { useEffect, useState } from 'react';
import { useAssignment } from '@classroom/core-client';
import Uploader from './Uploader.jsx';
import AttachmentTile from '../Chat/AttachmentTile.jsx';
import './media.css';

function dueState(dueAt) {
  if (!dueAt) return {};
  const ms = new Date(dueAt).getTime() - Date.now();
  return { late: ms < 0, soon: ms > 0 && ms < 48 * 3600 * 1000 };
}

/**
 * The learner's side of an assignment.
 *
 * Submitting is two steps on purpose. Files upload first — through the same
 * presign, quarantine and scan path as everything else — and the submission
 * itself is only created once they are ready. A submission can therefore never
 * point at a file that is still in quarantine, and a slow upload never becomes a
 * half-submitted assignment at the deadline.
 *
 * After the due date SubmissionService locks the record. That lock is what makes
 * the form read-only here; nothing about the deadline is enforced in this file.
 */
export default function AssignmentSubmit({ lessonId }) {
  const { assignment, submission, loading, error, submit, unsubmit } = useAssignment(lessonId);

  const [note, setNote] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    setNote(submission?.note ?? '');
    setFiles(submission?.attachments ?? []);
  }, [submission?.id, submission?.note, submission?.attachments]);

  if (loading && !assignment) return <p className="md md-note">Loading the assignment…</p>;
  if (error) return <p className="md md-note md-note--danger">This assignment could not be loaded.</p>;
  if (!assignment) return null;

  const { late, soon } = dueState(assignment.dueAt);
  const locked = Boolean(submission?.lockedAt) || (late && !assignment.allowLate);
  const graded = submission?.grade != null;
  const canEdit = !locked && !graded && (assignment.allowResubmit || !submission);

  const send = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await submit({ note: note.trim(), attachmentIds: files.map((f) => f.id) });
    } catch {
      setFailure('That did not submit. Your files are still attached — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="md md-assignment" aria-label={assignment.title}>
      <header className="md-assignment__head">
        <h2 className="md-assignment__title">{assignment.title}</h2>

        {assignment.dueAt ? (
          <span className="md-due" data-late={late} data-soon={soon}>
            {late ? 'Was due' : 'Due'} {new Date(assignment.dueAt).toLocaleString()}
          </span>
        ) : (
          <span className="md-due">No deadline</span>
        )}

        {assignment.points ? <span className="md-note">{assignment.points} points</span> : null}
      </header>

      {assignment.instructions ? (
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{assignment.instructions}</p>
      ) : null}

      {assignment.rubric?.length ? (
        <div>
          <p className="md-note">How it is marked</p>
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>
            {assignment.rubric.map((r) => (
              <li key={r.id}>
                {r.label} <span className="md-muted">— {r.points} pts</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {graded ? (
        <div className="md-grade">
          <span className="md-grade__score">
            {submission.grade}
            <span className="md-muted" style={{ fontSize: 14 }}> / {assignment.points}</span>
          </span>
          {submission.feedback ? (
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{submission.feedback}</p>
          ) : (
            <p className="md-note">No written feedback.</p>
          )}
          <p className="md-note">
            Marked by {submission.gradedBy?.displayName ?? 'your teacher'} on{' '}
            {new Date(submission.gradedAt).toLocaleDateString()}.
          </p>
        </div>
      ) : null}

      {submission && !graded ? (
        <p className="md-note">
          Handed in {new Date(submission.submittedAt).toLocaleString()}
          {submission.isLate ? ' — after the deadline' : ''}. Waiting to be marked.
        </p>
      ) : null}

      {files.length ? (
        <div className="md-files">
          {files.map((f) =>
            f.status === 'ready' ? (
              <AttachmentTile key={f.id} attachment={f} compact />
            ) : (
              <div key={f.id} className="md-file">
                <span className="md-file__name">{f.filename}</span>
                <span className="md-state" data-state={f.status}>
                  {f.status}
                </span>
              </div>
            ),
          )}

          {canEdit ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {files.map((f) => (
                <button
                  key={`rm-${f.id}`}
                  type="button"
                  className="md-btn md-btn--ghost"
                  onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}
                >
                  Remove {f.filename}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {canEdit ? (
        <>
          <Uploader
            scope={{ type: 'submission', lessonId }}
            title="Drop your work here"
            hint="Any format your teacher asked for. Uploads continue after a dropped connection."
            showQuota={false}
            onComplete={(asset) => setFiles((prev) => [...prev, asset])}
          />

          <label style={{ display: 'grid', gap: 4 }}>
            <span className="md-note">Anything to tell your teacher? (optional)</span>
            <textarea
              className="md-textarea"
              value={note}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="md-btn md-btn--primary"
              disabled={busy || (!files.length && !note.trim())}
              onClick={send}
            >
              {busy ? 'Handing in…' : submission ? 'Replace my submission' : 'Hand in'}
            </button>

            {submission && assignment.allowResubmit ? (
              <button type="button" className="md-btn md-btn--ghost" disabled={busy} onClick={unsubmit}>
                Withdraw
              </button>
            ) : null}

            {late && assignment.allowLate ? (
              <span className="md-note md-note--warn">This will be marked as late.</span>
            ) : null}
          </div>
        </>
      ) : (
        <p className="md-note">
          {graded
            ? 'This has been marked, so it can no longer be changed.'
            : locked
              ? 'The deadline has passed and submissions are closed.'
              : 'Your teacher does not allow resubmission.'}
        </p>
      )}

      {failure ? <p className="md-note md-note--danger">{failure}</p> : null}
    </section>
  );
}