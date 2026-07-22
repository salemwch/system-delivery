/**
 * The domain event envelope (docs/03-event-storming.md §2.2).
 *
 * Every event on every transport carries these fields. The envelope is the
 * platform's most durable contract — harder to change than a REST response,
 * because consumers are numerous and eventually not all ours.
 */
export interface DomainEventInput {
  /** domain.fact, past tense, e.g. "shipment.delivered". Validated on publish. */
  readonly eventType: string;
  /** The aggregate root type this event is about, e.g. "shipment". */
  readonly aggregateType: string;
  /** Partition key. Ordering is guaranteed per aggregateId, and nowhere else. */
  readonly aggregateId: string;
  /** The fact itself — self-contained enough to act on, not a full entity dump. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Schema version. Incremented only on a breaking change. Defaults to 1. */
  readonly eventVersion?: number;
  /** Business time — when the fact happened. Defaults to now() at publish. */
  readonly occurredAt?: Date;
  /** Ties one user action to everything it causes across async fan-out. */
  readonly correlationId?: string;
  /** The event or command that directly produced this one. */
  readonly causationId?: string;
}

/** `domain.fact` — two lowercase/underscore segments joined by a dot. */
const EVENT_TYPE_PATTERN = /^[a-z_]+\.[a-z_]+$/;

/**
 * Validates an event type at publish time.
 *
 * Enforces the past-tense fact naming from event-storming §2.1 at the point of
 * publication, so a malformed type is a runtime error at its source rather than
 * a consumer silently never matching it.
 */
export function assertValidEventType(eventType: string): void {
  if (!EVENT_TYPE_PATTERN.test(eventType)) {
    throw new Error(
      `Invalid event type "${eventType}". Events are named domain.fact in past tense, ` +
        `lowercase with underscores, e.g. "shipment.delivered".`,
    );
  }
}
