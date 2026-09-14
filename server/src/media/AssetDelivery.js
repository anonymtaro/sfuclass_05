// classroom-app/server/src/media/AssetDelivery.js
/**
 * Signed delivery  (F4)  [NEW]
 *
 * Every byte a user reads comes through a CloudFront URL signed here, valid for
 * CDN_SIGNED_URL_TTL_SEC — five minutes by default.
 *
 * Short on purpose. A signed URL is a bearer token: anyone holding it can read
 * the file, and people paste links into chats without thinking. Five minutes is
 * long enough to start a download and short enough that a pasted link is
 * already dead.
 *
 * HLS is the awkward case. A manifest references dozens of segment files, and
 * signing each one individually would mean rewriting the manifest on every
 * request. Signed *cookies* solve it: one signature covers a path prefix, the
 * player fetches segments normally, and the cookie expires with the session.
 */

import { createSign } from 'node:crypto';
import { delivery } from '../config/storage.config.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'delivery' });

// ---------------------------------------------------------------------------
// Policies  (pure)
// ---------------------------------------------------------------------------

/** CloudFront's base64 variant: +/= are not URL-safe. */
export const cfBase64 = (input) =>
  Buffer.from(input).toString('base64').replaceAll('+', '-').replaceAll('=', '_').replaceAll('/', '~');

/** One resource, one expiry. The cheap case. */
export const cannedPolicy = (url, expiresAtEpoch) =>
  JSON.stringify({
    Statement: [{ Resource: url, Condition: { DateLessThan: { 'AWS:EpochTime': expiresAtEpoch } } }],
  });

/**
 * A wildcard over a prefix, for HLS. `*` covers the manifest and every segment
 * under it, which is what makes one signature enough for a whole video.
 */
export const customPolicy = (resourcePattern, expiresAtEpoch, sourceIp = null) =>
  JSON.stringify({
    Statement: [
      {
        Resource: resourcePattern,
        Condition: {
          DateLessThan: { 'AWS:EpochTime': expiresAtEpoch },
          // Binding to an IP breaks anyone moving between wifi and mobile data
          // mid-lecture, so it is off unless a caller asks for it.
          ...(sourceIp ? { IpAddress: { 'AWS:SourceIp': sourceIp } } : {}),
        },
      },
    ],
  });

const sign = (policy) => {
  if (!delivery.privateKey || !delivery.keyPairId) {
    return null;
  }
  const signer = createSign('RSA-SHA1');
  signer.update(policy);
  return signer.sign(delivery.privateKey, 'base64')
    .replaceAll('+', '-')
    .replaceAll('=', '_')
    .replaceAll('/', '~');
};

const origin = () =>
  delivery.cdnDomain.startsWith('http') ? delivery.cdnDomain : `https://${delivery.cdnDomain}`;

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * A signed URL for one object.
 *
 * With no key pair configured — development against MinIO — it returns an
 * unsigned URL rather than failing. The bucket is not public in production, so
 * this cannot silently weaken a real deployment: there, a missing key pair is
 * already a boot failure in config/env.js.
 */
export const signUrl = ({ key, ttlSec = delivery.signedUrlTtlSec, disposition = null, fileName = null }) => {
  const base = `${origin()}/${key}`;

  // Built by hand rather than with URLSearchParams: that encodes a space as
  // '+', and a '+' inside response-content-disposition reaches the browser as
  // a literal plus, so "My Notes.pdf" downloads as "My+Notes.pdf".
  let url = base;
  if (disposition) {
    const value = `${disposition}; filename="${(fileName ?? 'file').replaceAll('"', '')}"`;
    url = `${base}?response-content-disposition=${encodeURIComponent(value)}`;
  }
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;

  const signature = sign(cannedPolicy(url, expiresAt));
  if (!signature) return { url, expiresAt: new Date(expiresAt * 1000).toISOString(), signed: false };

  const separator = url.includes('?') ? '&' : '?';
  return {
    url: `${url}${separator}Expires=${expiresAt}&Signature=${signature}&Key-Pair-Id=${delivery.keyPairId}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    signed: true,
  };
};

/**
 * Cookies covering an HLS prefix. The client sets these, then fetches the
 * manifest and its segments as ordinary requests.
 */
export const signPlaybackCookies = ({ prefix, ttlSec = delivery.signedUrlTtlSec * 12 }) => {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  const pattern = `${origin()}/${prefix}/*`;
  const policy = customPolicy(pattern, expiresAt);
  const signature = sign(policy);

  if (!signature) return { cookies: {}, expiresAt: new Date(expiresAt * 1000).toISOString(), signed: false };

  return {
    cookies: {
      'CloudFront-Policy': cfBase64(policy),
      'CloudFront-Signature': signature,
      'CloudFront-Key-Pair-Id': delivery.keyPairId,
    },
    // Longer than a plain URL: a two-hour lecture must not stop halfway.
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    signed: true,
  };
};

// ---------------------------------------------------------------------------
// Decoration
// ---------------------------------------------------------------------------

/**
 * Attaches the URLs an asset needs to be rendered. Called on every single-asset
 * read — never in a list, because signing forty URLs for a media library page
 * that will display four thumbnails is waste.
 */
export const decorate = ({ asset, ttlSec }) => {
  if (!asset || asset.status !== 'ready') return asset;

  const prefix = asset.objectKey.replace(/\/[^/]+$/, '');
  const isHls = asset.objectKey.endsWith('.m3u8');

  const decorated = {
    ...asset,
    downloadUrl: signUrl({
      key: asset.objectKey,
      ttlSec,
      disposition: 'attachment',
      fileName: asset.fileName,
    }).url,
  };

  if (asset.kind === 'video' || asset.kind === 'audio') {
    decorated.playbackUrl = signUrl({ key: asset.objectKey, ttlSec }).url;
    decorated.thumbnailUrl = signUrl({ key: `${prefix}/thumb/poster.0000000.jpg`, ttlSec }).url;
    // The player needs the cookies too when the manifest is HLS.
    decorated.playbackCookies = isHls ? signPlaybackCookies({ prefix }) : null;
  }

  if (asset.kind === 'image') {
    decorated.thumbnailUrl = signUrl({ key: asset.objectKey, ttlSec }).url;
  }

  decorated.captions = (asset.captions ?? []).map((track) => ({
    language: track.language,
    label: track.label,
    url: signUrl({ key: track.key, ttlSec }).url,
    source: track.source,
  }));

  return decorated;
};

/**
 * Thumbnails only, for a list. One short signature per row instead of four.
 */
export const decorateMany = (assets, { ttlSec } = {}) =>
  assets.map((asset) =>
    asset.status === 'ready' && (asset.kind === 'image' || asset.kind === 'video')
      ? {
          ...asset,
          thumbnailUrl: signUrl({
            key:
              asset.kind === 'image'
                ? asset.objectKey
                : `${asset.objectKey.replace(/\/[^/]+$/, '')}/thumb/poster.0000000.jpg`,
            ttlSec,
          }).url,
        }
      : asset,
  );

/** Warns once at boot if delivery is unsigned where it should not be. */
export const checkConfiguration = () => {
  if (!delivery.keyPairId || !delivery.privateKey) {
    log.warn('no CloudFront key pair configured; delivery URLs will be unsigned');
    return false;
  }
  return true;
};

export default { signUrl, signPlaybackCookies, decorate, decorateMany, cannedPolicy, customPolicy };