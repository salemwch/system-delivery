import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import { BusinessRuleError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { REPLAY_HANDLERS } from "../domain/consumed-event.js";
import type { ConsumedEvent, EventHandler } from "../domain/consumed-event.js";
import { deadLetterEvents, processedEvents } from "../domain/schema.js";
import type { DeadLetterEvent } from "../domain/schema.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const listSchema = z.strictObject({
  status: z.enum(["PENDING", "RESOLVED", "DISCARDED"]).optional(),
  consumerGroup: z.string().trim().min(1).max(64).optional(),
  eventType: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  cursor: z.uuid().optional(),
});

const discardSchema = z.strictObject({
  /**
   * Why this event will never be processed. Required — a discarded event is a
   * decision to accept a permanent gap in a consumer's view of the world, and a
   * gap with no recorded reason is indistinguishable from a bug.
   */
  reason: z.string().trim().min(1, "reason is required").max(1000),
});

export interface DeadLetterPage {
  readonly items: readonly DeadLetterEvent[];
  readonly nextCursor: string | null;
}

export interface ReplayOutcome {
  readonly replayed: boolean;
  /** Set when the replay failed again — the handler's error, verbatim. */
  readonly error: string | null;
}

/**
 * The dead-letter admin path.
 *
 * ⚠️ Without this, a poison event was a PERMANENT hole. The consumer already
 * did the hard part — a message that exhausts its retries lands in
 * `dead_letter_events` rather than blocking the group — but nothing could then
 * act on it. Rows accumulated in PENDING and the notification, the ledger
 * posting or the custody update they represented simply never happened.
 *
 * Three operations, and the distinction between the last two matters:
 *
 *  - **replay** re-runs the handler. The fix has shipped; try again.
 *  - **resolve** marks it handled WITHOUT re-running, for when the effect was
 *    achieved another way (a manual ledger correction, a status set by hand).
 *  - **discard** accepts that it will never be processed, and demands a reason.
 *
 * Conflating resolve and discard would lose the only thing an auditor cares
 * about six months later: whether the work was done or written off.
 */
