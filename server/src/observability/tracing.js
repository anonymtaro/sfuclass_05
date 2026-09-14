/**
 * tracing — OTEL → X-Ray. [UNCHANGED — reference fassung]
 *
 * MUST be loaded before anything else. Auto-instrumentation works by patching modules as
 * they are required; a module already imported when the SDK starts is never patched, and
 * the symptom is a trace with an HTTP span and nothing underneath it — no pg, no redis, no
 * express. In ESM that means:
 *
 *     node --import ./src/observability/tracing.js src/server.js
 *
 * not an `import` at the top of server.js, which is too late by the time it runs.
 *
 * X-Ray specifics that are easy to miss:
 *  - X-Ray trace ids are not random 128-bit values; the first 32 bits are a timestamp. The
 *    ID generator below produces ids X-Ray will accept. Without it, spans are dropped
 *    silently at the collector.
 *  - The ALB and CloudFront already emit `X-Amzn-Trace-Id`. The propagator reads it, so a
 *    trace starts at the load balancer rather than at our first line of code.
 *
 * Sampling: head-based, with health checks excluded entirely. Polling every five seconds
 * from three sources produces more spans than real traffic on a quiet day, and pays for
 * the privilege.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import * as api from '@opentelemetry/api';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const serviceName = process.env.SERVICE_NAME ?? 'classroom-api';
const release = process.env.RELEASE_SHA ?? 'dev';

/** Paths that must never produce a span, however the sampler is configured. */
const IGNORED_PATHS = ['/healthz', '/readyz', '/startupz', '/healthz/sfu', '/metrics', '/favicon.ico'];

let sdk = null;

if (endpoint) {
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: release,
      'deployment.environment': process.env.NODE_ENV ?? 'development',
      // Which task a span came from, for the case where one node misbehaves.
      'aws.ecs.task.id': process.env.ECS_TASK_ID ?? undefined,
    }),

    // Both required for X-Ray to accept what we send.
    idGenerator: new AWSXRayIdGenerator(),
    textMapPropagator: new AWSXRayPropagator(),

    sampler: new ParentBasedSampler({
      // Respect an upstream decision; sample our own roots at the configured rate.
      root: new TraceIdRatioBasedSampler(Number(process.env.OTEL_SAMPLE_RATIO ?? 0.1)),
    }),

    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),

    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_INTERVAL_MS ?? 60_000),
    }),

    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => IGNORED_PATHS.some((path) => req.url?.startsWith(path)),
          // Outbound telemetry must not trace itself into a loop.
          ignoreOutgoingRequestHook: (options) => String(options.hostname ?? '').includes('otel'),
        },
        // Noise: every file read in the process becomes a span.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: false }, // parameters can be PII
        '@opentelemetry/instrumentation-ioredis': { requireParentSpan: true },
      }),
    ],
  });

  sdk.start();

  // Exposed so logger.js can stamp trace_id/span_id on every line without importing the
  // OTEL API itself — which would pull the SDK into modules that load before it.
  globalThis.__otelApi = api;

  // Flush on the way out: SIGTERM starts a drain, and unexported spans are lost otherwise.
  const shutdown = async () => {
    try {
      await sdk.shutdown();
    } catch {
      /* nothing useful to do at this point */
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export { sdk, api };
export default sdk;