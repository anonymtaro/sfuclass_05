// classroom-app/server/src/messaging/ChatAttachmentService.js
/**
 * Chat attachments  (F4, F6)
 *
 * Files in chat reuse the media domain entirely. This service is the thin layer
 * that connects the two, and it deliberately owns no storage logic of its own:
 *
 *   request  →  quota check  →  presign (media/)  →  client uploads to S3
 *            →  quarantine scan (media/)  →  ready  →  attach to a message
 *
 * The alternative — a second, simpler upload path for "just a chat file" — is
 * how a platform ends up with one route that scans uploads and another that
 * does not. Everything here goes through the same quota, the same scan and the
 * same signed delivery as a lecture recording.
 *
 * Signed URLs are minted at read time, never stored. A URL saved with the
 * message would be expired long before anyone scrolled back to it.
 */

import { ApiError } from '@classroom/contracts';
import { env } from '../config/env.js';
import { purposes, validateUpload } from '../config/storage.config.js';
import { logger } from '../observability/logger.js';
import * as Attachment from './models/MessageAttachment.js';

const log = logger.child({ component: 'chat-attachments' });

/**
 * Announces an intended upload. Checks the plan quota and the chat-specific
 * ceiling *before* a byte moves, so a 2 GB file is refused in milliseconds
 * rather than at the end of a twenty-minute transfer.
 */
export const requestUpload = async ({ target, userId, tenantId, fileName, contentType, sizeBytes }) => {
  const maxBytes = env.CHAT_ATTACHMENT_MAX_MB * 1024 * 1024;
  if (sizeBytes > maxBytes) {
    throw new ApiError('payload_too_large', {
      detail: `Attachments are limited to ${env.CHAT_ATTACHMENT_MAX_MB} MB.`,
    });
  }

  // The purpose rules allow any content type for chat. That is not laxness:
  // a type allowlist is defeated by renaming a file, and the scan is what
  // actually makes this safe. See config/storage.config.js.
  const check = validateUpload('chat-attachment', { contentType, sizeBytes });
  if (!check.ok) throw new ApiError(check.code, { detail: check.reason });

  // Whoever can write here can attach here; one authorisation, not two.
  const { authoriseRead } = await import('./DirectMessageService.js');
  await authoriseRead({ target, userId });

  const { StorageGuard } = await import('../capacity/StorageGuard.js');
  const allowed = await StorageGuard.reserve({ tenantId, sizeBytes });
  if (!allowed.ok) {
    throw new ApiError('quota_exceeded', {
      detail: 'This would exceed your plan\u2019s storage quota.',
    });
  }

  const { createUpload } = await import('../media/UploadService.js');

  const contextId =
    target.kind === 'conversation'
      ? target.conversationId
      : target.kind === 'channel'
        ? target.channelId
        : target.roomId;

  const ticket = await createUpload({
    userId,
    tenantId,
    purpose: 'chat-attachment',
    fileName,
    contentType,
    sizeBytes,
    contextId,
  });

  log.debug({ assetId: ticket.assetId, userId, sizeBytes }, 'chat attachment ticket issued');
  return ticket;
};

/**
 * Before a message referencing assets is accepted, every one of them has to be
 * ready — uploaded, scanned, and owned by the sender.
 *
 * The ownership check is the one that matters: without it, a client could
 * attach any asset id it could guess, including somebody else's private file.
 */
export const assertAttachable = async ({ assetIds, userId }) => {
  if (assetIds.length === 0) return [];

  const { getAssetsByIds } = await import('../media/UploadService.js');
  const assets = await getAssetsByIds(assetIds);

  if (assets.length !== assetIds.length) {
    throw new ApiError('not_found', { detail: 'One of the attachments does not exist.' });
  }

  for (const asset of assets) {
    if (asset.owner_id !== userId) {
      throw new ApiError('forbidden', { detail: 'You can only attach your own uploads.' });
    }
    if (asset.purpose !== 'chat-attachment') {
      throw new ApiError('validation_failed', { detail: 'That file was not uploaded for chat.' });
    }
    if (asset.status === 'infected') {
      throw new ApiError('asset_infected', { detail: 'This file was rejected by the virus scan.' });
    }
    if (asset.status !== 'ready') {
      throw new ApiError('asset_not_ready', {
        detail: 'The file is still being scanned. Try again in a moment.',
        retryAfter: 5,
      });
    }
  }

  return assets;
};

/**
 * Mints short-lived signed URLs for a page of attachments.
 *
 * A file that is not ready gets null URLs rather than being hidden: the bubble
 * shows a spinner, and `chat:attachment.ready` fills it in when the scan
 * finishes.
 */
export const signAttachments = async (attachments) => {
  if (attachments.length === 0) return [];

  const { signDownload, signPreview } = await import('../media/AssetDelivery.js');

  return Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.status !== 'ready') {
        return { ...attachment, downloadUrl: null, previewUrl: null };
      }
      return {
        ...attachment,
        downloadUrl: await signDownload(attachment.assetId, { disposition: 'attachment' }),
        // Images and PDFs render inline; everything else is a download tile.
        previewUrl: ['image', 'document'].includes(attachment.kind)
          ? await signPreview(attachment.assetId)
          : null,
      };
    }),
  );
};

/**
 * An asset finished scanning. Every message already showing it is told, so the
 * spinner becomes a file without anyone refreshing.
 */
export const onAssetReady = async ({ assetId, status }) => {
  const rows = await Attachment.messagesForAsset(assetId);
  if (rows.length === 0) return 0;

  const { signDownload, signPreview } = await import('../media/AssetDelivery.js');
  const { broadcastAttachmentReady } = await import('./chatGateway.js');

  const ready = status === 'ready';

  for (const row of rows) {
    broadcastAttachmentReady({
      target:
        row.target_kind === 'conversation'
          ? { kind: 'conversation', conversationId: row.conversation_id }
          : row.target_kind === 'channel'
            ? { kind: 'channel', channelId: row.channel_id }
            : { kind: 'room', roomId: row.room_id },
      messageId: row.message_id,
      assetId,
      status,
      downloadUrl: ready ? await signDownload(assetId, { disposition: 'attachment' }) : null,
      previewUrl: ready ? await signPreview(assetId) : null,
    });
  }

  return rows.length;
};

/** Retention: chat files expire with their messages, not independently. */
export const retentionDays = () => purposes['chat-attachment'].retentionDays;

export default { requestUpload, assertAttachable, signAttachments, onAssetReady };