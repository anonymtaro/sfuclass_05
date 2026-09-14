/**
 * auditLog — who did what, append-only. (F7)
 *
 * Distinct from the application log, and the distinction is the point:
 *
 *   logger    high volume, retention measured in weeks, may be sampled, may be lost.
 *   auditLog  low volume, retention measured in years, never sampled, never lost.
 *
 * So an audit write is not fire-and-forget. When a caller passes the transaction client
 * that performed the action, the audit row is written inside that transaction — the record
 * and the thing it records commit together or not at all. That is the only way the audit
 * trail cannot disagree with the database it describes.
 *
 * Without a client it degrades: the row is written on its own connection, and if that fails
 * the event goes to the application log at error level with a marker, so it is recoverable
 * from CloudWatch rather than gone. It is never swallowed.
 *
 * "Append-only" is enforced by grants, not by this file. The migration revokes UPDATE and
 * DELETE on the table from the application role. Code that promises immutability while
 * holding a role that can DELETE is promising nothing.
 */

import { pool } from '../db/pool.js';
import { redact } from './piiRedaction.js';
import { logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';

/**
 * The actions worth keeping for years. Not an exhaustive list of what the app does — an
 * audit log that records everything is a second application log with a bigger bill.
 *
 * The test for inclusion: would somebody ask "who did that, and when?" during an incident,
 * a dispute, or a data request?
 */
export const ACTIONS = Object.freeze({
  // Access and identity
  LOGIN_SUCCEEDED: 'auth.login.succeeded',
  LOGIN_FAILED: 'auth.login.failed',
  SESSION_REVOKED: 'auth.session.revoked',
  PASSWORD_CHANGED: 'auth.password.changed',
  ROLE_CHANGED: 'identity.role.changed',

  // Content and money
  COURSE_PUBLISHED: 'course.published',
  ENROLMENT_CHANGED: 'course.enrolment.changed',
  GRADE_PUBLISHED: 'assignment.grade.published',
  PLAN_CHANGED: 'billing.plan.changed',

  // Things people dispute later
  MESSAGE_DELETED: 'chat.message.deleted',
  POST_DELETED: 'community.post.deleted',
  USER_REMOVED_FROM_ROOM: 'classroom.peer.removed',
  MODERATION_ACTION: 'moderation.action',
  RETENTION_DELETE: 'retention.deleted',

  // Data access — the one auditors always ask for
  ASSET_DOWNLOADED: 'media.asset.downloaded',
  EXPORT_GENERATED: 'data.export.generated',
  ACCOUNT_DELETED: 'identity.account.deleted',
});

const INSERT = `
  insert into audit_log
    (tenant_id, actor_id, actor_role, action, target_type, target_id, metadata, ip, user_agent, request_id, trace_id)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
`;

/**
 * Record an event.
 *
 * @param {object} event
 * @param {string} event.action       one of ACTIONS
 * @param {string} [event.tenantId]
 * @param {string} [event.actorId]    null for a system action (a job, a webhook)
 * @param {string} [event.actorRole]
 * @param {string} [event.targetType] 'message' | 'asset' | 'user' | 'course' …
 * @param {string} [event.targetId]
 * @param {object} [event.metadata]   redacted before storage
 * @param {object} [options]
 * @param {import('pg').PoolClient} [options.client]
 *        The transaction that performed the action. Strongly preferred: it makes the audit
 *        row and the action atomic.
 */
export async function auditLog(event, { client } = {}) {
  if (!event?.action) throw new Error('auditLog requires an action');

  const params = [
    event.tenantId ?? null,
    event.actorId ?? null,
    event.actorRole ?? null,
    event.action,
    event.targetType ?? null,
    event.targetId ?? null,
    // Redacted on the way in. An audit trail kept for seven years is the last place a
    // bearer token should be sitting.
    JSON.stringify(redact(event.metadata ?? {})),
    event.ip ?? null,
    event.userAgent ?? null,
    event.requestId ?? null,
    event.traceId ?? null,
  ];

  try {
    await (client ?? pool).query(INSERT, params);
    metrics.increment?.('audit_written', 1, { action: event.action });
  } catch (error) {
    if (client) {
      // Inside a transaction the caller must know: failing the action is correct, because
      // an unrecorded action is worse than a refused one.
      throw error;
    }
    // Outside one, CloudWatch becomes the fallback ledger. `audit_fallback: true` is what
    // a recovery query filters on.
    metrics.increment?.('audit_write_failed', 1, { action: event.action });
    logger.error(
      { err: error, audit_fallback: true, event: { ...event, metadata: redact(event.metadata ?? {}) } },
      'audit: write failed — event preserved in the application log',
    );
  }
}

/** Alias, so `auditLog.record(event)` and `auditLog(event)` both work across the codebase. */
auditLog.record = auditLog;

/**
 * Several events from one transaction, in one statement. Used by bulk moderation and by
 * retention, where one action touches five hundred rows and five hundred inserts would
 * dominate the operation they are recording.
 */
export async function auditBatch(events, { client } = {}) {
  if (!events?.length) return 0;

  const values = [];
  const params = [];
  events.forEach((event, index) => {
    const base = index * 11;
    values.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11})`,
    );
    params.push(
      event.tenantId ?? null,
      event.actorId ?? null,
      event.actorRole ?? null,
      event.action,
      event.targetType ?? null,
      event.targetId ?? null,
      JSON.stringify(redact(event.metadata ?? {})),
      event.ip ?? null,
      event.userAgent ?? null,
      event.requestId ?? null,
      event.traceId ?? null,
    );
  });

  const sql = `
    insert into audit_log
      (tenant_id, actor_id, actor_role, action, target_type, target_id, metadata, ip, user_agent, request_id, trace_id)
    values ${values.join(',')}
  `;

  await (client ?? pool).query(sql, params);
  metrics.increment?.('audit_written', events.length);
  return events.length;
}

/**
 * Express helper: fills in actor, ip, user agent and the request/trace ids from the request
 * so a route handler only states what happened.
 *
 *     await auditFromRequest(req, { action: ACTIONS.COURSE_PUBLISHED, targetId: course.id })
 */
export function auditFromRequest(req, event, options) {
  return auditLog(
    {
      tenantId: req.user?.tenantId,
      actorId: req.user?.id ?? null,
      actorRole: req.user?.role ?? null,
      ip: req.ip,
      userAgent: req.get?.('user-agent') ?? null,
      requestId: req.id ?? req.requestId ?? null,
      traceId: req.traceId ?? null,
      ...event,
    },
    options,
  );
}

/**
 * Read side. Deliberately narrow: filter, page, and nothing that lets a caller mutate.
 * Exposed to tenant owners for their own tenant only — enforced by the caller, which knows
 * who is asking.
 */
export async function queryAudit({
  tenantId,
  action = null,
  actorId = null,
  targetType = null,
  targetId = null,
  from = null,
  to = null,
  limit = 100,
  cursor = null,
}) {
  const { rows } = await pool.query(
    `select id, tenant_id, actor_id, actor_role, action, target_type, target_id,
            metadata, ip, user_agent, request_id, trace_id, created_at
       from audit_log
      where tenant_id = $1
        and ($2::text is null or action = $2)
        and ($3::uuid is null or actor_id = $3)
        and ($4::text is null or target_type = $4)
        and ($5::uuid is null or target_id = $5)
        and ($6::timestamptz is null or created_at >= $6)
        and ($7::timestamptz is null or created_at < $7)
        and ($8::bigint is null or id < $8)
      order by id desc
      limit $9`,
    [tenantId, action, actorId, targetType, targetId, from, to, cursor, Math.min(limit, 500)],
  );

  return { entries: rows, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null };
}

export default auditLog;