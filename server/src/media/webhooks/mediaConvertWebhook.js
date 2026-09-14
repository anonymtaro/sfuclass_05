// classroom-app/server/src/media/webhooks/mediaConvertWebhook.js
/**
 * MediaConvert completion  (F4)  [NEW]
 *
 * EventBridge delivers MediaConvert state changes here. The handler's whole job
 * is to be boring and correct:
 *
 *   verify    the event came from EventBridge, not from the internet
 *   dedupe    EventBridge delivers at least once; a replay must change nothing
 *   dispatch  hand it to TranscodeService and return 200 quickly
 *
 * The last point matters more than it looks. EventBridge retries anything that
 * does not answer promptly, so doing the work inline turns one slow completion
 * into four duplicate ones. The handler records, acknowledges, and lets the
 * worker finish the job.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { logger } from '../../observability/logger.js';

const log = logger.child({ component: 'mediaconvert-webhook' });

/** MediaConvert states that mean something is finished, one way or another. */
const TERMINAL = new Set(['COMPLETE', 'ERROR', 'CANCELED']);

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * EventBridge can sign with a shared secret when it posts to an API
 * destination. Verified in constant time — a fast reject leaks the secret a
 * byte at a time.
 */
export const verifySignature = (rawBody, header, secret = env.STRIPE_WEBHOOK_SECRET) => {
  if (!secret) return true; // unsigned in development
  if (!header) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Pulls what matters out of the event envelope.
 *
 * `assetId` rides in UserMetadata, set when the job was submitted, so the
 * handler never needs a job-to-asset lookup table.
 */
export const parseEvent = (event) => {
  const detail = event?.detail ?? {};

  return {
    eventId: event?.id ?? null,
    jobId: detail.jobId ?? null,
    status: detail.status ?? null,
    assetId: detail.userMetadata?.assetId ?? null,
    purpose: detail.userMetadata?.purpose ?? null,
    errorMessage: detail.errorMessage ?? null,
    outputs: (detail.outputGroupDetails ?? []).flatMap((group) =>
      (group.outputDetails ?? []).map((output) => ({
        width: output.videoDetails?.widthInPx ?? null,
        height: output.videoDetails?.heightInPx ?? null,
        bitrate: output.videoDetails?.averageBitrate ?? null,
        durationMs: output.durationInMs ?? null,
      })),
    ),
  };
};

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Records the event id and reports whether it is new. An INSERT with ON
 * CONFLICT is the check: two tasks receiving the same replay at the same moment
 * cannot both win.
 */
const claim = async ({ eventId, jobId, status }) => {
  if (!eventId) return true; // unsigned local test

  const { rows } = await pool.query(
    `INSERT INTO processed_events (event_id, source, type, payload)
     VALUES ($1, 'mediaconvert', $2, $3::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, status, JSON.stringify({ jobId, status })],
  );

  return rows.length > 0;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Express handler. Mounted on a raw-body route — see bodyLimits.js — because
 * the signature covers the exact bytes.
 */
export const handleMediaConvertEvent = async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);

  if (!verifySignature(raw, req.get('x-eventbridge-signature'))) {
    log.warn('rejected an unsigned MediaConvert event');
    // 401 rather than 400: EventBridge retries a 5xx and gives up on a 4xx,
    // and an event we will never accept should not be retried for a day.
    return res.status(401).json({ error: 'invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: 'malformed event' });
  }

  const parsed = parseEvent(event);

  if (!parsed.jobId || !TERMINAL.has(parsed.status)) {
    // Progress events are frequent and uninteresting. Acknowledged so they are
    // not retried.
    return res.status(204).end();
  }

  if (!parsed.assetId) {
    log.error({ jobId: parsed.jobId }, 'completion event carries no assetId');
    return res.status(204).end();
  }

  const fresh = await claim(parsed);
  if (!fresh) {
    log.debug({ eventId: parsed.eventId, jobId: parsed.jobId }, 'duplicate event ignored');
    return res.status(200).json({ duplicate: true });
  }

  // Acknowledged first, processed after. A slow completion must not become
  // four duplicate ones.
  res.status(202).json({ accepted: true });

  await dispatch(parsed).catch((cause) =>
    log.error({ err: cause, assetId: parsed.assetId, jobId: parsed.jobId }, 'could not apply a completion event'),
  );
};

/** Exported so the reconcile job can apply a state it discovered by polling. */
export const dispatch = async (parsed) => {
  const Transcode = await import('../TranscodeService.js');

  if (parsed.status === 'COMPLETE') {
    const durationMs = parsed.outputs.find((output) => output.durationMs)?.durationMs ?? null;
    return Transcode.completeJob({
      assetId: parsed.assetId,
      jobId: parsed.jobId,
      outputs: parsed.outputs,
      durationMs,
    });
  }

  return Transcode.failJob({
    assetId: parsed.assetId,
    jobId: parsed.jobId,
    reason: parsed.errorMessage ?? parsed.status,
    // A cancelled job can be resubmitted; a hard error usually means the file
    // itself is the problem and a retry produces the same result.
    retryable: parsed.status === 'CANCELED',
  });
};

export default handleMediaConvertEvent;