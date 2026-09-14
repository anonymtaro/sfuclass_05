/**
 * metrics — system and business metrics. [EXT] (F7)
 *
 * The interface the rest of the codebase uses is three calls:
 *
 *     metrics.increment(name, value?, attributes?)   counter
 *     metrics.gauge(name, value, attributes?)        last-value gauge
 *     metrics.observe(name, value, attributes?)      histogram
 *
 * They are called with optional chaining (`metrics.increment?.(…)`) everywhere on purpose:
 * a metrics backend that is missing or misconfigured must never be able to throw inside a
 * request handler. Instrumentation that can break the thing it measures does not get
 * turned on.
 *
 * Business metrics sit next to system metrics deliberately — CPU and memory tell you the
 * tasks are alive, not that lessons are working. The ones that page someone are rooms live,
 * transcode lag and chat delivery latency, and none of those can be derived from CPU.
 *
 * Cardinality is the thing to be careful with. Attributes must be bounded sets: a queue
 * name, a source kind, a status. Never a user id, room id, asset id or tenant id in a
 * metric attribute — that is what logs and traces are for, and it is how a metrics bill
 * reaches four figures in a week.
 */

import { metrics as otelMetrics, ValueType } from '@opentelemetry/api';

import { env } from '../config/env.js';
import { logger } from './logger.js';

const meter = otelMetrics.getMeter(env.SERVICE_NAME ?? 'classroom', env.RELEASE_SHA ?? 'dev');

/* ------------------------------------------------------------------ *
 * Instrument registry — created lazily, cached by name
 * ------------------------------------------------------------------ */

const counters = new Map();
const histograms = new Map();
const gauges = new Map();
const gaugeValues = new Map();

/** Buckets chosen per family: a queue wait and an HTTP handler do not share a scale. */
const BUCKETS = {
  ms_fast: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  ms_slow: [100, 500, 1000, 5000, 15_000, 60_000, 300_000, 900_000, 3_600_000],
  bytes: [1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 5e9],
};

function bucketsFor(name) {
  if (name.endsWith('_bytes')) return BUCKETS.bytes;
  if (/transcode|recording|job|queue/.test(name)) return BUCKETS.ms_slow;
  return BUCKETS.ms_fast;
}

function counter(name) {
  if (!counters.has(name)) {
    counters.set(name, meter.createCounter(name, { valueType: ValueType.INT }));
  }
  return counters.get(name);
}

function histogram(name) {
  if (!histograms.has(name)) {
    histograms.set(
      name,
      meter.createHistogram(name, {
        unit: name.endsWith('_bytes') ? 'By' : 'ms',
        advice: { explicitBucketBoundaries: bucketsFor(name) },
      }),
    );
  }
  return histograms.get(name);
}

/**
 * OTEL gauges are observable: the value is read at collection time rather than pushed. So
 * `gauge()` stores the latest value and an observable callback reports it.
 */
function gauge(name) {
  if (!gauges.has(name)) {
    const observable = meter.createObservableGauge(name);
    observable.addCallback((result) => {
      for (const [serialised, value] of gaugeValues.get(name) ?? []) {
        result.observe(value, JSON.parse(serialised));
      }
    });
    gauges.set(name, observable);
    gaugeValues.set(name, new Map());
  }
  return gaugeValues.get(name);
}

function guard(fn) {
  return (...args) => {
    try {
      fn(...args);
    } catch (error) {
      // Once, not per call: a broken exporter must not also flood the log.
      if (!guard.warned) {
        guard.warned = true;
        logger.warn({ err: error }, 'metrics: instrument failed, continuing without metrics');
      }
    }
  };
}

export const metrics = {
  increment: guard((name, value = 1, attributes = {}) => counter(name).add(value, attributes)),
  gauge: guard((name, value, attributes = {}) => gauge(name).set(JSON.stringify(attributes), value)),
  observe: guard((name, value, attributes = {}) => histogram(name).record(value, attributes)),

  /** `const done = metrics.timer('x'); … done({ outcome: 'ok' })` */
  timer(name) {
    const started = process.hrtime.bigint();
    return (attributes = {}) => {
      metrics.observe(name, Number(process.hrtime.bigint() - started) / 1e6, attributes);
    };
  },
};

/* ------------------------------------------------------------------ *
 * Named instruments — the ones that appear on a dashboard or an alarm
 * ------------------------------------------------------------------ */

/**
 * Documented here rather than scattered through the code, so that a dashboard change and a
 * code change can be reviewed against the same list. Attributes are shown with their
 * allowed values; anything unbounded is a bug.
 */
export const INSTRUMENTS = Object.freeze({
  // Classroom (F1)
  classroom_rooms_live: 'gauge · rooms currently live on this node',
  classroom_peer_joined: 'counter · {role}',
  classroom_peer_left: 'counter · {reason}',
  classroom_producer_created: 'counter · {source: cam|mic|screen|screenAudio}',
  classroom_screenshare_started: 'counter',
  sfu_producers_per_node: 'gauge · drives the saturation alarm',

  // Media and uploads (F4)
  upload_started: 'counter · {purpose}',
  upload_completed: 'counter · {purpose}',
  upload_bytes: 'histogram · bytes',
  upload_duration_ms: 'histogram',
  transcode_submitted: 'counter · {ladder}',
  transcode_completed: 'counter · {via: webhook|poll}',
  transcode_failed: 'counter · {reason}',
  transcode_lag_ms: 'gauge · oldest queued transcode — pages someone',
  transcode_stuck_assets: 'gauge',
  storage_quota_drift_bytes: 'gauge',
  recording_mux_ms: 'histogram',

  // Community and feeds (F2)
  feed_query_ms: 'histogram · {feed: space|personal}',
  feed_items_returned: 'histogram',
  notification_fanout: 'counter · {kind}',
  notification_digest_sent: 'counter',

  // Chat (F6)
  chat_message_sent: 'counter · {scope: direct|channel}',
  chat_delivery_latency_ms: 'histogram · send → socket emit; p95 > 1s pages someone',
  chat_fanout_participants: 'counter',
  chat_search_ms: 'histogram',

  // Platform (F7)
  http_request_ms: 'histogram · {method, route, status_class}',
  pg_query_ms: 'histogram',
  pg_idle_client_error: 'counter · {pool}',
  redis_cache_hit: 'counter',
  redis_cache_miss: 'counter',
  queue_depth: 'gauge · {queue}',
  queue_job_ms: 'histogram · {queue, job, outcome}',
  queue_job_dead: 'counter · {queue, job}',
  scheduled_job_ms: 'histogram · {job, outcome}',
  socket_auth_ok: 'counter',
  socket_auth_rejected: 'counter · {reason}',
});

/**
 * Express middleware. Route pattern, not the URL: `/courses/:id` is one series,
 * `/courses/<uuid>` is a million.
 */
export function httpMetrics() {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path ?? req.baseUrl ?? 'unmatched';
      metrics.observe?.('http_request_ms', Number(process.hrtime.bigint() - started) / 1e6, {
        method: req.method,
        route,
        status_class: `${Math.floor(res.statusCode / 100)}xx`,
      });
    });
    next();
  };
}

export default metrics;