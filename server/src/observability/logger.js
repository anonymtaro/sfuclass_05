/**
 * logger — pino JSON + redaction → CloudWatch. [EXT] (F7)
 *
 * One line per event, JSON, to stdout. The ECS awslogs driver takes stdout to CloudWatch
 * Logs; nothing writes a file, because nothing writes to disk.
 *
 * Every line carries, without the caller doing anything:
 *   service, release, env        — which build produced this
 *   requestId, traceId, userId   — from requestContext's AsyncLocalStorage
 *   trace_id, span_id            — from the active OTEL span, so a log line and the X-Ray
 *                                  trace of the same request can be joined
 *
 * That last pair is the difference between "we have logs and traces" and "we can find the
 * logs for this trace". CloudWatch Logs Insights joins on the field name, so it has to be
 * on the line, not inferred later.
 *
 * Redaction happens in two passes for cost reasons: pino's compiled `redact` paths handle
 * the known shapes (headers, body.password) before serialisation, and the formatter runs
 * the deep walk only over what is left. See security/piiRedaction.js.
 *
 * In production, `NODE_ENV=production` also means no stack traces leave the process toward
 * a client — that is errorHandler's job, not this file's. Stacks still go to the log.
 */

import pino from 'pino';

import { env } from '../config/env.js';
import { redact, PINO_REDACT_PATHS } from '../security/piiRedaction.js';

/**
 * Set by middleware/requestContext.js. Imported lazily and defensively: the logger is
 * imported by nearly everything, including modules that load before the context exists,
 * and a circular import here takes the whole process down at boot.
 */
let requestStore = null;
export function bindRequestContext(store) {
  requestStore = store;
}

/** Active OTEL span ids, if tracing is initialised. Never a hard dependency. */
function traceFields() {
  try {
    // Resolved at call time so tracing.js can be absent (tests, one-off jobs).
    const api = globalThis.__otelApi;
    const span = api?.trace?.getActiveSpan?.();
    if (!span) return null;
    const ctx = span.spanContext();
    return ctx?.traceId ? { trace_id: ctx.traceId, span_id: ctx.spanId } : null;
  } catch {
    return null;
  }
}

const isProduction = env.NODE_ENV === 'production';

export const logger = pino({
  level: env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),

  base: {
    service: env.SERVICE_NAME,
    release: env.RELEASE_SHA ?? 'dev',
    env: env.NODE_ENV,
    // Which task produced the line. ECS rotates task ids; the log group alone is not enough.
    task: process.env.ECS_TASK_ID ?? process.env.HOSTNAME ?? undefined,
  },

  // CloudWatch sorts on this; ISO strings are also what Insights parses without a filter.
  timestamp: pino.stdTimeFunctions.isoTime,

  formatters: {
    // `level: "info"` rather than `level: 30` — the number costs a lookup table in every
    // dashboard query anyone ever writes.
    level: (label) => ({ level: label }),
    log: (object) => redact(object),
  },

  // Compiled by pino, so these cost far less than the deep walk in the formatter.
  redact: { paths: PINO_REDACT_PATHS, censor: '[redacted]' },

  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
    req: (req) => ({
      method: req.method,
      url: req.url?.split('?')[0], // query strings carry tokens more often than anyone expects
      route: req.route?.path,
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
    }),
    res: (res) => ({ statusCode: res.statusCode }),
  },

  /** Merged into every line. This is where the per-request identity arrives. */
  mixin() {
    const context = requestStore?.getStore?.();
    return {
      ...(context
        ? {
            requestId: context.requestId,
            traceId: context.traceId,
            userId: context.userId,
            tenantId: context.tenantId,
          }
        : {}),
      ...traceFields(),
    };
  },

  // Local development only. In production the transport would add a process and a failure
  // mode for the sake of colours.
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
        },
      }),
});

/**
 * Health and metrics endpoints are polled every few seconds by the load balancer, the
 * container agent and the scrape job. Logging them buries everything else and costs real
 * money in ingestion.
 */
export const SILENT_PATHS = new Set(['/healthz', '/readyz', '/startupz', '/healthz/sfu', '/metrics']);

export const childFor = (bindings) => logger.child(bindings);

/**
 * Last resort. An uncaught exception must produce one structured line before the process
 * dies, or the restart looks spontaneous in CloudWatch.
 */
export function installProcessHandlers() {
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'process: uncaught exception');
    // Flush, then let the platform restart us. Continuing after an uncaught exception means
    // running with unknown state.
    setTimeout(() => process.exit(1), 100).unref?.();
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? reason : new Error(String(reason)) }, 'process: unhandled rejection');
  });

  process.on('warning', (warning) => {
    logger.warn({ name: warning.name, message: warning.message }, 'process: node warning');
  });
}

export default logger;