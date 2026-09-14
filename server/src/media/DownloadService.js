// classroom-app/server/src/media/DownloadService.js
/**
 * Downloads  (F6)  [NEW]
 *
 * Authorises a read, issues a ticket, and records that it happened.
 *
 * Authorisation is the whole file. An asset id is a UUID and therefore
 * unguessable, but "unguessable" is not an access control — ids get forwarded,
 * logged, screenshotted and pasted into tickets. So every download resolves the
 * asset's context and asks whether *this* person may read it.
 *
 * The audit trail matters for one case in particular: a learner's assignment
 * submission. When somebody asks who looked at their coursework, the answer has
 * to exist, and it has to have been written at the time.
 */

import { pool } from '../db/pool.js';
import { logger } from '../observability/logger.js';
import * as Assets from './models/Asset.js';
import * as SubmissionFiles from './models/Submission.js';
import * as Delivery from './AssetDelivery.js';

const log = logger.child({ component: 'downloads' });

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

/**
 * The rules, in one readable place. Pure apart from its lookups, and ordered
 * cheapest first.
 *
 * @returns {{ allowed: boolean, code?: string, reason?: string, audit: boolean }}
 */
export const authorise = async ({ asset, viewerId }) => {
  // The owner always may. Covers avatars, own uploads, own submissions.
  if (asset.ownerId === viewerId) return { allowed: true, audit: false };

  switch (asset.purpose) {
    // Public by nature: they are rendered next to a name or a course card.
    case 'avatar':
    case 'course-cover':
      return { allowed: true, audit: false };

    case 'chat-attachment':
      return authoriseChatAttachment({ asset, viewerId });

    case 'post-attachment':
      return authorisePostAttachment({ asset, viewerId });

    case 'lesson-video':
    case 'lesson-document':
    case 'recording':
      return authoriseCourseAsset({ asset, viewerId });

    case 'assignment-brief':
      return authoriseCourseAsset({ asset, viewerId });

    case 'assignment-submission':
      return authoriseSubmission({ asset, viewerId });

    default:
      return { allowed: false, code: 'forbidden', reason: 'You cannot open this file.', audit: true };
  }
};

/** In the conversation, and not blocked by the person who sent it. */
const authoriseChatAttachment = async ({ asset, viewerId }) => {
  const { rows } = await pool.query(
    `SELECT 1
       FROM message_attachments ma
       JOIN messages m ON m.id = ma.message_id
       LEFT JOIN conversation_participants cp
              ON cp.conversation_id = m.conversation_id AND cp.user_id = $2
       LEFT JOIN channel_members cm
              ON cm.channel_id = m.channel_id AND cm.user_id = $2
      WHERE ma.asset_id = $1
        AND (cp.user_id IS NOT NULL OR cm.user_id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
           WHERE (b.user_id = m.author_id AND b.blocked_user_id = $2)
              OR (b.user_id = $2 AND b.blocked_user_id = m.author_id)
        )
      LIMIT 1`,
    [asset.assetId, viewerId],
  );

  return rows.length > 0
    ? { allowed: true, audit: false }
    : { allowed: false, code: 'forbidden', reason: 'This file was shared in a conversation you are not part of.', audit: true };
};

/** A member of the space the post lives in. */
const authorisePostAttachment = async ({ asset, viewerId }) => {
  const { rows } = await pool.query(
    `SELECT 1
       FROM threads t
       JOIN space_memberships sm ON sm.space_id = t.space_id AND sm.user_id = $2 AND sm.suspended = false
      WHERE (t.attachments @> jsonb_build_array(jsonb_build_object('assetId', $1::text))
             OR EXISTS (SELECT 1 FROM posts p
                         WHERE p.thread_id = t.id
                           AND p.attachments @> jsonb_build_array(jsonb_build_object('assetId', $1::text))))
      LIMIT 1`,
    [asset.assetId, viewerId],
  );

  return rows.length > 0
    ? { allowed: true, audit: false }
    : { allowed: false, code: 'forbidden', reason: 'You are not a member of that space.', audit: true };
};

/** Enrolled in the course, or teaching it. */
const authoriseCourseAsset = async ({ asset, viewerId }) => {
  const contextId = asset.metadata?.lessonId ?? asset.metadata?.courseId ?? null;
  if (!contextId) {
    return { allowed: false, code: 'forbidden', reason: 'You cannot open this file.', audit: true };
  }

  const { rows } = await pool.query(
    `SELECT 1
       FROM courses c
       LEFT JOIN modules m ON m.course_id = c.id
       LEFT JOIN lessons l ON l.module_id = m.id
       LEFT JOIN enrollments e ON e.course_id = c.id AND e.user_id = $2
                              AND e.status IN ('active','completed')
      WHERE (c.id = $1 OR l.id = $1)
        AND (e.user_id IS NOT NULL OR c.owner_id = $2)
      LIMIT 1`,
    [contextId, viewerId],
  );

  return rows.length > 0
    ? { allowed: true, audit: false }
    : { allowed: false, code: 'forbidden', reason: 'Enrol in this course to open its files.', audit: true };
};

