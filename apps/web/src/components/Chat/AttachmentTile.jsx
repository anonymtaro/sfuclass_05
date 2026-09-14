import { useCallback, useState } from 'react';
import { mediaApi } from '@classroom/core-client';
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

/**
 * A chat attachment is an ordinary Asset. It went through the same quota gate,
 * the same quarantine bucket and the same scanner as a course video, and it is
 * delivered the same way: a short-lived signed CloudFront URL, minted per click
 * by DownloadService.js and written to the audit log.
 *
 * Because the URL expires, it is fetched on demand rather than embedded in the
 * message payload — a copied link dies quickly and cannot be passed around.
 * Images and PDFs preview inline; everything else is a download tile.
 */
export default function AttachmentTile({ attachment, compact = false }) {
  const { id, filename, contentType, size, status, thumbnailUrl } = attachment;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [inlineUrl, setInlineUrl] = useState(null);

  const isImage = contentType?.startsWith('image/');
  const isPdf = contentType === 'application/pdf';

  const openSigned = useCallback(
    async (mode) => {
      setBusy(true);
      setError(null);
      try {
        const { url } = await mediaApi.signDownload(id, { disposition: mode });
        if (mode === 'inline') setInlineUrl(url);
        else window.open(url, '_blank', 'noopener,noreferrer');
      } catch {
        setError('That link could not be opened. Try again in a moment.');
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  if (status === 'rejected') {
    return (
      <div className={`ch ch-attach${compact ? ' ch-attach--compact' : ''}`}>
        <p className="ch-attach__state ch-attach__state--blocked">
          {filename} was blocked by the virus scan and is not available.
        </p>
      </div>
    );
  }

  if (status !== 'ready') {
    return (
      <div className={`ch ch-attach${compact ? ' ch-attach--compact' : ''}`}>
        <p className="ch-attach__state">
          {filename} — {status === 'scanning' ? 'being scanned' : 'still processing'}
        </p>
      </div>
    );
  }

  return (
    <div className={`ch ch-attach${compact ? ' ch-attach--compact' : ''}`}>
      {isImage ? (
        <img
          className="ch-attach__preview"
          src={inlineUrl ?? thumbnailUrl}
          alt={filename}
          loading="lazy"
          decoding="async"
          onClick={() => openSigned('attachment')}
        />
      ) : null}

      {isPdf && inlineUrl ? (
        <iframe className="ch-attach__pdf" src={inlineUrl} title={filename} />
      ) : null}

      <div className="ch-attach__meta">
        <span className="ch-attach__name" title={filename}>
          {filename}
        </span>
        <span className="ch-attach__size">{humanSize(size)}</span>

        {isPdf && !inlineUrl ? (
          <button
            type="button"
            className="ch-btn ch-btn--ghost"
            disabled={busy}
            onClick={() => openSigned('inline')}
          >
            Preview
          </button>
        ) : null}

        <button
          type="button"
          className="ch-btn"
          disabled={busy}
          onClick={() => openSigned('attachment')}
        >
          {busy ? 'Preparing…' : 'Download'}
        </button>
      </div>

      {error ? <p className="ch-attach__state ch-attach__state--blocked">{error}</p> : null}
    </div>
  );
}