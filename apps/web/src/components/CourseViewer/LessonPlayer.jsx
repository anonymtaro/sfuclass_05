import { useCallback, useEffect, useRef, useState } from 'react';
import { LessonTypes } from '@classroom/contracts';
import { mediaApi, useCurriculum } from '@classroom/core-client';
import DocumentViewer from '../Media/DocumentViewer.jsx';
import AssignmentSubmit from '../Media/AssignmentSubmit.jsx';
import './viewer.css';

const SAVE_EVERY_MS = 10_000;
const COMPLETE_AT = 0.95;

function clock(seconds = 0) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The lesson itself.
 *
 * Video is the involved case and the reason this file exists: an HLS ladder
 * produced by MediaConvert, captions produced by Transcribe, both delivered as
 * short-lived signed CloudFront URLs. Safari plays HLS natively; everywhere else
 * hls.js is loaded on demand so people reading a document never download a video
 * engine.
 *
 * Two things are saved as someone watches. Position, throttled, so closing the
 * tab and coming back lands in the right place — and completion, which is either
 * reaching the end (when the author required it) or opening the lesson at all.
 * Both go through ProgressService; nothing about completion is decided here.
 *
 * The other four types are thin on purpose: a document is the media domain's
 * viewer, a task is the assignment component, a live lesson is a door into a
 * classroom. This component routes to them rather than reimplementing them.
 */
