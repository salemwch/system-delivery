import { ROOT_CONTEXT, TraceFlags, context, trace } from "@opentelemetry/api";
import type { SpanContext } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import {
  captureTraceContext,
  contextFromCarrier,
  withSpan,
} from "../src/shared/observability/index.js";

/**
 * These exercise the trace-context that survives the asynchronous outbox hop
 * WITHOUT booting the OpenTelemetry SDK — proving the helpers are self-contained
 * (an explicit W3C propagator, not the global no-op one) and that everything
 * degrades cleanly to a no-op when tracing is disabled, which is the state of
 * local/test/CI. The producer→relay→consumer wiring is covered end-to-end in
 * outbox-relay.spec.ts / notification.spec.ts.
 */
describe("observability trace-context", () => {
  // W3C spec example ids — a valid, sampled remote parent.
  const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
  const SPAN_ID = "b7ad6b7169203331";

  function contextWithSpan(): ReturnType<typeof trace.setSpanContext> {
    const spanContext: SpanContext = {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };
    return trace.setSpanContext(ROOT_CONTEXT, spanContext);
  }

  it("captures an empty carrier when no span is active", () => {
    const carrier = captureTraceContext(ROOT_CONTEXT);
    expect(carrier.traceparent).toBeUndefined();
    expect(carrier.tracestate).toBeUndefined();
  });

  it("serialises the active span context into a W3C traceparent", () => {
    const carrier = captureTraceContext(contextWithSpan());
    expect(carrier.traceparent).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it("round-trips produce → consume: the extracted context carries the same trace", () => {
    const carrier = captureTraceContext(contextWithSpan());
    const extracted = contextFromCarrier(carrier);

    const spanContext = trace.getSpanContext(extracted);
    expect(spanContext).toBeDefined();
    expect(spanContext?.traceId).toBe(TRACE_ID);
    expect(spanContext?.spanId).toBe(SPAN_ID);
    // A context reconstructed from headers is, by definition, remote.
    expect(spanContext?.isRemote).toBe(true);
  });

  it("returns the base context unchanged for an empty carrier", () => {
    const extracted = contextFromCarrier({});
    expect(extracted).toBe(ROOT_CONTEXT);
    expect(trace.getSpanContext(extracted)).toBeUndefined();
  });

  it("ignores a malformed traceparent rather than throwing", () => {
    const extracted = contextFromCarrier({ traceparent: "not-a-valid-header" });
    expect(trace.getSpanContext(extracted)).toBeUndefined();
  });
});

describe("observability withSpan (no SDK → no-op tracer)", () => {
  it("runs the callback and returns its value", async () => {
    const result = await withSpan("test.op", {}, () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("propagates the callback's error", async () => {
    await expect(withSpan("test.op", {}, () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
  });

  it("parents to a supplied remote context without throwing", async () => {
    const parent = contextFromCarrier({ traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01` });
    const seen = await withSpan(
      "test.op",
      {},
      () => Promise.resolve(trace.getSpanContext(context.active())?.traceId ?? null),
      parent,
    );
    // With no SDK the context manager is a no-op, so no active span context is
    // established — the call must still complete cleanly.
    expect(seen).toBeNull();
  });
});
