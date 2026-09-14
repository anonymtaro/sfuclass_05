// classroom-app/server/src/media/models/Asset.js
/**
 * Asset row access and lifecycle  (F4)  [NEW]
 *
 * Every uploaded byte in the platform is an Asset: lesson videos, course
 * documents, avatars, chat attachments, assignment files, recordings. One table
 * and one lifecycle, because the interesting operations — quota, virus
 * scanning, retention, deletion — are identical whatever the file is for.
 *
 *   uploading ──▶ scanning ──▶ processing ──▶ ready
 *                     │             │
 *                     ▼             ▼
 *                 infected       failed
 *
 * Only `ready` is servable, and `assertServable` is the single check that
 * enforces it. A file that skips a stage is not a cosmetic problem: it is an
 * unscanned executable being handed to a class.
 */

import { pool } from '../../db/pool.js';

export const TABLE = 'assets';

export const STATUSES = ['uploading', 'scanning', 'processing', 'ready', 'failed', 'infected'];

/**
 * Which transitions are legal. Written out rather than implied, because the
 * transitions come from four different places — the API, the scanner, the
 * transcoder and a webhook — and none of them can see the others.
 */
const TRANSITIONS = {
  uploading: ['scanning', 'failed'],
  scanning: ['processing', 'ready', 'infected', 'failed'],
  processing: ['ready', 'failed'],
  ready: ['failed'], // a deleted source can invalidate a ready asset
  failed: ['scanning', 'processing'], // a retry re-enters the pipeline
  infected: [], // terminal, always
};

export const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to);

export const rowToAsset = (row) => ({
  assetId: row.id,
  ownerId: row.owner_id,
  uploadedBy: {
    userId: row.owner_id,
    displayName: row.owner_name ?? '',
    avatarUrl: row.owner_avatar ?? null,
  },
  purpose: row.purpose,
  kind: row.kind,
  status: row.status,
  fileName: row.file_name,
  contentType: row.content_type,
  sizeBytes: Number(row.size_bytes ?? 0),
  checksum: row.checksum,
  probe: {
    durationSec: row.duration_sec,
    width: row.width,
    height: row.height,
    pageCount: row.page_count,
  },
  // URLs are never stored. They are signed on read with a short TTL; a stored
  // URL would be a directory of expired links.
  downloadUrl: null,
  playbackUrl: null,
  thumbnailUrl: null,
  renditions: row.renditions ?? [],
  captions: row.captions ?? [],
  error: row.error,
  metadata: row.metadata ?? {},
  expiresAt: row.expires_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  // Internal: which bucket and key the bytes are in right now.
  bucket: row.bucket,
  objectKey: row.object_key,
});

const SELECT = `
  SELECT a.*, u.display_name AS owner_name, u.avatar_url AS owner_avatar
    FROM assets a LEFT JOIN users u ON u.id = a.owner_id
`;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const findById = async (assetId, client = pool) => {
  const { rows } = await client.query(`${SELECT} WHERE a.id = $1 AND a.deleted_at IS NULL`, [assetId]);
  return rows[0] ? rowToAsset(rows[0]) : null;
};

export const findMany = async (assetIds, client = pool) => {
  if (assetIds.length === 0) return [];
  const { rows } = await client.query(
    `${SELECT} WHERE a.id = ANY($1::uuid[]) AND a.deleted_at IS NULL`,
    [assetIds],
  );
  return rows.map(rowToAsset);
};

/** The ownership check every attach path uses. */
export const findForOwner = async ({ assetIds, userId }, client = pool) => {
  if (assetIds.length === 0) return [];
  const { rows } = await client.query(
    `${SELECT} WHERE a.id = ANY($1::uuid[]) AND a.owner_id = $2 AND a.deleted_at IS NULL`,
    [assetIds, userId],
  );
  return rows.map(rowToAsset);
};