export default function LessonPlayer({ courseId, lessonId, onJoinLive, onStartQuiz }) {
  const { lesson, progressFor, recordPosition, markComplete } = useCurriculum(courseId, { lessonId });

  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const lastSaved = useRef(0);

  const [source, setSource] = useState(null);
  const [error, setError] = useState(null);
  const [levels, setLevels] = useState([]);
  const [level, setLevel] = useState(-1);
  const [position, setPosition] = useState(0);

  const saved = progressFor?.(lessonId) ?? null;
  const isVideo = lesson?.type === LessonTypes.VIDEO;

  /* ---------- signed source ---------- */

  const sign = useCallback(async () => {
    if (!lesson?.assetId) return null;
    const s = await mediaApi.signPlayback(lesson.assetId);
    setSource(s);
    return s;
  }, [lesson?.assetId]);

  useEffect(() => {
    if (!isVideo) return undefined;
    let cancelled = false;
    setError(null);
    setSource(null);

    sign().catch(() => !cancelled && setError('This video could not be opened. Try reloading.'));

    return () => {
      cancelled = true;
    };
  }, [isVideo, sign]);

  /* ---------- attach ---------- */

  useEffect(() => {
    const video = videoRef.current;
    if (!isVideo || !video || !source?.hlsUrl) return undefined;

    let disposed = false;

    const attach = async () => {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = source.hlsUrl;
        return;
      }

      const { default: Hls } = await import('hls.js');
      if (disposed) return;

      if (!Hls.isSupported()) {
        setError('This browser cannot play the lesson video.');
        return;
      }

      const hls = new Hls({ capLevelToPlayerSize: true, startLevel: -1 });
      hlsRef.current = hls;
      hls.loadSource(source.hlsUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) =>
        setLevels(data.levels.map((l, i) => ({ index: i, height: l.height, bitrate: l.bitrate }))),
      );

      hls.on(Hls.Events.ERROR, async (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // The most likely cause is an expired signature, not a dead network.
          try {
            const fresh = await sign();
            if (fresh?.hlsUrl) return hls.loadSource(fresh.hlsUrl);
          } catch {
            /* falls through to the message below */
          }
          hls.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
        setError('Playback stopped. Reload the lesson to try again.');
      });
    };

    attach();

    return () => {
      disposed = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [isVideo, source?.hlsUrl, sign]);

  /* ---------- resume ---------- */

  useEffect(() => {
    const video = videoRef.current;
    if (!isVideo || !video || !saved?.positionSeconds) return;
    const onReady = () => {
      // Back up a couple of seconds: people rejoin a sentence, not a frame.
      video.currentTime = Math.max(0, saved.positionSeconds - 3);
      video.removeEventListener('loadedmetadata', onReady);
    };
    video.addEventListener('loadedmetadata', onReady);
    return () => video.removeEventListener('loadedmetadata', onReady);
  }, [isVideo, saved?.positionSeconds, source?.hlsUrl]);

  /* ---------- position and completion ---------- */

  const save = useCallback(
    (seconds, opts = {}) => {
      const now = Date.now();
      if (!opts.force && now - lastSaved.current < SAVE_EVERY_MS) return;
      lastSaved.current = now;
      recordPosition(lessonId, Math.floor(seconds));
    },
    [recordPosition, lessonId],
  );

  useEffect(() => {
    if (!isVideo) return undefined;
    const flush = () => {
      const video = videoRef.current;
      if (video && video.currentTime > 0) save(video.currentTime, { force: true });
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      flush();
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [isVideo, save]);

  // A lesson that does not have to be watched through counts as done on opening.
  useEffect(() => {
    if (!lesson || lesson.state === 'complete') return;
    if (lesson.type === LessonTypes.VIDEO && lesson.requireFullWatch) return;
    if (lesson.type === LessonTypes.QUIZ || lesson.type === LessonTypes.TASK) return;
    markComplete(lessonId);
  }, [lesson, lessonId, markComplete]);

  if (!lesson) return <p className="cv cv-empty">Pick a lesson to start.</p>;

  if (lesson.locked) {
    return (
      <div className="cv cv-locked">
        <strong>This lesson is not open yet</strong>
        <p className="cv-note">{lesson.lockReason ?? 'Finish the earlier modules first.'}</p>
      </div>
    );
  }

  return (
    <article className="cv cv-player">
      <header className="cv-lessonhead">
        <h1 className="cv-lessonhead__title">{lesson.title}</h1>
        <p className="cv-lessonhead__meta">
          {lesson.moduleTitle}
          {lesson.state === 'complete' ? <span className="cv-tag cv-tag--done">done</span> : null}
          {lesson.type === LessonTypes.LIVE ? <span className="cv-tag cv-tag--live">live</span> : null}
        </p>
      </header>

      {lesson.summary ? <p className="cv-body">{lesson.summary}</p> : null}

      {isVideo ? (
        <>
          <div className="cv-stage">
            <video
              ref={videoRef}
              controls
              playsInline
              preload="metadata"
              poster={source?.posterUrl}
              crossOrigin="anonymous"
              onTimeUpdate={(e) => {
                setPosition(e.currentTarget.currentTime);
                save(e.currentTarget.currentTime);
              }}
              onPause={(e) => save(e.currentTarget.currentTime, { force: true })}
              onEnded={(e) => {
                save(e.currentTarget.duration, { force: true });
                markComplete(lessonId);
              }}
              onProgress={(e) => {
                const v = e.currentTarget;
                if (
                  lesson.requireFullWatch &&
                  lesson.state !== 'complete' &&
                  v.duration &&
                  v.currentTime / v.duration >= COMPLETE_AT
                ) {
                  markComplete(lessonId);
                }
              }}
            >
              {source?.captions?.map((c) => (
                <track
                  key={c.lang}
                  kind="captions"
                  src={c.url}
                  srcLang={c.lang}
                  label={c.label}
                  default={c.default}
                />
              ))}
            </video>

            {error ? (
              <div className="cv-stage__overlay">
                <p className="cv-note cv-note--danger">{error}</p>
              </div>
            ) : null}

            {!source && !error ? (
              <div className="cv-stage__overlay">
                <p className="cv-note">
                  {lesson.assetStatus && lesson.assetStatus !== 'ready'
                    ? 'This video is still being processed. It will play once it is ready.'
                    : 'Loading…'}
                </p>
              </div>
            ) : null}
          </div>

          <div className="cv-playerbar">
            <span className="cv-note">
              {clock(position)}
              {videoRef.current?.duration ? ` / ${clock(videoRef.current.duration)}` : ''}
            </span>

            <span className="cv-playerbar__spacer" />

            {source?.captions?.length ? (
              <span className="cv-note">
                {source.captions.length} caption track(s) — use the player's own captions menu
              </span>
            ) : (
              <span className="cv-note">Captions are still being generated</span>
            )}

            {levels.length > 1 ? (
              <label className="cv-note">
                Quality{' '}
                <select
                  className="cv-select"
                  value={level}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setLevel(next);
                    if (hlsRef.current) hlsRef.current.currentLevel = next;
                  }}
                >
                  <option value={-1}>Auto</option>
                  {levels.map((l) => (
                    <option key={l.index} value={l.index}>
                      {l.height}p
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </>
      ) : null}

      {lesson.type === LessonTypes.DOC ? (
        <div className="cv-stage cv-stage__doc">
          {lesson.assetId ? (
            <DocumentViewer assetId={lesson.assetId} />
          ) : (
            <p className="cv-body" style={{ padding: 16 }}>
              {lesson.body}
            </p>
          )}
        </div>
      ) : null}

      {lesson.type === LessonTypes.LIVE ? (
        <div className="cv-panel cv-panel--live">
          <strong>
            {lesson.scheduledAt
              ? new Date(lesson.scheduledAt).toLocaleString(undefined, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : 'Time to be announced'}
          </strong>

          <p className="cv-note">
            {lesson.roomOpen
              ? 'The room is open.'
              : lesson.scheduledAt
                ? 'You can join from ten minutes before the start. A reminder goes out beforehand.'
                : 'Your teacher has not set a time yet.'}
          </p>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="cv-btn cv-btn--primary"
              disabled={!lesson.roomOpen}
              onClick={() => onJoinLive?.(lesson)}
            >
              {lesson.roomOpen ? 'Join the lesson' : 'Not open yet'}
            </button>

            {lesson.recordingAssetId ? (
              <button type="button" className="cv-btn" onClick={() => onJoinLive?.(lesson, { recording: true })}>
                Watch the recording
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {lesson.type === LessonTypes.QUIZ ? (
        <div className="cv-panel">
          <strong>
            {lesson.questionCount} question(s) · pass mark {lesson.passMark}%
          </strong>
          <p className="cv-note">
            {lesson.attemptsUsed
              ? `${lesson.attemptsUsed} of ${lesson.attempts} attempts used.`
              : `You have ${lesson.attempts} attempts.`}
            {lesson.bestScore != null ? ` Best so far: ${lesson.bestScore}%.` : ''}
          </p>
          <button
            type="button"
            className="cv-btn cv-btn--primary"
            disabled={lesson.attemptsUsed >= lesson.attempts}
            onClick={() => onStartQuiz?.(lesson)}
          >
            {lesson.attemptsUsed ? 'Try again' : 'Start the quiz'}
          </button>
        </div>
      ) : null}

      {lesson.type === LessonTypes.TASK ? <AssignmentSubmit lessonId={lessonId} /> : null}

      {lesson.state !== 'complete' &&
      (lesson.type === LessonTypes.DOC || (isVideo && lesson.requireFullWatch)) ? (
        <button type="button" className="cv-btn" onClick={() => markComplete(lessonId)}>
          Mark as done
        </button>
      ) : null}
    </article>
  );
}