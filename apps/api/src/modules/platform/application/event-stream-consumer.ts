import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";

import { AppConfigService } from "../../../shared/config/index.js";
import { DatabaseService, asTenantId, isUniqueViolation } from "../../../shared/database/index.js";
import { VALKEY_CLIENT } from "../../../shared/valkey/valkey.tokens.js";
import { deadLetterEvents, processedEvents } from "../domain/schema.js";
import { EVENT_HANDLER } from "../domain/consumed-event.js";
import type { ConsumedEvent, EventHandler } from "../domain/consumed-event.js";
import { parsePending, parseReadGroup } from "../domain/redis-stream-reply.js";
import type { StreamEntry } from "../domain/redis-stream-reply.js";

/** The DatabaseService the consumer writes its ledger + DLQ through (dp_app). */
export const CONSUMER_DATABASE = Symbol("CONSUMER_DATABASE");

/** Structured logger for the consumer (Pino, narrowed like the relay's). */
export const CONSUMER_LOGGER = Symbol("CONSUMER_LOGGER");

export interface ConsumerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Outcome of one poll cycle, returned so tests can drive deterministic passes. */
export interface ConsumeSummary {
  readonly handled: number;
  readonly skipped: number;
  readonly retried: number;
  readonly deadLettered: number;
}

/**
 * The generic event-stream consumer (event-storming §2.3) — the first thing that
 * CONSUMES the outbox stream the relay publishes to.
 *
 * One instance drives one {@link EventHandler} (one consumer group). Per poll:
 *
 *   1. Reclaim pending messages that have been idle too long (a crashed consumer)
 *      with XPENDING; retry them, or DLQ the ones that have exhausted their
 *      deliveries — a poison message never blocks the group.
 *   2. Read new messages with XREADGROUP ">" (blocking), and process each.
 *
 * Processing is idempotent: the `processed_events` ledger records every handled
 * eventId, so a redelivery (at-least-once) is a clean no-op. The consumer runs as
 * dp_app and sets tenant context from the envelope's tenantId before every write,
 * so RLS is enforced on the async path exactly as on the request path — the
 * handler's effects, the ledger row, and any DLQ row are all tenant-scoped.
 *
 * Mirrors {@link OutboxRelayService}'s start/stop lifecycle: it runs from
 * `onApplicationBootstrap` and drains its in-flight pass on shutdown.
 */