export const list = async ({ ownerId, purpose, kind, status, contextId, q, cursor, limit = 25 }, client = pool) => {
  const params = [ownerId];
  const conditions = ['a.owner_id = $1', 'a.deleted_at IS NULL'];

  if (purpose) { params.push(purpose); conditions.push(`a.purpose = $${params.length}`); }
  if (kind) { params.push(kind); conditions.push(`a.kind = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`a.status = $${params.length}`); }
  if (contextId) { params.push(contextId); conditions.push(`a.context_id = $${params.length}`); }
  if (q) { params.push(`%${q}%`); conditions.push(`a.file_name ILIKE $${params.length}`); }

  if (cursor) {
    const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    params.push(at, id);
    conditions.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);

  const { rows } = await client.query(
    `${SELECT} WHERE ${conditions.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    items: page.map(rowToAsset),
    hasMore,
    nextCursor: hasMore && page.at(-1)
      ? Buffer.from(`${page.at(-1).created_at.toISOString()}|${page.at(-1).id}`).toString('base64url')
      : null,
  };
};

/**
 * Deduplication by checksum, scoped to the owner. The same lecture uploaded
 * twice should not cost the quota twice — and cross-owner dedupe would let
 * someone discover whether a file exists by uploading a guess.
 */
export const findByChecksum = async ({ checksum, ownerId }, client = pool) => {
  if (!checksum) return null;
  const { rows } = await client.query(
    `${SELECT} WHERE a.checksum = $1 AND a.owner_id = $2 AND a.status = 'ready' AND a.deleted_at IS NULL
      LIMIT 1`,
    [checksum, ownerId],
  );
  return rows[0] ? rowToAsset(rows[0]) : null;
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export const insert = async (asset, client = pool) => {
  const { rows } = await client.query(
    `INSERT INTO assets
       (id, owner_id, purpose, kind, status, file_name, content_type, size_bytes,
        checksum, bucket, object_key, context_id, metadata, expires_at)
     VALUES (coalesce($1, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
     RETURNING id`,
    [
      asset.assetId ?? null, asset.ownerId, asset.purpose, asset.kind,
      asset.status ?? 'uploading', asset.fileName, asset.contentType, asset.sizeBytes,
      asset.checksum ?? null, asset.bucket ?? 'raw', asset.objectKey,
      asset.contextId ?? null, JSON.stringify(asset.metadata ?? {}), asset.expiresAt ?? null,
    ],
  );
  return findById(rows[0].id, client);
};

/**
 * Status change, guarded.
 *
 * The guard is in the WHERE clause rather than a read-then-write, because four
 * independent processes touch these rows: a webhook arriving twice, or a
 * reconcile job racing a scanner, must not walk an asset backwards.
 */
export const setStatus = async ({ assetId, from, to, error = null, patch = {} }, client = pool) => {
  if (from && !canTransition(from, to)) {
    throw Object.assign(new Error(`cannot move an asset from ${from} to ${to}`), {
      code: 'conflict',
    });
  }

  const sets = ['status = $2', 'error = $3', 'updated_at = now()'];
  const params = [assetId, to, error];

  const columns = {
    bucket: 'bucket', objectKey: 'object_key', renditions: 'renditions',
    captions: 'captions', durationSec: 'duration_sec', width: 'width',
    height: 'height', pageCount: 'page_count', sizeBytes: 'size_bytes',
  };

  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    params.push(
      key === 'renditions' || key === 'captions' ? JSON.stringify(patch[key]) : patch[key],
    );
    sets.push(`${column} = $${params.length}${key === 'renditions' || key === 'captions' ? '::jsonb' : ''}`);
  }

  // The current-status condition makes the update idempotent: a replayed
  // webhook matches nothing and changes nothing.
  const { rows } = await client.query(
    `UPDATE assets SET ${sets.join(', ')}
      WHERE id = $1 AND deleted_at IS NULL
        ${from ? `AND status = '${from}'` : ''}
      RETURNING id`,
    params,
  );

  return rows[0] ? findById(assetId, client) : null;
};

export const attachContext = async ({ assetId, contextId }, client = pool) => {
  await client.query(`UPDATE assets SET context_id = $2, updated_at = now() WHERE id = $1`, [
    assetId,
    contextId,
  ]);
};

/**
 * Soft delete. The row survives so the storage sweeper knows which object to
 * remove, and so a message that referenced it can still render a tombstone
 * rather than a broken tile.
 */
export const softDelete = async (assetId, client = pool) => {
  const { rows } = await client.query(
    `UPDATE assets SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING bucket, object_key, size_bytes`,
    [assetId],
  );
  return rows[0] ?? null;
};

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/**
 * Bytes held by one owner. Only assets that made it past the scan count:
 * charging somebody for a file that was rejected would be indefensible.
 */
export const usageFor = async (ownerId, client = pool) => {
  const { rows } = await client.query(
    `SELECT coalesce(sum(size_bytes), 0)::bigint AS used,
            purpose,
            count(*)::int AS files
       FROM assets
      WHERE owner_id = $1 AND deleted_at IS NULL
        AND status IN ('ready','processing','scanning')
      GROUP BY ROLLUP (purpose)`,
    [ownerId],
  );

  const byPurpose = {};
  let total = 0;

  for (const row of rows) {
    if (row.purpose === null) total = Number(row.used);
    else byPurpose[row.purpose] = Number(row.used);
  }

  return { usedBytes: total, byPurpose };
};

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

/** Uploads abandoned mid-flight. Reaped so they stop occupying quota. */
export const findStaleUploads = async ({ olderThanHours = 24 }, client = pool) => {
  const { rows } = await client.query(
    `${SELECT} WHERE a.status = 'uploading'
        AND a.created_at < now() - ($1 || ' hours')::interval
        AND a.deleted_at IS NULL
      LIMIT 500`,
    [String(olderThanHours)],
  );
  return rows.map(rowToAsset);
};

/** Stuck in processing: a MediaConvert job whose webhook never arrived. */
export const findStuckProcessing = async ({ olderThanMinutes = 90 }, client = pool) => {
  const { rows } = await client.query(
    `${SELECT} WHERE a.status = 'processing'
        AND a.updated_at < now() - ($1 || ' minutes')::interval
        AND a.deleted_at IS NULL
      LIMIT 200`,
    [String(olderThanMinutes)],
  );
  return rows.map(rowToAsset);
};

/** Past their retention date; see purposes[].retentionDays. */
export const findExpired = async (client = pool) => {
  const { rows } = await client.query(
    `${SELECT} WHERE a.expires_at IS NOT NULL AND a.expires_at < now() AND a.deleted_at IS NULL
      LIMIT 500`,
  );
  return rows.map(rowToAsset);
};

/** Soft-deleted long enough that the bytes can go too. */
export const findPurgeable = async ({ graceDays = 7 }, client = pool) => {
  const { rows } = await client.query(
    `SELECT id, bucket, object_key FROM assets
      WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1 || ' days')::interval
      LIMIT 500`,
    [String(graceDays)],
  );
  return rows.map((row) => ({ assetId: row.id, bucket: row.bucket, objectKey: row.object_key }));
};

export const hardDelete = async (assetId, client = pool) => {
  await client.query(`DELETE FROM assets WHERE id = $1 AND deleted_at IS NOT NULL`, [assetId]);
};

/** The one check between an asset and anybody consuming it. */
export const assertServable = (asset) => {
  if (!asset) throw Object.assign(new Error('asset not found'), { code: 'not_found' });

  if (asset.status === 'infected') {
    throw Object.assign(new Error('this file was rejected by the virus scan'), {
      code: 'asset_infected',
    });
  }
  if (asset.status !== 'ready') {
    throw Object.assign(new Error('this file is still being processed'), {
      code: 'asset_not_ready',
    });
  }
  return asset;
};

export default { findById, findMany, findForOwner, list, insert, setStatus, softDelete, usageFor, assertServable, canTransition };