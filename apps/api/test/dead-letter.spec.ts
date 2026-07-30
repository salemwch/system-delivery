import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DeadLetterService } from "../src/modules/platform/application/dead-letter.service.js";
import type { ConsumedEvent, EventHandler } from "../src/modules/platform/domain/consumed-event.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError, NotFoundError, ValidationError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * The dead-letter admin path.
 *
 * ⚠️ Before this, a poison event was a PERMANENT hole. The consumer already put
 * exhausted messages in `dead_letter_events` rather than blocking the group —
 * but nothing could act on them, so rows accumulated in PENDING and the
 * notification, ledger posting or custody update they represented simply never
 * happened.
 *
 * The tests that matter here are the ones about NOT double-applying an effect:
 * a replay must be idempotent against the ordinary consumer path, or replaying
 * a `cod.collected` posts the money twice.
 */
describe("dead letters", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let createdTenants: string[] = [];

  /** A handler whose behaviour each test controls. */
  class ProbeHandler implements EventHandler {
    readonly consumerGroup = "probe";
    readonly seen: ConsumedEvent[] = [];
    shouldFail = false;

    handles(): boolean {
      return true;
    }

    handle(event: ConsumedEvent): Promise<void> {
      this.seen.push(event);
      if (this.shouldFail) {
        return Promise.reject(new Error("handler still broken"));
      }
      return Promise.resolve();
    }

    reset(): void {
      this.seen.length = 0;
      this.shouldFail = false;
    }
  }

  const probe = new ProbeHandler();
  let service: DeadLetterService;

  async function asAdmin<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "user" }, fn);
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  /** Writes a dead-lettered event exactly as the stream consumer would. */
  async function seedDeadLetter(
    tenantId: string,
    overrides: { consumerGroup?: string; eventType?: string; eventId?: string } = {},
  ): Promise<string> {
    const eventId = overrides.eventId ?? randomUUID();
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into dead_letter_events (
          tenant_id, consumer_group, event_id, event_type, stream_id,
          payload, error, delivery_count, status
        )
        values (
          ${tenantId}, ${overrides.consumerGroup ?? "probe"}, ${eventId},
          ${overrides.eventType ?? "shipment.delivered"}, '1712345678901-0',
          ${JSON.stringify({ trackingNumber: "TN-1", recipientPhone: "+21620000002" })}::jsonb,
          'exhausted 5 deliveries', 5, 'PENDING'
        )
        returning id
      `,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed dead letter");
    return row.id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    service = new DeadLetterService(db, [probe]);
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    probe.reset();
  });

  afterAll(async () => {
    await database.close();
  });

  // ── Seeing what is stuck ───────────────────────────────────────────────────

  describe("list", () => {
    it("lists pending failures, newest first", async () => {
      const tenantId = await seedTenant("dlq");
      await seedDeadLetter(tenantId);
      const second = await seedDeadLetter(tenantId);

      const page = await asAdmin(tenantId, () => service.list({}));

      expect(page.items).toHaveLength(2);
      // UUIDv7 descending — the most recent failure is what an operator looks at.
      expect(page.items[0]?.id).toBe(second);
    });

    it("filters by status, consumer group and event type", async () => {
      const tenantId = await seedTenant("dlq");
      await seedDeadLetter(tenantId, { consumerGroup: "probe" });
      await seedDeadLetter(tenantId, { consumerGroup: "ledger", eventType: "cod.collected" });

      const byGroup = await asAdmin(tenantId, () => service.list({ consumerGroup: "ledger" }));
      expect(byGroup.items).toHaveLength(1);

      const byType = await asAdmin(tenantId, () => service.list({ eventType: "cod.collected" }));
      expect(byType.items).toHaveLength(1);

      const resolved = await asAdmin(tenantId, () => service.list({ status: "RESOLVED" }));
      expect(resolved.items).toHaveLength(0);
    });

    it("counts what is pending per consumer group", async () => {
      const tenantId = await seedTenant("dlq");
      await seedDeadLetter(tenantId, { consumerGroup: "probe" });
      await seedDeadLetter(tenantId, { consumerGroup: "probe" });
      await seedDeadLetter(tenantId, { consumerGroup: "ledger" });

      const counts = await asAdmin(tenantId, () => service.pendingCounts());
      const byGroup = new Map(counts.map((c) => [c.consumerGroup, c.count]));

      // The number an ops dashboard puts on screen.
      expect(byGroup.get("probe")).toBe(2);
      expect(byGroup.get("ledger")).toBe(1);
    });

    it("paginates", async () => {
      const tenantId = await seedTenant("dlq");
      for (let i = 0; i < 3; i += 1) {
        await seedDeadLetter(tenantId);
      }

      const first = await asAdmin(tenantId, () => service.list({ limit: 2 }));
      expect(first.items).toHaveLength(2);
      const second = await asAdmin(tenantId, () =>
        service.list({ limit: 2, cursor: first.nextCursor ?? undefined }),
      );
      const ids = new Set([...first.items, ...second.items].map((r) => r.id));
      expect(ids.size).toBe(3);
    });

    it("never shows another tenant's failures", async () => {
      const tenantA = await seedTenant("dlq-a");
      const tenantB = await seedTenant("dlq-b");
      await seedDeadLetter(tenantA);

      const inB = await asAdmin(tenantB, () => service.list({}));
      expect(inB.items).toHaveLength(0);
    });

    it("throws for an unknown id", async () => {
      const tenantId = await seedTenant("dlq");
      await expect(asAdmin(tenantId, () => service.getById(randomUUID()))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  // ── Replay ─────────────────────────────────────────────────────────────────

  describe("replay", () => {
    it("re-runs the handler and resolves the row", async () => {
      const tenantId = await seedTenant("dlq");
      const id = await seedDeadLetter(tenantId);

      const outcome = await asAdmin(tenantId, () => service.replay(id));

      expect(outcome.replayed).toBe(true);
      expect(probe.seen).toHaveLength(1);
      // The payload the handler needs must survive the round trip — events are
      // self-contained (event-storming §2.2), so this is all it gets.
      expect(probe.seen[0]?.payload["trackingNumber"]).toBe("TN-1");

      const row = await asAdmin(tenantId, () => service.getById(id));
      expect(row.status).toBe("RESOLVED");
      expect(row.resolvedAt).not.toBeNull();
    });

    it("records the processed-events ledger so the consumer will not run it again", async () => {
      const tenantId = await seedTenant("dlq");
      const id = await seedDeadLetter(tenantId);
      const row = await asAdmin(tenantId, () => service.getById(id));

      await asAdmin(tenantId, () => service.replay(id));

      const processed = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ event_id: string }[]>`
          select event_id from processed_events where event_id = ${row.eventId}
        `,
      );
      expect(processed).toHaveLength(1);
    });

    it("does NOT re-run a handler for an event already processed", async () => {
      const tenantId = await seedTenant("dlq");
      const eventId = randomUUID();
      const id = await seedDeadLetter(tenantId, { eventId });

      // The event WAS processed — the failure came after the handler's effects
      // committed. Re-running would double-post.
      await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx`
          insert into processed_events (tenant_id, consumer_group, event_id, event_type)
          values (${tenantId}, 'probe', ${eventId}, 'shipment.delivered')
        `,
      );

      const outcome = await asAdmin(tenantId, () => service.replay(id));

      expect(outcome.replayed).toBe(true);
      // The whole point: the handler never ran.
      expect(probe.seen).toHaveLength(0);

      const row = await asAdmin(tenantId, () => service.getById(id));
      expect(row.status).toBe("RESOLVED");
      expect(row.error).toContain("already processed");
    });

    it("leaves the row PENDING with a fresh error when the handler fails again", async () => {
      const tenantId = await seedTenant("dlq");
      const id = await seedDeadLetter(tenantId);
      probe.shouldFail = true;

      const outcome = await asAdmin(tenantId, () => service.replay(id));

      expect(outcome.replayed).toBe(false);
      expect(outcome.error).toContain("handler still broken");

      const row = await asAdmin(tenantId, () => service.getById(id));
      // Still actionable. A row silently marked resolved after a failed retry
      // would be a hole nobody ever looks at again.
      expect(row.status).toBe("PENDING");
      expect(row.error).toContain("handler still broken");
      expect(row.deliveryCount).toBe(6);
    });

    it("can be replayed again after the fix ships", async () => {
      const tenantId = await seedTenant("dlq");
      const id = await seedDeadLetter(tenantId);

      probe.shouldFail = true;
      await asAdmin(tenantId, () => service.replay(id));

      probe.shouldFail = false;
      const outcome = await asAdmin(tenantId, () => service.replay(id));

      expect(outcome.replayed).toBe(true);
      expect((await asAdmin(tenantId, () => service.getById(id))).status).toBe("RESOLVED");
    });

    it("refuses to replay an already-resolved event", async () => {
      const tenantId = await seedTenant("dlq");
      const id = await seedDeadLetter(tenantId);
      await asAdmin(tenantId, () => service.replay(id));

      await expect(asAdmin(tenantId, () => service.replay(id))).rejects.toBeInstanceOf(
        BusinessRuleError,
      );
      // And the handler did not run a second time.
      expect(probe.seen).toHaveLength(1);
    });

    it("reports honestly when no handler is registered in this process", async () => {
      const tenantId = await seedTenant("dlq");
      const id = await seedDeadLetter(tenantId, { consumerGroup: "not-registered-here" });

      await expect(asAdmin(tenantId, () => service.replay(id))).rejects.toBeInstanceOf(
        BusinessRuleError,
      );
    });

    it("works with no handlers bound at all", async () => {
      const tenantId = await seedTenant("dlq");
      const id = await seedDeadLetter(tenantId);
      // A bare worker may bind none. Listing and discarding must still work.
      const bare = new DeadLetterService(db);

      const page = await asAdmin(tenantId, () => bare.list({}));
      expect(page.items).toHaveLength(1);

      await expect(asAdmin(tenantId, () => bare.replay(id))).rejects.toBeInstanceOf(
        BusinessRuleError,
      );
    });
  });

  // ── Resolve vs discard ─────────────────────────────────────────────────────

  describe("resolve and discard", () => {
    it("resolves WITHOUT running the handler", async () => {
      const tenantId = await seedTenant("dlq");
      const id = await seedDeadLetter(tenantId);

      await asAdmin(tenantId, () =>
        service.resolve(id, "ledger corrected by hand, ref ADJ-2026-07-31"),
      );

      // The effect was achieved another way; re-running would duplicate it.
      expect(probe.seen).toHaveLength(0);
      const row = await asAdmin(tenantId, () => service.getById(id));
      expect(row.status).toBe("RESOLVED");
      expect(row.error).toContain("ADJ-2026-07-31");
    });

    it("discards with a mandatory reason", async () => {
      const tenantId = await seedTenant("dlq");
      const id = await seedDeadLetter(tenantId);

      await asAdmin(tenantId, () =>
        service.discard(id, { reason: "test data from a load run; no real parcel" }),
      );

      const row = await asAdmin(tenantId, () => service.getById(id));
      expect(row.status).toBe("DISCARDED");
      expect(row.error).toContain("test data from a load run");
    });

    it("PRESERVES the original error when discarding", async () => {
      const tenantId = await seedTenant("dlq");
      const id = await seedDeadLetter(tenantId);

      await asAdmin(tenantId, () => service.discard(id, { reason: "not worth chasing" }));

      const row = await asAdmin(tenantId, () => service.getById(id));
      // Appended, not replaced. The original failure is what an investigation
      // starts from, and overwriting it destroys the evidence that justified the
      // discard in the first place.
      expect(row.error).toContain("exhausted 5 deliveries");
      expect(row.error).toContain("not worth chasing");
    });

    it("refuses a discard with no reason", async () => {
      const tenantId = await seedTenant("dlq");
      const id = await seedDeadLetter(tenantId);

      await expect(
        asAdmin(tenantId, () => service.discard(id, { reason: "   " })),
        // A permanent gap with no recorded reason is indistinguishable from a bug
        // six months later.
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses to discard something already resolved", async () => {
      const tenantId = await seedTenant("dlq");
      const id = await seedDeadLetter(tenantId);
      await asAdmin(tenantId, () => service.resolve(id, "handled"));

      await expect(
        asAdmin(tenantId, () => service.discard(id, { reason: "changed my mind" })),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("keeps resolved and discarded distinguishable", async () => {
      const tenantId = await seedTenant("dlq");
      const resolvedId = await seedDeadLetter(tenantId);
      const discardedId = await seedDeadLetter(tenantId);

      await asAdmin(tenantId, () => service.resolve(resolvedId, "posted manually"));
      await asAdmin(tenantId, () => service.discard(discardedId, { reason: "duplicate" }));

      const resolved = await asAdmin(tenantId, () => service.list({ status: "RESOLVED" }));
      const discarded = await asAdmin(tenantId, () => service.list({ status: "DISCARDED" }));

      // Whether the work was DONE or WRITTEN OFF is the only thing an auditor
      // cares about later; conflating them loses it.
      expect(resolved.items.map((r) => r.id)).toEqual([resolvedId]);
      expect(discarded.items.map((r) => r.id)).toEqual([discardedId]);
    });
  });
});