@Injectable()
export class EventStreamConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly streamKey: string;
  private readonly group: string;
  private readonly consumerName: string;
  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly maxDeliveries: number;
  private readonly claimMinIdleMs: number;

  private running = false;
  private loop: Promise<void> | undefined;
  private groupReady = false;

  constructor(
    @Inject(VALKEY_CLIENT) private readonly valkey: Redis,
    @Inject(CONSUMER_DATABASE) private readonly database: DatabaseService,
    @Inject(EVENT_HANDLER) private readonly handler: EventHandler,
    @Inject(CONSUMER_LOGGER) private readonly logger: ConsumerLogger,
    config: AppConfigService,
  ) {
    this.streamKey = config.get("OUTBOX_STREAM_KEY");
    this.group = handler.consumerGroup;
    // A unique name per instance, so multiple workers share the group and Redis
    // tracks each one's in-flight (pending) messages separately.
    this.consumerName = `${this.group}-${randomUUID().slice(0, 8)}`;
    this.batchSize = config.get("EVENT_CONSUMER_BATCH_SIZE");
    this.blockMs = config.get("EVENT_CONSUMER_BLOCK_MS");
    this.maxDeliveries = config.get("EVENT_CONSUMER_MAX_DELIVERIES");
    this.claimMinIdleMs = config.get("EVENT_CONSUMER_CLAIM_MIN_IDLE_MS");
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    this.logger.info({ group: this.group, consumer: this.consumerName }, "event consumer started");
    while (this.running) {
      try {
        await this.consumeOnce();
      } catch (error) {
        // A poll-level failure (Valkey unreachable, etc.) must not kill the loop.
        this.logger.error({ err: this.asError(error), group: this.group }, "event consume failed");
        await this.sleep(this.blockMs);
      }
    }
    this.logger.info({ group: this.group }, "event consumer stopped");
  }

  /**
   * Ensures the consumer group exists. `MKSTREAM` creates the stream if the relay
   * has not published to it yet; `$` starts the group at the tail so it only sees
   * events published after it was created — historical replay is a separate,
   * deliberate operation, not the default.
   */
  async ensureGroup(): Promise<void> {
    if (this.groupReady) {
      return;
    }
    try {
      await this.valkey.call("XGROUP", "CREATE", this.streamKey, this.group, "$", "MKSTREAM");
    } catch (error) {
      // BUSYGROUP means the group already exists — the expected steady state.
      if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) {
        throw error;
      }
    }
    this.groupReady = true;
  }

  /**
   * One poll cycle. Public so tests (and a future trigger) can drive a single
   * deterministic pass without the blocking loop.
   */
  async consumeOnce(): Promise<ConsumeSummary> {
    await this.ensureGroup();
    const reclaimed = await this.reclaimPending();
    const fresh = await this.readNew();

    let handled = 0;
    let skipped = 0;
    for (const entry of fresh) {
      const outcome = await this.processEntry(entry, 1);
      if (outcome === "handled") {
        handled++;
      } else if (outcome === "skipped") {
        skipped++;
      }
    }
    return {
      handled: handled + reclaimed.handled,
      skipped,
      retried: reclaimed.retried,
      deadLettered: reclaimed.deadLettered,
    };
  }

  /** Blocking read of new (never-delivered) messages. */
  private async readNew(): Promise<StreamEntry[]> {
    const reply = await this.valkey.call(
      "XREADGROUP",
      "GROUP",
      this.group,
      this.consumerName,
      "COUNT",
      String(this.batchSize),
      "BLOCK",
      String(this.blockMs),
      "STREAMS",
      this.streamKey,
      ">",
    );
    return parseReadGroup(reply);
  }

  /**
   * Reclaims messages left pending by a consumer that took too long / crashed.
   * Ones that have exhausted their deliveries are dead-lettered; the rest are
   * claimed and retried.
   */
  private async reclaimPending(): Promise<{
    handled: number;
    retried: number;
    deadLettered: number;
  }> {
    const reply = await this.valkey.call(
      "XPENDING",
      this.streamKey,
      this.group,
      "IDLE",
      String(this.claimMinIdleMs),
      "-",
      "+",
      String(this.batchSize),
    );
    const pending = parsePending(reply);

    let handled = 0;
    let retried = 0;
    let deadLettered = 0;
    for (const { id, deliveryCount } of pending) {
      const claimed = await this.claim(id);
      if (claimed === null) {
        continue; // another consumer got it first
      }
      if (deliveryCount >= this.maxDeliveries) {
        await this.deadLetter(claimed, `exhausted ${deliveryCount} deliveries`, deliveryCount);
        deadLettered++;
        continue;
      }
      retried++;
      const outcome = await this.processEntry(claimed, deliveryCount + 1);
      if (outcome === "handled") {
        handled++;
      }
    }
    return { handled, retried, deadLettered };
  }

  private async claim(id: string): Promise<StreamEntry | null> {
    const reply = await this.valkey.call(
      "XCLAIM",
      this.streamKey,
      this.group,
      this.consumerName,
      String(this.claimMinIdleMs),
      id,
    );
    const entries = parseReadGroup([[this.streamKey, reply]]);
    return entries[0] ?? null;
  }

  private async processEntry(
    entry: StreamEntry,
    deliveryCount: number,
  ): Promise<"handled" | "skipped" | "failed" | "malformed"> {
    const event = this.parseEvent(entry, deliveryCount);
    if (event === null) {
      // A message we cannot even parse (missing eventId/tenantId) is corrupt: we
      // cannot tenant-scope a DLQ row for it, so we ACK it out of the PEL and log
      // loudly. This is the single unavoidable drop, and it is never silent.
      this.logger.error(
        { streamId: entry.id, group: this.group },
        "dropping unparseable stream message",
      );
      await this.ack(entry.id);
      return "malformed";
    }

    if (!this.handler.handles(event.eventType)) {
      await this.ack(entry.id); // not our concern — advance past it
      return "skipped";
    }

    if (await this.alreadyProcessed(event)) {
      await this.ack(entry.id); // duplicate delivery — idempotent no-op
      return "skipped";
    }

    try {
      await this.handler.handle(event);
      await this.markProcessed(event);
      await this.ack(entry.id);
      return "handled";
    } catch (error) {
      // Leave the message pending (do NOT ack): reclaimPending retries it, and
      // dead-letters it once its deliveries are exhausted. Never dropped.
      this.logger.warn(
        {
          err: this.asError(error),
          group: this.group,
          eventId: event.eventId,
          eventType: event.eventType,
          deliveryCount,
        },
        "event handler failed; will retry",
      );
      return "failed";
    }
  }

  private async ack(streamId: string): Promise<void> {
    await this.valkey.call("XACK", this.streamKey, this.group, streamId);
  }

  private async alreadyProcessed(event: ConsumedEvent): Promise<boolean> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ id: processedEvents.id })
        .from(processedEvents)
        .where(
          and(
            eq(processedEvents.consumerGroup, this.group),
            eq(processedEvents.eventId, event.eventId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    }, asTenantId(event.tenantId));
  }

  private async markProcessed(event: ConsumedEvent): Promise<void> {
    try {
      await this.database.withTenant(async (tx) => {
        await tx.insert(processedEvents).values({
          tenantId: event.tenantId,
          consumerGroup: this.group,
          eventId: event.eventId,
          eventType: event.eventType,
        });
      }, asTenantId(event.tenantId));
    } catch (error) {
      // A concurrent consumer recorded it first — that is the ledger working, not
      // an error. Any other failure propagates.
      if (!isUniqueViolation(error, "processed_events_group_event_uq")) {
        throw error;
      }
    }
  }

  private async deadLetter(
    entry: StreamEntry,
    error: string,
    deliveryCount: number,
  ): Promise<void> {
    const event = this.parseEvent(entry, deliveryCount);
    if (event === null) {
      this.logger.error(
        { streamId: entry.id, group: this.group },
        "cannot dead-letter unparseable message; acking",
      );
      await this.ack(entry.id);
      return;
    }
    const payload = event.payload;
    await this.database.withTenant(async (tx) => {
      await tx
        .insert(deadLetterEvents)
        .values({
          tenantId: event.tenantId,
          consumerGroup: this.group,
          eventId: event.eventId,
          eventType: event.eventType,
          streamId: entry.id,
          payload,
          error: error.slice(0, 2000),
          deliveryCount,
        })
        .onConflictDoUpdate({
          target: [deadLetterEvents.consumerGroup, deadLetterEvents.eventId],
          set: {
            deliveryCount,
            error: error.slice(0, 2000),
            lastFailedAt: new Date(),
          },
        });
    }, asTenantId(event.tenantId));
    await this.ack(entry.id);
    this.logger.warn(
      {
        group: this.group,
        eventId: event.eventId,
        eventType: event.eventType,
        deliveryCount,
        // event-storming §62: a DLQ arrival is an alert, not a log line to ignore.
        alert: "event.dead_lettered",
      },
      "event routed to dead-letter queue",
    );
  }

  /** Re-materialises the durable envelope from the XADD fields, or null if invalid. */
  private parseEvent(entry: StreamEntry, deliveryCount: number): ConsumedEvent | null {
    const f = entry.fields;
    const eventId = f.get("eventId");
    const tenantId = f.get("tenantId");
    const eventType = f.get("eventType");
    const aggregateType = f.get("aggregateType");
    const aggregateId = f.get("aggregateId");
    if (
      eventId === undefined ||
      tenantId === undefined ||
      eventType === undefined ||
      aggregateType === undefined ||
      aggregateId === undefined
    ) {
      return null;
    }
    return {
      streamId: entry.id,
      seq: parseBigInt(f.get("seq")),
      eventId,
      tenantId,
      eventType,
      eventVersion: parseIntOr(f.get("eventVersion"), 1),
      aggregateType,
      aggregateId,
      occurredAt: parseDate(f.get("occurredAt")),
      correlationId: f.get("correlationId") ?? null,
      causationId: f.get("causationId") ?? null,
      payload: parsePayload(f.get("payload")),
      deliveryCount,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function parseBigInt(value: string | undefined): bigint | null {
  if (value === undefined) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseDate(value: string | undefined): Date {
  if (value === undefined) {
    return new Date();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function parsePayload(value: string | undefined): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
