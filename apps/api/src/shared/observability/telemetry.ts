import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { FastifyInstrumentation } from "@opentelemetry/instrumentation-fastify";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * OpenTelemetry SDK bootstrap (docs/09-infrastructure.md §4, ADR — Observability).
 *
 * This module runs BEFORE the Nest DI container exists, so — like the config
 * schema — it is the one sanctioned place that reads `process.env` directly. It
 * must be imported before anything it instruments (Node's http, Fastify,
 * ioredis), which is why the process entry points import `instrumentation.ts` /
 * `worker-instrumentation.ts` as their very first statement.
 *
 * Fail-open by design: with no `OTEL_EXPORTER_OTLP_ENDPOINT` the SDK is never
 * started, so local, test, and CI runs carry zero tracing overhead and no
 * behaviour change. Tracing switches on purely by pointing the endpoint at a
 * collector in staging/production — no code change, no redeploy of intent.
 *
 * postgres.js has no OpenTelemetry instrumentation (the official `pg`
 * instrumentation targets node-postgres, a different driver), so database spans
 * are emitted manually by `DatabaseService.withTenant` via the shared tracer —
 * not from auto-instrumentation here.
 */
let sdk: NodeSDK | undefined;

export function startTelemetry(fallbackServiceName: string): void {
  // Idempotent: a second call (e.g. a test double-import) is a no-op.
  if (sdk !== undefined) {
    return;
  }

  const endpoint = (process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "").trim();
  if (endpoint.length === 0) {
    // No collector configured → telemetry fully disabled. This is the default in
    // local/test/CI, so they are entirely unaffected.
    return;
  }

  const serviceName = (process.env["OTEL_SERVICE_NAME"] ?? "").trim() || fallbackServiceName;
  const environment = (process.env["NODE_ENV"] ?? "development").trim();

  const started = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      // Incubating attribute; a literal key avoids importing the unstable module.
      "deployment.environment.name": environment,
    }),
    // The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS / _PROTOCOL from
    // the environment per the OTLP spec — we only decide whether to start at all.
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });

  started.start();
  sdk = started;

  // Flush buffered spans on shutdown. Best-effort and non-blocking: Nest's own
  // shutdown hooks close the app in parallel, and we never call process.exit, so
  // this does not truncate the relay's in-flight drain or the connection close.
  const flush = (): void => {
    void started.shutdown().catch(() => undefined);
  };
  process.once("SIGTERM", flush);
  process.once("SIGINT", flush);
}
