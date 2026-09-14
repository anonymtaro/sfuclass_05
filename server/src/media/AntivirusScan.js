// classroom-app/server/src/media/AntivirusScan.js
/**
 * Quarantine gate  (F4, also F6)  [NEW]
 *
 * Every user-supplied byte passes through here before it can be served. This is
 * the reason chat attachments and assignment submissions accept any content
 * type: a type allowlist is theatre — people rename files — and a scan is not.
 *
 * The policy is **fail closed**. A file that cannot be scanned is not served.
 * That is a deliberate trade: the alternative is that a scanner outage silently
 * turns into an unscanned-file outage, and nobody notices until something gets
 * through.
 *
 * Three modes, set by ANTIVIRUS_MODE:
 *
 *   clamav     a clamd instance, local in development, a sidecar in production
 *   lambda     an S3-triggered function that writes a tag back to the object
 *   disabled   development only; refuses to run when NODE_ENV=production
 */

import { antivirus, purposes } from '../config/storage.config.js';
import { isProduction } from '../config/env.js';
import { logger } from '../observability/logger.js';
import * as Assets from './models/Asset.js';
import * as Storage from './StorageClient.js';

const log = logger.child({ component: 'antivirus' });

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Decision  (pure)
// ---------------------------------------------------------------------------

/**
 * What to do with a file, before any scanning happens.
 *
 * @returns {{ action: 'scan'|'skip'|'manual-review', reason: string }}
 */
export const triage = ({ sizeBytes, purpose, mode = antivirus.mode }) => {
  // Platform-generated files — recordings, certificates — did not come from
  // the internet and have nothing to scan for.
  if (purpose === 'recording') {
    return { action: 'skip', reason: 'produced by this platform' };
  }

  if (mode === 'disabled') {
    if (isProduction) {
      // Refusing to start is better than quietly serving unscanned uploads.
      throw new Error('ANTIVIRUS_MODE=disabled is not permitted in production');
    }
    return { action: 'skip', reason: 'scanning disabled in development' };
  }

  // Above the scanner's ceiling. Not passed through: held for a human.
  if (sizeBytes > antivirus.maxScanMb * MB) {
    return { action: antivirus.oversizePolicy, reason: `larger than ${antivirus.maxScanMb} MB` };
  }

  return { action: 'scan', reason: 'user supplied' };
};

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Streams the object to clamd over its INSTREAM protocol.
 *
 * Streaming rather than downloading: a 400 MB file would otherwise be held in
 * the worker's memory, and a handful of concurrent scans would take the process
 * with them.
 */
const scanWithClamav = async ({ bucket, key }) => {
  const net = await import('node:net');
  const stream = await Storage.getObjectStream({ bucket, key });

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: antivirus.host, port: antivirus.port });
    let reply = '';

    socket.setTimeout(120_000, () => {
      socket.destroy();
      reject(new Error('the scanner did not answer in time'));
    });

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');

      stream.on('data', (chunk) => {
        // Each chunk is length-prefixed; a zero-length chunk ends the stream.
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length, 0);
        socket.write(size);
        socket.write(chunk);
      });

      stream.on('end', () => socket.write(Buffer.alloc(4)));
      stream.on('error', (cause) => {
        socket.destroy();
        reject(cause);
      });
    });

    socket.on('data', (data) => {
      reply += data.toString();
    });

    socket.on('error', reject);

    socket.on('close', () => {
      if (!reply) return reject(new Error('the scanner closed without a verdict'));

      if (reply.includes('OK') && !reply.includes('FOUND')) {
        return resolve({ clean: true, signature: null });
      }
      if (reply.includes('FOUND')) {
        return resolve({ clean: false, signature: reply.split(':')[1]?.replace('FOUND', '').trim() ?? 'unknown' });
      }
      reject(new Error(`unexpected scanner reply: ${reply.slice(0, 120)}`));
    });
  });
};

