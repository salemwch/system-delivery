import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";

import { AppConfigService } from "../../../shared/config/index.js";
// Import the token from its file, not the valkey barrel: the barrel also exports
// ValkeyModule, whose evaluation would pull in AppConfigModule (and its eager
// env validation). This publisher is exercised in tests, which have no real
// environment, so it must not drag the module graph in.
import { VALKEY_CLIENT } from "../../../shared/valkey/valkey.tokens.js";
import type { EventPublisher, PublishableEvent } from "../domain/event-publisher.js";

/**
 * Publishes domain events to a Valkey Stream (ADR-004, MVP transport).
 *
 * One stream at MVP. Consumers route on the `tenantId` field in the envelope,
 * and per-tenant topics arrive with Redpanda in V2 — the Postgres `outbox` table
 * remains the durable system of record, so this stream is a delivery buffer that
 * is safe to trim.
 *
 * The whole batch is written in a single pipelined round trip. That keeps the
 * relay's Postgres transaction — and the row locks it holds — open for the
 * shortest possible time.
 */
@Injectable()
export class ValkeyStreamEventPublisher implements EventPublisher {
  private readonly streamKey: string;
  private readonly maxLen: number;

  constructor(
    @Inject(VALKEY_CLIENT) private readonly valkey: Redis,
    config: AppConfigService,
  ) {
    this.streamKey = config.get("OUTBOX_STREAM_KEY");
    this.maxLen = config.get("OUTBOX_STREAM_MAXLEN");
  }

  async publishBatch(events: readonly PublishableEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const pipeline = this.valkey.pipeline();
    for (const event of events) {
      // `MAXLEN ~ N` is approximate trimming: Valkey trims in whole macro-nodes,
      // which is far cheaper than exact trimming and fine for a buffer whose
      // source of truth is Postgres. `*` lets Valkey assign the stream id.
      pipeline.call(
        "XADD",
        this.streamKey,
        "MAXLEN",
        "~",
        String(this.maxLen),
        "*",
        ...this.fieldsFor(event),
      );
    }

    const results = await pipeline.exec();
    if (results === null) {
      // A null result means the pipeline was discarded (e.g. connection lost
      // mid-flight). Treat it as a batch failure so the relay retries.
      throw new Error("Valkey pipeline returned no result");
    }
    for (const [error] of results) {
      if (error !== null) {
        throw error;
      }
    }
  }

  /** Flattens the envelope into the XADD field/value list. */
  private fieldsFor(event: PublishableEvent): string[] {
    const fields: string[] = [
      "seq",
      event.seq.toString(),
      "eventId",
      event.eventId,
      "tenantId",
      event.tenantId,
      "eventType",
      event.eventType,
      "eventVersion",
      String(event.eventVersion),
      "aggregateType",
      event.aggregateType,
      "aggregateId",
      event.aggregateId,
      "occurredAt",
      event.occurredAt.toISOString(),
      "payload",
      JSON.stringify(event.payload),
    ];
    // Optional correlation fields are omitted when absent rather than sent as the
    // string "null", so a consumer sees a missing field, not a fake value.
    if (event.correlationId !== null) {
      fields.push("correlationId", event.correlationId);
    }
    if (event.causationId !== null) {
      fields.push("causationId", event.causationId);
    }
    // W3C trace-context, carried verbatim so the consumer joins the producer's
    // trace. Omitted (not "null") when tracing was off at produce time.
    if (event.traceparent !== null) {
      fields.push("traceparent", event.traceparent);
    }
    if (event.tracestate !== null) {
      fields.push("tracestate", event.tracestate);
    }
    return fields;
  }
}
