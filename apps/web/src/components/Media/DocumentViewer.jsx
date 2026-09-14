import { useEffect, useState } from 'react';
import { mediaApi } from '@classroom/core-client';
import './media.css';

/**
 * Renders a document without ever giving the browser a permanent link.
 *
 * The URL is minted per view by DownloadService, expires quickly and is recorded
 * in the audit log, so a link copied out of the devtools network tab is worthless
 * an hour later. That is also why the signature is refreshed rather than reused
 * when someone leaves a long PDF open — a re-render asks for a new one.
 *
 * Attachments are served from the delivery origin, never from the app domain, so
 * an uploaded HTML or SVG file cannot execute anything against a logged-in
 * session.
 */
export default function DocumentViewer({ assetId, filename: initialName, height = 520 }) {
  const [asset, setAsset] = useState(null);
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);

    (async () => {
      try {
        const meta = await mediaApi.getAsset(assetId);
        if (cancelled) return;
        setAsset(meta);

        if (meta.status !== 'ready') return;

        const signed = await mediaApi.signDownload(assetId, { disposition: 'inline' });
        if (!cancelled) setUrl(signed.url);
      } catch {
        if (!cancelled) setError('This document could not be opened.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assetId]);

  const name = asset?.filename ?? initialName ?? 'Document';
  const type = asset?.contentType ?? '';

  const download = async () => {
    try {
      const { url: dl } = await mediaApi.signDownload(assetId, { disposition: 'attachment' });
      window.open(dl, '_blank', 'noopener,noreferrer');
    } catch {
      setError('The download could not be started.');
    }
  };

  if (asset && asset.status === 'rejected') {
    return (
      <div className="md md-doc__fallback">
        <p className="md-note md-note--danger">
          {name} was blocked by the virus scan and cannot be opened.
        </p>
      </div>
    );
  }

  if (asset && asset.status !== 'ready') {
    return (
      <div className="md md-doc__fallback">
        <span className="md-state" data-state={asset.status}>
          {asset.status}
        </span>
        <p className="md-note">
          {asset.status === 'scanning'
            ? 'Being scanned. This usually takes a few seconds.'
            : 'Still processing. It will open once it is ready.'}
        </p>
      </div>
    );
  }

  return (
    <div className="md md-doc">
      <div className="md-doc__bar">
        <span className="md-doc__name" title={name}>
          {name}
        </span>
        <button type="button" className="md-btn md-btn--ghost" onClick={download}>
          Download
        </button>
      </div>

      {error ? <p className="md-note md-note--danger" style={{ padding: 12 }}>{error}</p> : null}

      {!url && !error ? <p className="md-note" style={{ padding: 12 }}>Loading…</p> : null}

      {url && type === 'application/pdf' ? (
        <iframe className="md-doc__frame" style={{ height }} src={url} title={name} />
      ) : null}

      {url && type.startsWith('image/') ? (
        <img className="md-doc__image" src={url} alt={name} style={{ maxHeight: height }} />
      ) : null}

      {url && type.startsWith('text/') ? (
        // Sandboxed: a text or markup file is content, not code, and it arrives
        // from a different origin precisely so it cannot act like code.
        <iframe
          className="md-doc__frame"
          style={{ height }}
          src={url}
          title={name}
          sandbox=""
        />
      ) : null}

      {url && !type.startsWith('image/') && !type.startsWith('text/') && type !== 'application/pdf' ? (
        <div className="md-doc__fallback">
          <p className="md-note">This file type cannot be shown in the browser.</p>
          <button type="button" className="md-btn md-btn--primary" onClick={download}>
            Download {name}
          </button>
        </div>
      ) : null}
    </div>
  );
}