@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger(DeadLetterService.name);

  constructor(
    private readonly database: DatabaseService,
    /**
     * The handlers this process can replay through, dispatched by consumer
     * group — so the service works for any consumer without knowing what it
     * does.
     *
     * OPTIONAL: the API binds them, a bare worker may not, and listing or
     * discarding a dead letter must work either way. Unbound simply means replay
     * reports that no handler is registered here.
     */
    @Optional()
    @Inject(REPLAY_HANDLERS)
    private readonly handlers: readonly EventHandler[] = [],
  ) {}

  async list(input: unknown = {}): Promise<DeadLetterPage> {
    const params = parseWithZod(listSchema, input);
    const limit = params.limit ?? DEFAULT_PAGE_SIZE;

    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(params.status === undefined ? [] : [eq(deadLetterEvents.status, params.status)]),
        ...(params.consumerGroup === undefined
          ? []
          : [eq(deadLetterEvents.consumerGroup, params.consumerGroup)]),
        ...(params.eventType === undefined
          ? []
          : [eq(deadLetterEvents.eventType, params.eventType)]),
        ...(params.cursor === undefined ? [] : [lt(deadLetterEvents.id, params.cursor)]),
      ];

      const rows = await tx
        .select()
        .from(deadLetterEvents)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        // UUIDv7 — id descending is chronological, newest failure first.
        .orderBy(desc(deadLetterEvents.id))
        .limit(limit + 1);

      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  async getById(id: string): Promise<DeadLetterEvent> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(deadLetterEvents)
        .where(eq(deadLetterEvents.id, id))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError("Dead-letter event");
      }
      return row;
    });
  }

  /**
   * Re-runs the handler for a dead-lettered event.
   *
   * ⚠️ The `processed_events` ledger is checked FIRST and written on success, so
   * a replay is idempotent against the ordinary consumer path: if the event did
   * in fact get processed before it was dead-lettered — a failure AFTER the
   * handler's effects committed, say — this marks it resolved rather than
   * running the handler a second time and double-posting.
   *
   * The handler runs OUTSIDE the row's own update so a partial success is not
   * silently rolled back with the bookkeeping. A handler that fails again leaves
   * the row PENDING with a fresh error, which is the honest outcome.
   */
  async replay(id: string): Promise<ReplayOutcome> {
    const row = await this.getById(id);

    if (row.status !== "PENDING") {
      throw new BusinessRuleError(
        "DLQ_NOT_PENDING",
        `This event is already ${row.status} and cannot be replayed.`,
      );
    }

    const handler = this.handlers.find((h) => h.consumerGroup === row.consumerGroup);
    if (handler === undefined) {
      throw new BusinessRuleError(
        "DLQ_NO_HANDLER",
        `No handler is registered for consumer group "${row.consumerGroup}" in this process. Replay it from the worker.`,
      );
    }

    const alreadyProcessed = await this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ id: processedEvents.id })
        .from(processedEvents)
        .where(
          and(
            eq(processedEvents.consumerGroup, row.consumerGroup),
            eq(processedEvents.eventId, row.eventId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    });

    if (alreadyProcessed) {
      await this.markResolved(id, "already processed — no replay needed");
      return { replayed: true, error: null };
    }

    try {
      await handler.handle(toConsumedEvent(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Recorded, not swallowed: the operator needs to see that the retry failed
      // and why, and the row must stay PENDING so it can be tried again.
      await this.recordFailure(id, message);
      this.logger.warn(
        { deadLetterId: id, consumerGroup: row.consumerGroup, eventId: row.eventId },
        "dead-letter replay failed again",
      );
      return { replayed: false, error: message.slice(0, 1000) };
    }

    await this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      // Written so the ordinary consumer path will not process it again if the
      // same event is somehow redelivered.
      await tx
        .insert(processedEvents)
        .values({
          tenantId,
          consumerGroup: row.consumerGroup,
          eventId: row.eventId,
          eventType: row.eventType,
        })
        .onConflictDoNothing();

      await tx
        .update(deadLetterEvents)
        .set({ status: "RESOLVED", resolvedAt: sql`now()` })
        .where(and(eq(deadLetterEvents.id, id), isNull(deadLetterEvents.resolvedAt)));
    });

    return { replayed: true, error: null };
  }

  /**
   * Marks an event handled without re-running it.
   *
   * For when the effect was achieved another way — a ledger correction posted by
   * hand, a status an operator set directly. Distinct from `discard` because the
   * work WAS done; only the automation missed it.
   */
  async resolve(id: string, note: string): Promise<void> {
    const row = await this.getById(id);
    if (row.status !== "PENDING") {
      throw new BusinessRuleError("DLQ_NOT_PENDING", `This event is already ${row.status}.`);
    }
    await this.markResolved(id, note);
  }

  /**
   * Accepts that this event will never be processed.
   *
   * Requires a reason, because a discard is a decision to live with a permanent
   * gap in a consumer's view of the world. Six months later the only thing that
   * distinguishes that from an unnoticed bug is the sentence written here.
   */
  async discard(id: string, input: unknown): Promise<void> {
    const dto = parseWithZod(discardSchema, input);
    const row = await this.getById(id);

    if (row.status !== "PENDING") {
      throw new BusinessRuleError("DLQ_NOT_PENDING", `This event is already ${row.status}.`);
    }

    await this.database.withTenant(async (tx) => {
      await tx
        .update(deadLetterEvents)
        .set({
          status: "DISCARDED",
          resolvedAt: sql`now()`,
          // Appended, not replaced: the original failure is what an
          // investigation starts from, and overwriting it destroys the evidence
          // that justified the discard.
          error: `${row.error}\n\n[discarded] ${dto.reason}`,
        })
        .where(eq(deadLetterEvents.id, id));
    });
  }

  /** How many events are waiting, per consumer group. Feeds the ops dashboard. */
  async pendingCounts(): Promise<readonly { consumerGroup: string; count: number }[]> {
    return this.database.withTenant(async (tx) =>
      tx
        .select({
          consumerGroup: deadLetterEvents.consumerGroup,
          count: sql<number>`count(*)::int`,
        })
        .from(deadLetterEvents)
        .where(eq(deadLetterEvents.status, "PENDING"))
        .groupBy(deadLetterEvents.consumerGroup),
    );
  }

  private async markResolved(id: string, note: string): Promise<void> {
    await this.database.withTenant(async (tx) => {
      const row = await tx
        .select({ error: deadLetterEvents.error })
        .from(deadLetterEvents)
        .where(eq(deadLetterEvents.id, id))
        .limit(1);

      await tx
        .update(deadLetterEvents)
        .set({
          status: "RESOLVED",
          resolvedAt: sql`now()`,
          error: `${row[0]?.error ?? ""}\n\n[resolved] ${note}`,
        })
        .where(eq(deadLetterEvents.id, id));
    });
  }

  private async recordFailure(id: string, message: string): Promise<void> {
    await this.database.withTenant(async (tx) => {
      await tx
        .update(deadLetterEvents)
        .set({
          error: message.slice(0, 4000),
          lastFailedAt: sql`now()`,
          deliveryCount: sql`${deadLetterEvents.deliveryCount} + 1`,
        })
        .where(eq(deadLetterEvents.id, id));
    });
  }
}

/**
 * Reconstructs the event as the handler originally saw it.
 *
 * The DLQ row keeps the payload and identity but not the full envelope, so trace
 * context is null: this replay is a NEW operation minutes or days later, and
 * attaching it to the original trace would misrepresent when it happened.
 */
function toConsumedEvent(row: DeadLetterEvent): ConsumedEvent {
  const payload =
    typeof row.payload === "object" && row.payload !== null
      ? (row.payload as Record<string, unknown>)
      : {};

  return {
    streamId: row.streamId,
    seq: null,
    eventId: row.eventId,
    tenantId: row.tenantId,
    eventType: row.eventType,
    eventVersion: 1,
    // The DLQ row does not carry these; a handler that needs them reads the
    // payload, which event-storming §2.2 requires to be self-contained.
    aggregateType: "",
    aggregateId: row.eventId,
    occurredAt: row.firstFailedAt,
    correlationId: null,
    causationId: null,
    payload,
    deliveryCount: row.deliveryCount,
    traceparent: null,
    tracestate: null,
  };
}
