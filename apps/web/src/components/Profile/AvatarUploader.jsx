import { useEffect, useRef, useState } from 'react';
import { profileApi, useUpload } from '@classroom/core-client';
import UploadProgressRow from '../Chat/UploadProgressRow.jsx';
import './profile.css';

const ACCEPT = 'image/png,image/jpeg,image/webp';
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * An avatar is not a special kind of file. It goes through the media domain like
 * a lesson video or a chat attachment: StorageGuard checks the quota, the client
 * uploads straight to the raw bucket against a presigned URL, the object lands in
 * quarantine, AntivirusScan promotes it, and only then does the asset become
 * ready.
 *
 * That is why the avatar is only attached to the profile once the upload
 * resolves to `ready` — a picture still sitting in quarantine can never be
 * someone's face in a lesson.
 *
 * The local preview is an object URL and is revoked; it is never what gets saved.
 */
export default function AvatarUploader({ currentUrl, onUploaded }) {
  const { uploads, enqueue, cancel, retry, clear } = useUpload({ scope: { type: 'avatar' } });
  const inputRef = useRef(null);

  const [preview, setPreview] = useState(null);
  const [dropping, setDropping] = useState(false);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  const active = uploads[0] ?? null;

  useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview]);

  // Attach as soon as the asset is scanned and ready.
  useEffect(() => {
    if (active?.state !== 'ready' || saving) return;
    let cancelled = false;
    setSaving(true);

    profileApi
      .setAvatar(active.assetId)
      .then((updated) => {
        if (cancelled) return;
        onUploaded?.(updated);
        setStatus({ text: 'Avatar updated.' });
        clear();
        setPreview(null);
      })
      .catch(() => !cancelled && setStatus({ error: true, text: 'The avatar could not be saved.' }))
      .finally(() => !cancelled && setSaving(false));

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.state, active?.assetId]);

  const take = (files) => {
    const file = files?.[0];
    if (!file) return;

    if (!ACCEPT.split(',').includes(file.type)) {
      return setStatus({ error: true, text: 'Use a PNG, JPEG or WebP image.' });
    }
    if (file.size > MAX_BYTES) {
      return setStatus({ error: true, text: 'That image is larger than 5 MB. Pick a smaller one.' });
    }

    setStatus(null);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
    clear();
    enqueue([file]);
  };

  const removeAvatar = async () => {
    setSaving(true);
    try {
      const updated = await profileApi.setAvatar(null);
      onUploaded?.(updated);
      setPreview(null);
      setStatus({ text: 'Avatar removed.' });
    } catch {
      setStatus({ error: true, text: 'The avatar could not be removed.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pf pf-uploader">
      <img
        className="pf-avatar pf-avatar--large"
        src={preview ?? currentUrl}
        alt="Your current avatar"
      />

      <div
        className="pf-uploader__drop"
        data-dropping={dropping}
        onDragOver={(e) => {
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
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            take(e.target.files);
            e.target.value = '';
          }}
        />

        <div className="pf-uploader__actions">
          <button
            type="button"
            className="pf-btn"
            disabled={saving}
            onClick={() => inputRef.current?.click()}
          >
            Choose a picture
          </button>
          {currentUrl ? (
            <button type="button" className="pf-btn pf-btn--ghost" disabled={saving} onClick={removeAvatar}>
              Remove
            </button>
          ) : null}
        </div>

        <span className="pf-field__hint">
          PNG, JPEG or WebP, up to 5 MB. Drop a file here if you prefer.
        </span>

        {active ? (
          <UploadProgressRow upload={active} onCancel={cancel} onRetry={retry} />
        ) : null}

        {saving && active?.state === 'ready' ? (
          <p className="pf-status pf-muted">Applying…</p>
        ) : null}

        {status ? (
          <p className={`pf-status${status.error ? ' pf-status--error' : ' pf-muted'}`}>
            {status.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}