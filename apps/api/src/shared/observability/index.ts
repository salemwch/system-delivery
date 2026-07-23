/**
 * Observability primitives shared across modules (docs/09-infrastructure.md §4).
 *
 * Deliberately does NOT re-export `telemetry.ts`. That module boots the
 * OpenTelemetry SDK and pulls in the instrumentation packages, which must be
 * loaded before anything they patch (http, fastify, ioredis). It is imported
 * only by the process entry points, via `instrumentation.ts`, never through this
 * barrel — the same rule that keeps `AppConfigModule` out of the config barrel.
 */
export { captureTraceContext, contextFromCarrier } from "./trace-context.js";
export type { TraceCarrier } from "./trace-context.js";
export { getTracer, withSpan, TRACER_NAME } from "./tracing.js";
