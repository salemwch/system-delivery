/**
 * The port between the outbox relay and whatever transport carries events.
 *
 * At MVP the transport is a Valkey Stream (ADR-004); in V2 it becomes Redpanda.
 * The relay depends only on this interface, so that swap is an adapter change,
 * never a relay change.
 */

/**
 * A fully-materialised outbox row, ready to hand to a transport.
 *
 * This is the durable envelope from docs/03-event-storming.md §2.2, plus the
 * `seq` the relay orders by. `payload` is `unknown`: the outbox stores arbitrary
 * per-event JSON, and the publisher only serialises it — it never inspects it.
 */
export interface PublishableEvent {
  readonly seq: bigint;
  readonly eventId: string;
  readonly tenantId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

export interface EventPublisher {
  /**
   * Delivers a batch of events to the transport, preserving their order.
   *
   * Resolves only when every event is durably accepted by the transport. If any
   * event fails, it rejects — the relay then leaves the whole batch unpublished
   * and retries with backoff. Delivery is at-least-once, so a partially-applied
   * batch that is retried produces duplicates; consumers dedupe on `eventId`.
   */
  publishBatch(events: readonly PublishableEvent[]): Promise<void>;
}

/** DI token for the active {@link EventPublisher} implementation. */
export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");