/**
 * Coursework. The learner who wrote it, the teacher marking it, or a peer when
 * peer review is on *and* the peer has submitted their own work.
 *
 * Every one of these is audited, including the allowed ones. This is the case
 * the audit trail exists for.
 */
const authoriseSubmission = async ({ asset, viewerId }) => {
  const context = await SubmissionFiles.readersOf(asset.assetId);
  if (!context) {
    return { allowed: false, code: 'not_found', reason: 'File not found.', audit: true };
  }

  if (context.learnerId === viewerId) return { allowed: true, audit: true };
  if (context.teacherId === viewerId) return { allowed: true, audit: true };

  if (context.peerVisible) {
    const { rows } = await pool.query(
      `SELECT 1 FROM submissions
        WHERE assignment_id = $1 AND user_id = $2 AND status <> 'draft' LIMIT 1`,
      [context.assignmentId, viewerId],
    );
    if (rows.length > 0) return { allowed: true, audit: true };

    return {
      allowed: false,
      code: 'forbidden',
      reason: 'Submit your own work before reading anyone else’s.',
      audit: true,
    };
  }

  return { allowed: false, code: 'forbidden', reason: 'This is somebody else’s coursework.', audit: true };
};

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/**
 * @param {{ assetId: string, viewerId: string, disposition?: 'inline'|'attachment', context?: object }} input
 */
export const createDownload = async ({ assetId, viewerId, disposition = 'attachment', context = {} }) => {
  const asset = await Assets.findById(assetId);
  Assets.assertServable(asset);

  const verdict = await authorise({ asset, viewerId });

  if (!verdict.allowed) {
    // A refused attempt is recorded too: a pattern of them is the signal that
    // somebody is walking asset ids.
    await record({ asset, viewerId, allowed: false, reason: verdict.reason, context });

    log.warn({ assetId, viewerId, purpose: asset.purpose }, 'download refused');
    throw Object.assign(new Error(verdict.reason), { code: verdict.code });
  }

  const signed = Delivery.signUrl({
    key: asset.objectKey,
    disposition,
    fileName: asset.fileName,
  });

  if (verdict.audit) {
    await record({ asset, viewerId, allowed: true, context });
  }

  return {
    url: signed.url,
    expiresAt: signed.expiresAt,
    fileName: asset.fileName,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
  };
};

/**
 * Playback rather than download: a manifest URL plus the cookies that cover its
 * segments. Same authorisation, different shape.
 */
export const createPlayback = async ({ assetId, viewerId }) => {
  const asset = await Assets.findById(assetId);
  Assets.assertServable(asset);

  const verdict = await authorise({ asset, viewerId });
  if (!verdict.allowed) {
    await record({ asset, viewerId, allowed: false, reason: verdict.reason });
    throw Object.assign(new Error(verdict.reason), { code: verdict.code });
  }

  const decorated = Delivery.decorate({ asset });

  if (verdict.audit) await record({ asset, viewerId, allowed: true, context: { playback: true } });

  return {
    playbackUrl: decorated.playbackUrl,
    cookies: decorated.playbackCookies?.cookies ?? {},
    expiresAt: decorated.playbackCookies?.expiresAt ?? null,
    captions: decorated.captions,
    durationSec: asset.probe.durationSec,
  };
};

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Append-only, and deliberately not awaited by the caller's critical path
 * anywhere except a refusal — a failed audit write must be loud, but it must
 * not stop somebody opening a file they are entitled to.
 */
const record = async ({ asset, viewerId, allowed, reason = null, context = {} }) => {
  await pool
    .query(
      `INSERT INTO download_audit (asset_id, user_id, owner_id, purpose, allowed, reason, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [asset.assetId, viewerId, asset.ownerId, asset.purpose, allowed, reason, JSON.stringify(context)],
    )
    .catch((cause) =>
      log.error({ err: cause, assetId: asset.assetId, viewerId }, 'DOWNLOAD AUDIT WRITE FAILED'),
    );
};

/** Who has opened this file. The answer to the question this table exists for. */
export const auditTrail = async ({ assetId, requesterId }) => {
  const asset = await Assets.findById(assetId);
  if (!asset) throw Object.assign(new Error('asset not found'), { code: 'not_found' });

  // Only the owner, or the teacher who can already read it, may ask.
  const verdict = await authorise({ asset, viewerId: requesterId });
  if (!verdict.allowed && asset.ownerId !== requesterId) {
    throw Object.assign(new Error('you cannot see this'), { code: 'forbidden' });
  }

  const { rows } = await pool.query(
    `SELECT d.*, u.display_name
       FROM download_audit d JOIN users u ON u.id = d.user_id
      WHERE d.asset_id = $1 ORDER BY d.created_at DESC LIMIT 200`,
    [assetId],
  );

  return rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    allowed: row.allowed,
    reason: row.reason,
    at: row.created_at.toISOString(),
  }));
};

export default { createDownload, createPlayback, authorise, auditTrail };