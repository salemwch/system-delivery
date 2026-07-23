import { Injectable } from "@nestjs/common";

import { TenantContext } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { captureTraceContext } from "../../../shared/observability/index.js";
import { assertValidEventType } from "../domain/domain-event.js";
import type { DomainEventInput } from "../domain/domain-event.js";
import { outbox } from "../domain/schema.js";

/**
 * Transactional event publication (ADR-004).
 *
 * `publish` writes the event row using the CALLER'S transaction — the same one
 * that carried the business change. That is the whole point: the event and the
 * state change commit together or not at all. There is no separate "now send
 * it" step that could be lost to a crash.
 *
 * A relay (added next) reads unpublished rows and delivers them. Consumers are
 * idempotent on eventId, because at-least-once delivery means duplicates are
 * normal operation.
 */
@Injectable()
export class OutboxService {
  /**
   * Appends an event to the outbox inside the given transaction.
   *
   * Must be called with the same `tx` used for the business write. Calling it
   * with a fresh transaction would reintroduce the dual-write problem the
   * outbox exists to prevent, so the transaction is a required argument rather
   * than something this service opens itself.
   *
   * @returns the generated eventId, which is the consumer idempotency key.
   */
  async publish(tx: TenantTransaction, event: DomainEventInput): Promise<string> {
    assertValidEventType(event.eventType);

    // Tenant comes from the ambient context, never from the caller — an event
    // published under the wrong tenant is a cross-tenant corruption vector, and
    // the envelope requires tenant_id without exception (event-storming §2.2).
    const tenantId = TenantContext.requireTenantId();

    // Capture the active trace-context so the eventual consumer — running in
    // another process, off a Valkey stream — can join this same trace. Empty
    // (both null) when tracing is disabled or no span is active; never fabricated.
    const trace = captureTraceContext();

    const inserted = await tx
      .insert(outbox)
      .values({
        tenantId,
        eventType: event.eventType,
        eventVersion: event.eventVersion ?? 1,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: event.payload,
        ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
        ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
        ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
        ...(trace.traceparent === undefined ? {} : { traceparent: trace.traceparent }),
        ...(trace.tracestate === undefined ? {} : { tracestate: trace.tracestate }),
      })
      .returning({ eventId: outbox.eventId });

    const row = inserted[0];
    if (row === undefined) {
      // Insert with RETURNING yields exactly one row or throws; this guards the
      // type rather than a reachable state.
      throw new Error("Outbox insert returned no row");
    }
    return row.eventId;
  }
}
