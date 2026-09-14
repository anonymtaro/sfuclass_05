import { useState } from 'react';
import { courseApi, useCurriculum } from '@classroom/core-client';
import './viewer.css';

function duration(minutes) {
  if (!minutes) return null;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Two shapes, one source.
 *
 * `variant="bar"` is the thin meter that sits in the sidebar head.
 * `variant="card"` is the full panel with counts, the resume point and, once the
 * path is finished, the certificate.
 *
 * Percent is computed server-side by ProgressService from completed lessons over
 * required lessons, so optional material does not quietly make 100% unreachable.
 * The certificate is issued by CertificateService when the *learning path* is
 * complete — which is not always the same as every lesson being ticked, because
 * a path can branch.
 */
export default function ProgressTracker({ courseId, variant = 'card', onResume }) {
  const { course, progress, enrollment, loading } = useCurriculum(courseId);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState(null);

  if (loading && !progress) {
    return variant === 'bar' ? null : <p className="cv cv-note">Loading your progress…</p>;
  }

  if (!progress) return null;

  const percent = Math.round(progress.percent ?? 0);
  const complete = percent >= 100;

  if (variant === 'bar') {
    return (
      <div className="cv cv-progress">
        <div className="cv-progress__head">
          <span>{complete ? 'Course complete' : 'Your progress'}</span>
          <span className="cv-progress__value">
            {progress.completedCount}/{progress.requiredCount} · {percent}%
          </span>
        </div>
        <div
          className="cv-progress__track"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Course progress"
        >
          <div className="cv-progress__fill" data-complete={complete} style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }

  const getCertificate = async () => {
    setIssuing(true);
    setError(null);
    try {
      // The PDF is signed server-side and handed back as a short-lived URL, the
      // same delivery path as any other asset.
      const { url } = await courseApi.getCertificate(courseId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      setError('The certificate could not be opened. Try again in a moment.');
    } finally {
      setIssuing(false);
    }
  };

  return (
    <div className="cv cv-progress__card">
      <div className="cv-progress">
        <div className="cv-progress__head">
          <strong>{complete ? 'You finished this course' : 'Your progress'}</strong>
          <span className="cv-progress__value">{percent}%</span>
        </div>
        <div
          className="cv-progress__track"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Course progress"
        >
          <div className="cv-progress__fill" data-complete={complete} style={{ width: `${percent}%` }} />
        </div>
      </div>

      <dl className="cv-progress__stats">
        <div>
          <dt>Done</dt>
          <dd>
            {progress.completedCount}
            <span className="cv-muted" style={{ fontSize: 13 }}>
              /{progress.requiredCount}
            </span>
          </dd>
        </div>
        <div>
          <dt>Left</dt>
          <dd>{duration(progress.remainingMinutes) ?? '—'}</dd>
        </div>
        <div>
          <dt>Last opened</dt>
          <dd style={{ fontSize: 13 }}>
            {progress.lastActiveAt ? new Date(progress.lastActiveAt).toLocaleDateString() : '—'}
          </dd>
        </div>
      </dl>

      {progress.resume && !complete ? (
        <button type="button" className="cv-btn cv-btn--primary" onClick={() => onResume?.(progress.resume)}>
          {progress.resume.positionSeconds > 5 ? 'Carry on where you stopped' : 'Continue'}
          <span className="cv-muted" style={{ fontWeight: 400 }}>
            — {progress.resume.lessonTitle}
          </span>
        </button>
      ) : null}

      {complete ? (
        <div className="cv-cert">
          <strong>Certificate</strong>
          {progress.certificateAvailable ? (
            <>
              <p className="cv-note">
                Signed and issued in {enrollment?.completedAt
                  ? new Date(enrollment.completedAt).toLocaleDateString()
                  : 'your name'}
                . The same file can be downloaded again at any time.
              </p>
              <button type="button" className="cv-btn" disabled={issuing} onClick={getCertificate}>
                {issuing ? 'Preparing…' : 'Open certificate'}
              </button>
            </>
          ) : (
            <p className="cv-note">
              {course?.certificateEnabled === false
                ? 'This course does not issue a certificate.'
                : 'Being generated — it usually takes a minute.'}
            </p>
          )}
        </div>
      ) : null}

      {error ? <p className="cv-note cv-note--danger">{error}</p> : null}
    </div>
  );
}