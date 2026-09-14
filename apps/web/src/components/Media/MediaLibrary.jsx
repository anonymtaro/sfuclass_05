import { useCallback, useEffect, useRef, useState } from 'react';
import { mediaApi } from '@classroom/core-client';
import Uploader from './Uploader.jsx';
import './media.css';

const KINDS = [
  { id: 'all', label: 'Everything' },
  { id: 'video', label: 'Video' },
  { id: 'document', label: 'Documents' },
  { id: 'image', label: 'Images' },
  { id: 'audio', label: 'Audio' },
];

const KIND_ICON = { video: '▶', document: '📄', image: '🖼', audio: '♪', other: '📦' };

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

function clock(seconds) {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/**
 * Everything the tenant has uploaded, in one place, with two jobs.
 *
 * `mode="page"` is the library: browse, search, delete.
 * `mode="picker"` is the modal LessonInspector and the composer open to attach
 * something that already exists — which is the point of having a library at all.
 * Reusing an asset costs no storage and no transcode.
 *
 * Only `ready` assets can be picked. A file that is still scanning or
 * transcoding is shown with its state rather than hidden, because "where did my
 * upload go" is the question this avoids.
 */
export default function MediaLibrary({
  mode = 'page',
  accept = null,
  kind: initialKind = 'all',
  onPick,
  onClose,
}) {
  const dialogRef = useRef(null);
  const [tab, setTab] = useState('browse');
  const [kind, setKind] = useState(initialKind);
  const [query, setQuery] = useState('');
  const [assets, setAssets] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  const isPicker = mode === 'picker';

  useEffect(() => {
    if (!isPicker) return;
    const el = dialogRef.current;
    if (el && !el.open) el.showModal();
  }, [isPicker]);

  const load = useCallback(
    async (opts = {}) => {
      setLoading(true);
      setError(null);
      try {
        const page = await mediaApi.listAssets({
          kind: kind === 'all' ? undefined : kind,
          query: query.trim() || undefined,
          cursor: opts.cursor ?? undefined,
          limit: 30,
        });
        setAssets((prev) => (opts.cursor ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor ?? null);
      } catch {
        setError('The library could not be loaded.');
      } finally {
        setLoading(false);
      }
    },
    [kind, query],
  );

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => load(), 250);
    return () => window.clearTimeout(id);
  }, [load]);

  const pick = (asset) => {
    if (asset.status !== 'ready') return;
    setSelected(asset.id);
    onPick?.(asset);
  };

  const remove = async (asset) => {
    const warning = asset.usageCount
      ? `${asset.filename} is used in ${asset.usageCount} lesson(s) or message(s). Deleting it breaks them. Continue?`
      : `Delete ${asset.filename}?`;
    if (!window.confirm(warning)) return;

    try {
      await mediaApi.deleteAsset(asset.id);
      setAssets((prev) => prev.filter((a) => a.id !== asset.id));
    } catch {
      setError('That file could not be deleted.');
    }
  };

  const body = (
    <>
      <header className="md-library__head">
        <p className="md-library__title">{isPicker ? 'Choose a file' : 'Media library'}</p>

        <span style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            className={`md-btn${tab === 'browse' ? ' md-btn--primary' : ' md-btn--ghost'}`}
            onClick={() => setTab('browse')}
          >
            Library
          </button>
          <button
            type="button"
            className={`md-btn${tab === 'upload' ? ' md-btn--primary' : ' md-btn--ghost'}`}
            onClick={() => setTab('upload')}
          >
            Upload
          </button>
        </span>

        {isPicker ? (
          <button type="button" className="md-btn md-btn--ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        ) : null}
      </header>

      {tab === 'browse' ? (
        <>
          <div className="md-library__head" style={{ borderBottom: 0 }}>
            <input
              className="md-input"
              type="search"
              value={query}
              placeholder="Search by name"
              aria-label="Search by name"
              style={{ flex: '1 1 auto' }}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              className="md-select"
              value={kind}
              aria-label="Filter by type"
              onChange={(e) => setKind(e.target.value)}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>

          <div className="md-library__body">
            {error ? <p className="md-note md-note--danger">{error}</p> : null}

            {!loading && assets.length === 0 ? (
              <p className="md-empty">
                {query ? `Nothing matches “${query}”.` : 'Nothing uploaded yet.'}
              </p>
            ) : null}

            <div className="md-grid">
              {assets.map((asset) => {
                const pickable = !isPicker || asset.status === 'ready';
                return (
                  <button
                    key={asset.id}
                    type="button"
                    className="md-asset"
                    aria-selected={asset.id === selected}
                    disabled={!pickable}
                    onClick={() => (isPicker ? pick(asset) : setSelected(asset.id))}
                  >
                    <span className="md-asset__thumb">
                      {asset.thumbnailUrl ? (
                        <img src={asset.thumbnailUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="md-asset__kind" aria-hidden="true">
                          {KIND_ICON[asset.kind] ?? KIND_ICON.other}
                        </span>
                      )}
                      {asset.durationSeconds ? (
                        <span className="md-asset__duration">{clock(asset.durationSeconds)}</span>
                      ) : null}
                    </span>

                    <span className="md-asset__meta">
                      <span className="md-asset__name" title={asset.filename}>
                        {asset.filename}
                      </span>
                      <span className="md-asset__sub">
                        {humanSize(asset.size)}
                        {asset.usageCount ? ` · used ${asset.usageCount}×` : ''}
                      </span>
                      {asset.status !== 'ready' ? (
                        <span className="md-state" data-state={asset.status}>
                          {asset.status}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>

            {cursor ? (
              <button
                type="button"
                className="md-btn"
                style={{ marginTop: 12 }}
                disabled={loading}
                onClick={() => load({ cursor })}
              >
                {loading ? 'Loading…' : 'Show more'}
              </button>
            ) : null}
          </div>

          {!isPicker && selected ? (
            <div className="md-library__foot" style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="md-btn"
                onClick={async () => {
                  const asset = assets.find((a) => a.id === selected);
                  const { url } = await mediaApi.signDownload(asset.id, { disposition: 'attachment' });
                  window.open(url, '_blank', 'noopener,noreferrer');
                }}
              >
                Download
              </button>
              <button
                type="button"
                className="md-btn md-btn--danger"
                onClick={() => remove(assets.find((a) => a.id === selected))}
              >
                Delete
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="md-library__body">
          <Uploader
            scope={{ type: 'library' }}
            accept={accept}
            onComplete={(asset) => {
              // A finished upload joins the list immediately, and in a picker it
              // is usually the thing the person came to choose.
              setAssets((prev) => [asset, ...prev]);
              if (isPicker) {
                setTab('browse');
                pick(asset);
              }
            }}
          />
        </div>
      )}
    </>
  );

  if (!isPicker) {
    return (
      <section className="md md-library" aria-label="Media library">
        {body}
      </section>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      className="md md-dialog"
      aria-label="Choose a file"
      onClose={() => onClose?.()}
      onCancel={(e) => {
        e.preventDefault();
        onClose?.();
      }}
    >
      <div className="md-dialog__inner md-library" style={{ border: 0, borderRadius: 0 }}>
        {body}
      </div>
    </dialog>
  );
}