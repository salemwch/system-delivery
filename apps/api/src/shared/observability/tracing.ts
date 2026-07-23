import { context as otelContext, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Context, Span, SpanOptions } from "@opentelemetry/api";

/**
 * The tracer name every span in this codebase is created under.
 *
 * A single instrumentation-scope name keeps our manual spans (database
 * transactions, event consumption) grouped and distinct from the auto-generated
 * HTTP/Fastify/ioredis spans, whose scope is the instrumentation package.
 */
export const TRACER_NAME = "@delivery/api";

/**
 * The active tracer. When no SDK is running (local, test, CI — no OTLP endpoint
 * configured) this is the API's no-op tracer, so every helper below degrades to
 * running its callback with negligible overhead and no exported spans.
 */
export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Runs `fn` inside a new active span, recording exceptions and error status, and
 * always ending the span.
 *
 * When `parent` is supplied the span is parented to that context (used to link a
 * consumer span to the remote producer context extracted from an event); when
 * omitted the ambient active context is the parent (the normal in-process case).
 */
export async function withSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
  parent?: Context,
): Promise<T> {
  const tracer = getTracer();
  const run = (): Promise<T> =>
    tracer.startActiveSpan(name, options, async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        throw error;
      } finally {
        span.end();
      }
    });
  return parent === undefined ? run() : otelContext.with(parent, run);
}
