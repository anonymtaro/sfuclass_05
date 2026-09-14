import './chat.css';

const UNITS = ['B', 'KB', 'MB', 'GB'];

function humanSize(bytes = 0) {
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${UNITS[i]}`;
}

const STATE_TEXT = {
  queued: 'Waiting for a slot',
  presigning: 'Asking for an upload slot',
  uploading: null,
  scanning: 'Scanning for malware',
  processing: 'Processing',
  ready: 'Ready',
  quota: 'Not enough storage left on this plan',
  rejected: 'Blocked by the virus scan',
  failed: 'Upload failed',
};

/**
 * One row per in-flight upload, driven by useUpload() in core-client.
 *
 * The states mirror the server pipeline exactly — presign → direct-to-S3
 * multipart → quarantine → AntivirusScan → ready — because a person watching a
 * 2 GB file needs to know the difference between "still uploading" and "uploaded,
 * now being scanned". Progress is per completed chunk, so a dropped connection
 * resumes from the last part instead of restarting at zero.
 */
export default function UploadProgressRow({ upload, onCancel, onRetry }) {
  const { id, filename, size, uploadedBytes = 0, state, error } = upload;
  const pct = size ? Math.min(100, Math.round((uploadedBytes / size) * 100)) : 0;
  const isError = state === 'failed' || state === 'rejected' || state === 'quota';
  const note = STATE_TEXT[state];

  return (
    <div className="ch ch-upload" role="group" aria-label={`Upload: ${filename}`}>
      <div className="ch-upload__main">
        <span className="ch-upload__name">{filename}</span>

        <div
          className="ch-upload__bar"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={note ?? `${pct}%`}
        >
          <div
            className={`ch-upload__fill${isError ? ' ch-upload__fill--error' : ''}`}
            style={{ width: `${isError ? 100 : pct}%` }}
          />
        </div>

        <span className="ch-upload__size">
          {isError
            ? error ?? note
            : note ?? `${humanSize(uploadedBytes)} of ${humanSize(size)}`}
        </span>
      </div>

      {isError && state === 'failed' ? (
        <button type="button" className="ch-btn ch-btn--ghost" onClick={() => onRetry?.(id)}>
          Retry
        </button>
      ) : null}

      {state !== 'ready' ? (
        <button
          type="button"
          className="ch-btn ch-btn--ghost"
          onClick={() => onCancel?.(id)}
          aria-label={`Cancel upload of ${filename}`}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}