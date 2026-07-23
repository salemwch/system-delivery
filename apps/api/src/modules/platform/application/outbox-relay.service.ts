import { Inject, Injectable } from "@nestjs/common";
import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { and, asc, inArray, isNull, lte, sql } from "drizzle-orm";

import { AppConfigService } from "../../../shared/config/index.js";
import type { Database } from "../../../shared/database/index.js";
import { EVENT_PUBLISHER } from "../domain/event-publisher.js";
import type { EventPublisher, PublishableEvent } from "../domain/event-publisher.js";
import { outbox } from "../domain/schema.js";

/**
 * The relay's Drizzle instance, bound to the `dp_relay` connection.
 *
 * Kept separate from the request-path `DatabaseService` (which is `dp_app` and
 * tenant-scoped): the relay reads across every tenant, which only `dp_relay` may
 * do. The worker module provides this token.
 */
export const RELAY_DATABASE = Symbol("RELAY_DATABASE");

/** Structured logger for the relay. Provided from Pino by the worker module. */
export const RELAY_LOGGER = Symbol("RELAY_LOGGER");

/**
 * The subset of a Pino logger the relay uses.
 *
 * A narrow port, so the relay can be constructed with a trivial stub in tests
 * without standing up the logging module — the implementation is still Pino.
 */
export interface RelayLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Outcome of one drain pass. */
export interface DrainSummary {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

/**
 * Outbox relay (docs/03-event-storming.md §2.3, docs/06-database-design.md §4.8).
 *
 * Drains the transactional outbox into the event transport. One pass:
 *
 *   1. Claim a batch of due, unpublished rows in `seq` order, with
 *      `FOR UPDATE SKIP LOCKED` — so multiple relay instances process disjoint
 *      batches without coordinating, and a row another instance is mid-publish on
 *      is skipped, not blocked on.
 *   2. Publish the batch to the transport.
 *   3. On success, stamp `published_at`. On failure, advance `next_attempt_at`
 *      with capped exponential backoff and record the error — the batch is
 *      retried, never dropped.
 *
 * The claim, publish, and stamp all happen inside ONE transaction, so the row
 * locks are held across the publish. That is what makes the SKIP LOCKED
 * coordination correct: a crashed relay's in-flight rows unlock on rollback and
 * are re-claimed, at-least-once.
 *
 * A persistently unpublished row is surfaced by the oldest-age alert, because a
 * stalled relay is silent and severe (docs §4.8).
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly alertAgeSeconds: number;

  private running = false;
  private loop: Promise<void> | undefined;
  /** Resolves the current idle sleep early, so shutdown is immediate. */
  private wake: (() => void) | undefined;

  constructor(
    // The dedicated dp_relay connection — cross-tenant by design, NOT the
    // request-path tenant-scoped DatabaseService pool. Its transactions
    // deliberately span tenants (the relay drains every tenant's outbox in one
    // seq-ordered scan), which only dp_relay's table-scoped policy permits.
    @Inject(RELAY_DATABASE) private readonly relayDb: Database,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(RELAY_LOGGER) private readonly logger: RelayLogger,
    config: AppConfigService,
  ) {
    this.batchSize = config.get("OUTBOX_RELAY_BATCH_SIZE");
    this.pollIntervalMs = config.get("OUTBOX_RELAY_POLL_INTERVAL_MS");
    this.baseBackoffMs = config.get("OUTBOX_RELAY_BASE_BACKOFF_MS");
    this.maxBackoffMs = config.get("OUTBOX_RELAY_MAX_BACKOFF_MS");
    this.alertAgeSeconds = config.get("OUTBOX_RELAY_ALERT_AGE_SECONDS");
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Starts the drain loop. Idempotent — a second call while running is a no-op. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  /** Signals the loop to stop and waits for the in-flight pass to finish. */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    this.logger.info(
      { batchSize: this.batchSize, pollIntervalMs: this.pollIntervalMs },
      "outbox relay started",
    );
    while (this.running) {
      let summary: DrainSummary | undefined;
      try {
        summary = await this.drainOnce();
      } catch (error) {
        // A drain-level failure (e.g. the database is unreachable) must not kill
        // the loop — log and fall through to the backoff sleep, then retry.
        this.logger.error({ err: this.asError(error) }, "outbox relay drain failed");
      }

      await this.reportOldestUnpublished();

      // A full batch means more may be waiting — loop again immediately rather
      // than sleeping, so a backlog drains at full speed.
      if (summary !== undefined && summary.claimed >= this.batchSize) {
        continue;
      }
      if (this.running) {
        await this.sleep(this.pollIntervalMs);
      }
    }
    this.logger.info({}, "outbox relay stopped");
  }

