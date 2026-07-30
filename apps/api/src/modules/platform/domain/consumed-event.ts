/**
 * The consumer-side counterpart to {@link PublishableEvent} (event-storming §2.3).
 *
 * A domain event as read back off the Valkey stream and re-materialised into the
 * durable envelope. The relay flattens the envelope into XADD fields; this is the
 * parsed, typed form a handler receives.
 */
export interface ConsumedEvent {
  /** The Valkey stream entry id (e.g. "1712345678901-0"), for ack/trace/replay. */
  readonly streamId: string;
  /** The outbox sequence, when present — null if the field was absent/malformed. */
  readonly seq: bigint | null;
  readonly eventId: string;
  readonly tenantId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly payload: Record<string, unknown>;
  /** Redis' PEL delivery counter — 1 on first delivery, higher on redelivery. */
  readonly deliveryCount: number;
  /** W3C trace-context from the producer (docs §2.2); null when tracing was off. */
  readonly traceparent: string | null;
  readonly tracestate: string | null;
}

/**
 * A consumer of domain events (context-map §5 "Published Language").
 *
 * Each handler names its own consumer group, so groups track independent
 * positions in the stream and one slow/failing consumer never blocks another.
 * `handles` lets the generic consumer ACK-and-skip events this handler does not
 * care about, without materialising a subscription list per event type.
 */
export interface EventHandler {
  /** The XREADGROUP consumer group this handler owns. Stable — it is durable state. */
  readonly consumerGroup: string;
  /** Whether this handler acts on the given event type; others are acked + skipped. */
  handles(eventType: string): boolean;
  /**
   * Processes one event. MUST be idempotent on `eventId` — delivery is
   * at-least-once, so the same event can arrive more than once. Throwing signals
   * a retryable failure; the consumer redelivers with backoff and, after the
   * configured limit, routes the event to the per-tenant DLQ.
   */
  handle(event: ConsumedEvent): Promise<void>;
}

/** DI token for the {@link EventHandler} an {@link EventStreamConsumer} drives. */
export const EVENT_HANDLER = Symbol("EVENT_HANDLER");

/**
 * Handlers the DEAD-LETTER admin path may replay through.
 *
 * ⚠️ A separate token from {@link EVENT_HANDLER}, deliberately. That one is
 * single-valued and bound only in the worker composition root, where the stream
 * consumer runs; this one is a LIST, is optional, and is bound in the API where
 * the admin surface lives. Overloading the single token would either break the
 * API's dependency graph or change what the consumer receives.
 *
 * Unbound means replay reports that no handler is registered in this process,
 * rather than failing to start.
 */
export const REPLAY_HANDLERS = Symbol("REPLAY_HANDLERS");