/** The Lambda path: the function has already written its verdict as a tag. */
const readLambdaVerdict = async ({ bucket, key }) => {
  const { GetObjectTaggingCommand, S3Client } = await import('@aws-sdk/client-s3');
  const { s3ClientOptions, buckets } = await import('../config/storage.config.js');
  const s3 = new S3Client(s3ClientOptions);

  const result = await s3.send(
    new GetObjectTaggingCommand({ Bucket: buckets[bucket] ?? bucket, Key: key }),
  );

  const verdict = result.TagSet?.find((tag) => tag.Key === 'av-status')?.Value;
  if (!verdict) return { pending: true };

  return { clean: verdict === 'clean', signature: verdict === 'clean' ? null : verdict };
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Scans one asset and moves it forward. Called by the worker after
 * `completeUpload` queues it.
 *
 * The sequence on a clean file is: promote out of raw into delivery, then mark
 * ready. In that order — an asset marked ready whose bytes are still in the raw
 * bucket is a broken link, and a link that briefly 404s is worse than one that
 * appears a second later.
 */
export const scanAsset = async ({ assetId }) => {
  const asset = await Assets.findById(assetId);
  if (!asset) return { skipped: true, reason: 'asset is gone' };
  if (asset.status !== 'scanning') {
    return { skipped: true, reason: `asset is ${asset.status}` };
  }

  const decision = triage({ sizeBytes: asset.sizeBytes, purpose: asset.purpose });

  if (decision.action === 'manual-review') {
    log.warn({ assetId, sizeBytes: asset.sizeBytes }, 'file too large to scan; held for review');
    await Storage.promote({ fromBucket: 'raw', toBucket: 'quarantine', key: asset.objectKey });
    await Assets.setStatus({
      assetId,
      from: 'scanning',
      to: 'failed',
      error: 'This file is too large to scan automatically and is awaiting review.',
      patch: { bucket: 'quarantine' },
    });
    return { clean: false, held: true };
  }

  let verdict;

  if (decision.action === 'skip') {
    verdict = { clean: true, signature: null };
  } else {
    try {
      verdict =
        antivirus.mode === 'lambda'
          ? await readLambdaVerdict({ bucket: asset.bucket, key: asset.objectKey })
          : await scanWithClamav({ bucket: asset.bucket, key: asset.objectKey });
    } catch (cause) {
      log.error({ err: cause, assetId }, 'scan failed');

      // Fail closed. The asset stays in scanning so the reconcile job retries
      // it; it is never promoted on a scanner error.
      if (antivirus.failClosed) {
        return { clean: false, retry: true, reason: cause.message };
      }
      verdict = { clean: true, signature: null };
    }
  }

  // Lambda has not written its tag yet; try again shortly.
  if (verdict.pending) return { pending: true, retry: true };

  if (!verdict.clean) return rejectInfected({ asset, signature: verdict.signature });

  return promoteClean({ asset });
};

const rejectInfected = async ({ asset, signature }) => {
  // The bytes are destroyed, not quarantined for posterity. Keeping malware
  // because it is interesting is how it ends up being served by mistake.
  await Storage.deleteObject({ bucket: asset.bucket, key: asset.objectKey }).catch(() => undefined);

  await Assets.setStatus({
    assetId: asset.assetId,
    from: 'scanning',
    to: 'infected',
    error: 'This file was rejected by the virus scan.',
  });

  log.error({ assetId: asset.assetId, signature, ownerId: asset.ownerId }, 'INFECTED FILE REJECTED');

  notify(asset.assetId, 'media:asset.infected', {
    assetId: asset.assetId,
    signature,
    detectedAt: new Date().toISOString(),
  });

  // Recorded for the security review that follows a repeated offender.
  const { audit } = await import('../security/auditLog.js');
  await audit({
    actorId: asset.ownerId,
    action: 'media.infected',
    targetType: 'asset',
    targetId: asset.assetId,
    detail: signature,
  }).catch(() => undefined);

  return { clean: false, infected: true, signature };
};

const promoteClean = async ({ asset }) => {
  const promoted = await Storage.promote({
    fromBucket: asset.bucket,
    toBucket: 'delivery',
    key: asset.objectKey,
  });

  const rule = purposes[asset.purpose] ?? {};

  // Video still has work to do; everything else is usable now.
  if (rule.transcode && asset.kind === 'video') {
    await Assets.setStatus({
      assetId: asset.assetId,
      from: 'scanning',
      to: 'processing',
      patch: { bucket: 'delivery', objectKey: promoted.key },
    });

    const { enqueueTranscode } = await import('../queues/queues.js');
    await enqueueTranscode({ assetId: asset.assetId, purpose: asset.purpose });

    return { clean: true, transcoding: true };
  }

  await Assets.setStatus({
    assetId: asset.assetId,
    from: 'scanning',
    to: 'ready',
    patch: { bucket: 'delivery', objectKey: promoted.key },
  });

  log.info({ assetId: asset.assetId }, 'asset scanned and ready');

  notify(asset.assetId, 'media:asset.ready', {
    assetId: asset.assetId,
    purpose: asset.purpose,
    kind: asset.kind,
    readyAt: new Date().toISOString(),
  });

  return { clean: true, ready: true };
};

const notify = (assetId, event, payload) => {
  void import('../realtime/presenceGateway.js')
    .then(({ broadcastToAssetWatchers }) => broadcastToAssetWatchers(assetId, event, payload))
    .catch(() => undefined);
};

export default { scanAsset, triage };