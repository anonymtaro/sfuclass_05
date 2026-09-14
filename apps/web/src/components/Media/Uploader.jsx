import { useEffect, useRef, useState } from 'react';
import { useUpload } from '@classroom/core-client';
import UploadProgressRow from '../Chat/UploadProgressRow.jsx';
import StorageQuotaBar from '../Billing/StorageQuotaBar.jsx';
import './media.css';

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

/**
 * The upload surface for anything large: course videos, documents, submissions.
 *
 * Nothing here talks to the API with the file. useUpload presigns a multipart
 * upload, the browser sends the parts straight to the raw bucket, and the object
 * lands in quarantine until AntivirusScan promotes it. The API never carries
 * bytes, which is why a 2 GB file does not need a request timeout raised
 * anywhere.
 *
 * Resumability is the point of the part-by-part progress: a dropped connection
 * continues from the last completed part rather than starting over. Closing the
 * tab mid-upload loses only the parts still in flight.
 *
 * The quota bar is the compact variant of the billing component, so what it says
 * is exactly what StorageGuard will decide when the next presign is asked for.
 */
export default function Uploader({
  scope,
  accept,
  multiple = true,
  maxBytes = null,
  showQuota = true,
  title = 'Drop files here',
  hint = 'Large files are uploaded in parts and continue after a dropped connection.',
  onComplete,
  disabled = false,
}) {
  const inputRef = useRef(null);
  const [dropping, setDropping] = useState(false);
  const [rejected, setRejected] = useState([]);

  const { uploads, enqueue, cancel, retry, clear } = useUpload({ scope });

  // Fire once per asset that reaches ready, so the caller can attach it.
  const reported = useRef(new Set());
  useEffect(() => {
    for (const u of uploads) {
      if (u.state === 'ready' && u.assetId && !reported.current.has(u.assetId)) {
        reported.current.add(u.assetId);
        onComplete?.({ id: u.assetId, filename: u.filename, size: u.size, status: 'ready' });
      }
    }
  }, [uploads, onComplete]);

  const take = (fileList) => {
    const files = Array.from(fileList ?? []);
    if (!files.length || disabled) return;

    const bad = [];
    const good = files.filter((f) => {
      if (maxBytes && f.size > maxBytes) {
        bad.push(`${f.name} is larger than ${humanSize(maxBytes)}`);
        return false;
      }
      if (accept && !new RegExp(accept.replace(/\*/g, '.*').replace(/,/g, '|')).test(f.type)) {
        bad.push(`${f.name} is not a supported type`);
        return false;
      }
      return true;
    });

    setRejected(bad);
    if (good.length) enqueue(multiple ? good : good.slice(0, 1));
  };

  const active = uploads.filter((u) => u.state !== 'ready');
  const done = uploads.filter((u) => u.state === 'ready');

  return (
    <div className="md md-uploader">
      {showQuota ? <StorageQuotaBar variant="compact" showUpgrade={false} /> : null}

      <div
        className="md-drop"
        data-dropping={dropping}
        data-disabled={disabled}
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDropping(false);
          take(e.dataTransfer.files);
        }}
      >
        <p className="md-drop__title">{title}</p>
        <p className="md-note">{hint}</p>

        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          hidden
          disabled={disabled}
          onChange={(e) => {
            take(e.target.files);
            e.target.value = '';
          }}
        />

        <button
          type="button"
          className="md-btn"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          Choose {multiple ? 'files' : 'a file'}
        </button>

        {maxBytes ? <p className="md-note">Up to {humanSize(maxBytes)} each.</p> : null}
      </div>

      {rejected.length ? (
        <ul className="md-note md-note--danger" style={{ margin: 0, paddingInlineStart: 18 }}>
          {rejected.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}

      {uploads.length ? (
        <div className="md-queue">
          {uploads.map((u) => (
            <UploadProgressRow key={u.id} upload={u} onCancel={cancel} onRetry={retry} />
          ))}
        </div>
      ) : null}

      {done.length && !active.length ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="md-note">
            {done.length} file{done.length === 1 ? '' : 's'} ready.
          </span>
          <button
            type="button"
            className="md-btn md-btn--ghost"
            onClick={() => {
              reported.current.clear();
              clear();
            }}
          >
            Clear the list
          </button>
        </div>
      ) : null}
    </div>
  );
}