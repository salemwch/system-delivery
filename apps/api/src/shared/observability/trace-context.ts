import { context as otelContext, ROOT_CONTEXT } from "@opentelemetry/api";
import type { Context, TextMapGetter, TextMapSetter } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

/**
 * W3C trace-context carried across the asynchronous outbox hop.
 *
 * A domain event is produced inside a request (an active span), written to the
 * `outbox`, relayed to a Valkey Stream, and consumed later — in another process.
 * Nothing in that chain is a synchronous call, so the runtime context manager
 * cannot link the consumer's work back to the producer. We therefore serialise
 * the active context into the durable envelope (`traceparent`/`tracestate`, the
 * W3C headers) at produce time and re-hydrate it at consume time, so one trace
 * spans the whole flow. See docs/03-event-storming.md §2.2.
 */
export interface TraceCarrier {
  readonly traceparent?: string;
  readonly tracestate?: string;
}

/**
 * An explicit W3C propagator instance, NOT the global `propagation` API.
 *
 * The global propagator is a no-op until an SDK registers one, so relying on it
 * would make these helpers untestable without booting the whole SDK — and would
 * silently produce empty carriers under test. A dedicated instance always speaks
 * W3C trace-context, whether or not telemetry is running.
 */
const propagator = new W3CTraceContextPropagator();

const setter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

const getter: TextMapGetter<Record<string, string>> = {
  keys(carrier) {
    return Object.keys(carrier);
  },
  get(carrier, key) {
    return carrier[key];
  },
};

/**
 * Serialises the active span context into a {@link TraceCarrier}.
 *
 * Returns an empty carrier when no span is active (no SDK running, or work
 * outside a request) — the correct no-op, so producers never fabricate a trace.
 */
export function captureTraceContext(ctx: Context = otelContext.active()): TraceCarrier {
  const carrier: Record<string, string> = {};
  propagator.inject(ctx, carrier, setter);

  const traceparent = carrier["traceparent"];
  const tracestate = carrier["tracestate"];
  // Built conditionally so an absent field is genuinely absent, never `undefined`
  // assigned to an optional property (exactOptionalPropertyTypes).
  return {
    ...(traceparent === undefined ? {} : { traceparent }),
    ...(tracestate === undefined ? {} : { tracestate }),
  };
}

/**
 * Re-hydrates a {@link TraceCarrier} into a {@link Context} suitable for parenting
 * a consumer span. With no `traceparent` the carrier is empty and `base` is
 * returned unchanged, so the consumer simply starts a fresh (root) trace.
 */
export function contextFromCarrier(carrier: TraceCarrier, base: Context = ROOT_CONTEXT): Context {
  if (carrier.traceparent === undefined) {
    return base;
  }
  const record: Record<string, string> = { traceparent: carrier.traceparent };
  if (carrier.tracestate !== undefined) {
    record["tracestate"] = carrier.tracestate;
  }
  return propagator.extract(base, record, getter);
}