  /**
   * Processes a single batch. Public so tests (and a future cron trigger) can
   * drive one deterministic pass without the loop.
   */
  async drainOnce(): Promise<DrainSummary> {
    return this.relayDb.transaction(async (tx) => {
      const claimed = await tx
        .select()
        .from(outbox)
        .where(and(isNull(outbox.publishedAt), lte(outbox.nextAttemptAt, sql`now()`)))
        .orderBy(asc(outbox.seq))
        .limit(this.batchSize)
        .for("update", { skipLocked: true });

      if (claimed.length === 0) {
        return { claimed: 0, published: 0, failed: 0 };
      }

      const seqs = claimed.map((row) => row.seq);
      const events: PublishableEvent[] = claimed.map((row) => ({
        seq: row.seq,
        eventId: row.eventId,
        tenantId: row.tenantId,
        eventType: row.eventType,
        eventVersion: row.eventVersion,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        correlationId: row.correlationId,
        causationId: row.causationId,
        occurredAt: row.occurredAt,
        payload: row.payload,
        traceparent: row.traceparent,
        tracestate: row.tracestate,
      }));

      try {
        await this.publisher.publishBatch(events);
      } catch (error) {
        const message = this.asError(error).message.slice(0, 1000);
        // Capped exponential backoff, computed in SQL against the row's CURRENT
        // attempts (pre-increment): first failure waits `base`, then doubles up
        // to `max`. `least(attempts, 16)` caps the exponent so `2 ^ n` cannot
        // overflow. Rows stay unpublished and are retried — never dropped.
        await tx
          .update(outbox)
          .set({
            attempts: sql`${outbox.attempts} + 1`,
            lastError: message,
            nextAttemptAt: sql`now() + make_interval(secs => least(
              ${this.maxBackoffMs}::double precision,
              ${this.baseBackoffMs}::double precision * power(2, least(${outbox.attempts}, 16))
            ) / 1000.0)`,
          })
          .where(inArray(outbox.seq, seqs));

        this.logger.warn(
          { err: this.asError(error), count: claimed.length },
          "outbox publish failed; backing off",
        );
        return { claimed: claimed.length, published: 0, failed: claimed.length };
      }

      await tx
        .update(outbox)
        .set({ publishedAt: sql`now()`, lastError: null })
        .where(inArray(outbox.seq, seqs));

      this.logger.info({ count: claimed.length }, "outbox batch published");
      return { claimed: claimed.length, published: claimed.length, failed: 0 };
    });
  }

  /**
   * Age, in seconds, of the oldest unpublished event — or `null` when the outbox
   * is fully drained. This is the relay's primary health signal.
   */
  async oldestUnpublishedAgeSeconds(): Promise<number | null> {
    const rows = await this.relayDb
      .select({
        age: sql<
          number | null
        >`extract(epoch from now() - min(${outbox.occurredAt}))::double precision`,
      })
      .from(outbox)
      .where(isNull(outbox.publishedAt));
    return rows[0]?.age ?? null;
  }

  private async reportOldestUnpublished(): Promise<void> {
    let age: number | null;
    try {
      age = await this.oldestUnpublishedAgeSeconds();
    } catch (error) {
      this.logger.error(
        { err: this.asError(error) },
        "outbox relay could not read oldest-unpublished age",
      );
      return;
    }
    if (age !== null && age > this.alertAgeSeconds) {
      this.logger.warn(
        { oldestUnpublishedAgeSeconds: age, thresholdSeconds: this.alertAgeSeconds },
        "outbox.relay.stalled: oldest unpublished event exceeds alert threshold",
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }

  private asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
