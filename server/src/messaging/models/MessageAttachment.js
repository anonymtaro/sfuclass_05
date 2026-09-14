// classroom-app/server/src/messaging/models/MessageAttachment.js
/**
 * Message attachment  (F4, F6)
 *
 * A join between a message and an asset. It holds no bytes, no URLs and no file
 * metadata of its own — those live in the media domain, and duplicating them
 * here is how a renamed or re-transcoded file ends up displayed under its old
 * name forever.
 *
 * What it does hold is order, because "the three screenshots I sent" have one.
 *
 * Attachments are resolved at read time through the media domain, so a message
 * sent while its file was still scanning shows the file as soon as it is ready
 * without the message being rewritten.
 */

import { pool } from '../../db/pool.js';

export const attach = async ({ messageId, assetIds }) => {
  if (assetIds.length === 0) return 0;

  const { rowCount } = await pool.query(
    `INSERT INTO message_attachments (message_id, asset_id, position)
     SELECT $1, asset_id, ordinality - 1
       FROM unnest($2::uuid[]) WITH ORDINALITY AS t(asset_id, ordinality)
     ON CONFLICT (message_id, asset_id) DO NOTHING`,
    [messageId, assetIds],
  );
  return rowCount;
};

/**
 * Attachments for a page of messages, in one query.
 *
 * Per-message loading would be N+1 on a screen that shows fifty messages, and
 * the asset join is the expensive part.
 */
export const listForMessages = async (messageIds) => {
  if (messageIds.length === 0) return new Map();

  const { rows } = await pool.query(
    `SELECT ma.message_id, ma.asset_id, ma.position,
            a.file_name, a.content_type, a.size_bytes, a.status, a.kind
       FROM message_attachments ma
       JOIN assets a ON a.asset_id = ma.asset_id
      WHERE ma.message_id = ANY($1::uuid[])
      ORDER BY ma.message_id, ma.position`,
    [messageIds],
  );

  const byMessage = new Map();
  for (const row of rows) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push({
      assetId: row.asset_id,
      fileName: row.file_name,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      status: row.status,
      // Signed on demand by ChatAttachmentService; a stored URL would be
      // expired long before anyone opened the thread.
      downloadUrl: null,
      previewUrl: null,
    });
    byMessage.set(row.message_id, list);
  }

  return byMessage;
};

export const listForMessage = async (messageId) =>
  (await listForMessages([messageId])).get(messageId) ?? [];

/** Which messages reference an asset — used when an asset becomes ready. */
export const messagesForAsset = async (assetId) => {
  const { rows } = await pool.query(
    `SELECT ma.message_id, m.conversation_id, m.channel_id, m.room_id, m.target_kind
       FROM message_attachments ma
       JOIN messages m ON m.message_id = ma.message_id
      WHERE ma.asset_id = $1`,
    [assetId],
  );
  return rows;
};

/** Retention: the assets to delete when messages are pruned. */
export const assetsForMessages = async (messageIds) => {
  if (messageIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT asset_id FROM message_attachments WHERE message_id = ANY($1::uuid[])`,
    [messageIds],
  );
  return rows.map((row) => row.asset_id);
};

export const detachAll = async (messageId) => {
  await pool.query(`DELETE FROM message_attachments WHERE message_id = $1`, [messageId]);
};

export default { attach, listForMessages, listForMessage, messagesForAsset };