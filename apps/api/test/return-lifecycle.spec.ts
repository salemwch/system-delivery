import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import type { CommandContext } from "../src/modules/shipment/application/shipment.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError, ForbiddenError, ValidationError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  seedDriverLogin,
  withTenantContext,
} from "./database.harness.js";
import type { DriverLogin, TestDatabase } from "./database.harness.js";

/**
 * Return-to-origin (docs/01-mvp-scope.md §4.2 #2.8, domain §3.6 rule 9, §3.7 rule 6).
 *
 * ⚠️ `RETURN_PENDING` was reachable and `RETURNED` was in the state machine, but
 * NOTHING COULD MAKE THE TRANSITION — there was no command. A returning parcel
 * could never be closed out, so the merchant's view stayed "coming back" forever
 * and its COD stayed PENDING, inflating cash-in-field by the value of every
 * returned parcel.
 *
 * High return rates are normal in COD markets, which is what makes that a real
 * number rather than an edge case.
 */
describe("return lifecycle", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let shipments: ShipmentService;
  let merchants: MerchantService;
  let createdTenants: string[] = [];

  const ctx = { actor: { actorType: "DISPATCHER" as const, actorId: randomUUID() } };

  /** The driver carrying each shipment this spec sends out (invariant I26). */
  const couriers = new Map<string, DriverLogin>();

  /** The command context of the driver carrying `shipmentId`. */
  function courierOf(shipmentId: string): CommandContext {
    const courier = couriers.get(shipmentId);
    if (courier === undefined) {
      throw new Error(`no courier was seeded for shipment ${shipmentId}`);
    }
    return { actor: { actorType: "DRIVER", actorId: courier.userId } };
  }

  async function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  /** A shipment already OUT_FOR_DELIVERY. */
  async function outForDelivery(tenantId: string, codAmountMinor = 45_000): Promise<string> {
    const merchantId = await asStaff(
      tenantId,
      async () => (await merchants.create({ name: "Boutique" })).id,
    );
    const created = await asStaff(tenantId, () =>
      shipments.create(
        {
          idempotencyKey: randomUUID(),
          merchantId,
          senderName: "Boutique",
          senderPhone: "+21620000001",
          origin: { rawInput: "Tunis", countryCode: "TN", coordinates: { lat: 36.8, lng: 10.18 } },
          recipientName: "Ahmed Ben Ali",
          recipientPhone: "+21620000002",
          destination: {
            rawInput: "Sfax",
            countryCode: "TN",
            coordinates: { lat: 34.74, lng: 10.76 },
          },
          currency: "TND",
          codAmountMinor,
        },
        ctx,
      ),
    );

    // CREATED → ASSIGNED → PICKED_UP → OUT_FOR_DELIVERY. The state machine has no
    // shortcut from CREATED; a parcel must be assigned before anyone can take
    // custody of it.
    const courier = await seedDriverLogin(database.migrator, tenantId);
    await asStaff(tenantId, () =>
      shipments.recordEvent(
        created.id,
        { idempotencyKey: randomUUID(), eventType: "assigned" },
        ctx,
      ),
    );
    await asStaff(tenantId, () =>
      shipments.recordPickup(
        created.id,
        { idempotencyKey: randomUUID(), driverId: courier.driverId },
        ctx,
      ),
    );
    await asStaff(tenantId, () =>
      shipments.recordEvent(
        created.id,
        { idempotencyKey: randomUUID(), eventType: "out_for_delivery", driverId: courier.driverId },
        ctx,
      ),
    );
    couriers.set(created.id, courier);
    return created.id;
  }

  /**
   * A shipment at ATTEMPT_FAILED — where a dispatcher-decided return begins.
   *
   * The reason is deliberately one that ALLOWS a re-attempt and the attempt count
   * is 1 of 3, so the reason policy has NOT auto-returned the parcel: the return
   * here is a human decision, and `next_attempt_at` is genuinely set beforehand,
   * which is what makes the "clears it" assertion mean anything.
   */
  async function attemptFailed(tenantId: string, codAmountMinor = 45_000): Promise<string> {
    const shipmentId = await outForDelivery(tenantId, codAmountMinor);
    await asStaff(tenantId, () =>
      shipments.recordFailedAttempt(
        shipmentId,
        {
          idempotencyKey: randomUUID(),
          reasonCode: "CUSTOMER_UNAVAILABLE",
        },
        courierOf(shipmentId),
      ),
    );
    return shipmentId;
  }

  async function legsOf(
    tenantId: string,
    shipmentId: string,
  ): Promise<{ leg_type: string; status: string; leg_number: number }[]> {
    return withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ leg_type: string; status: string; leg_number: number }[]>`
        select leg_type, status, leg_number from shipment_legs
        where shipment_id = ${shipmentId} order by leg_number
      `,
    );
  }

  async function eventTypesOf(tenantId: string, shipmentId: string): Promise<string[]> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ event_type: string }[]>`
        select event_type from outbox where aggregate_id = ${shipmentId} order by seq
      `,
    );
    return rows.map((r) => r.event_type);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const addresses = new AddressService(
      db,
      outbox,
      new ManualGeocodingProvider(),
      new AuditService(db),
    );
    merchants = new MerchantService(
      db,
      outbox,
      new AuditService(db),
      new AddressService(db, outbox, new ManualGeocodingProvider(), new AuditService(db)),
    );
    const recipients = new RecipientService(db);
    const events = new ShipmentEventService(outbox);
    const operatingConfig = new OperatingConfigService(db);
    shipments = new ShipmentService(
      db,
      events,
      outbox,
      merchants,
      recipients,
      addresses,
      operatingConfig,
      new AuditService(db),
    );
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    couriers.clear();
  });

  afterAll(async () => {
    await database.close();
  });

  // ── Initiating ─────────────────────────────────────────────────────────────

  describe("initiate", () => {
    it("moves the parcel to RETURN_PENDING and plans a RETURN leg", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await attemptFailed(tenantId);

      const returning = await asStaff(tenantId, () =>
        shipments.initiateReturn(
          shipmentId,
          { idempotencyKey: randomUUID(), reason: "recipient unreachable after 3 attempts" },
          ctx,
        ),
      );

      expect(returning.status).toBe("RETURN_PENDING");

      // §3.7 rule 6 — "never leaves the shipment legless". Without a leg the
      // parcel cannot be put on a route, so it sits in a hub until noticed.
      const legs = await legsOf(tenantId, shipmentId);
      const returnLeg = legs.find((l) => l.leg_type === "RETURN");
      expect(returnLeg).toBeDefined();
      expect(returnLeg?.status).toBe("PLANNED");
    });

    it("numbers the RETURN leg after the failed one rather than reusing it", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await attemptFailed(tenantId);

      await asStaff(tenantId, () =>
        shipments.initiateReturn(
          shipmentId,
          { idempotencyKey: randomUUID(), reason: "unreachable" },
          ctx,
        ),
      );

      const legs = await legsOf(tenantId, shipmentId);
      // DM4's recommendation: a new leg preserves plan-vs-actual per attempt.
      // Reusing the failed leg would overwrite the timings the failure report is
      // built from.
      expect(legs).toHaveLength(2);
      expect(legs[0]?.leg_type).toBe("LAST_MILE");
      expect(legs[1]?.leg_type).toBe("RETURN");
      expect(legs[1]?.leg_number).toBe(2);
    });

    it("does not stack a second RETURN leg when re-initiated", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await attemptFailed(tenantId);

      await asStaff(tenantId, () =>
        shipments.initiateReturn(
          shipmentId,
          { idempotencyKey: randomUUID(), reason: "first" },
          ctx,
        ),
      );
      // A different key, so this is not an idempotent replay — it is a genuine
      // second call, and it must still not duplicate the leg.
      await asStaff(tenantId, () =>
        shipments.initiateReturn(
          shipmentId,
          { idempotencyKey: randomUUID(), reason: "second" },
          ctx,
        ),
      ).catch(() => undefined);

      const legs = await legsOf(tenantId, shipmentId);
      expect(legs.filter((l) => l.leg_type === "RETURN")).toHaveLength(1);
    });

    it("clears next_attempt_at — no further delivery is due", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await attemptFailed(tenantId);

      await asStaff(tenantId, () =>
        shipments.initiateReturn(
          shipmentId,
          { idempotencyKey: randomUUID(), reason: "unreachable" },
          ctx,
        ),
      );

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ next_attempt_at: Date | null }[]>`
          select next_attempt_at from shipments where id = ${shipmentId}
        `,
      );
      // A returning parcel left with a scheduled attempt would show up on a
      // dispatcher's "due today" list forever.
      expect(rows[0]?.next_attempt_at).toBeNull();
    });

    it("publishes a self-contained event the notification consumer can use", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await attemptFailed(tenantId);

      await asStaff(tenantId, () =>
        shipments.initiateReturn(
          shipmentId,
          { idempotencyKey: randomUUID(), reason: "unreachable" },
          ctx,
        ),
      );

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ event_type: string; payload: Record<string, unknown> }[]>`
          select event_type, payload from outbox where aggregate_id = ${shipmentId}
        `,
      );
      const event = rows.find((r) => r.event_type === "shipment.return_initiated");
      // The consumer imports no domain module, so everything it needs is here
      // (event-storming §2.2).
      expect(event?.payload["recipientPhone"]).toBe("+21620000002");
      expect(event?.payload["trackingNumber"]).toBeDefined();
    });

    // ── The automatic path ───────────────────────────────────────────────────
    //
    // ⚠️ MOST returns are decided by the reason policy, not by a dispatcher, so
    // this is the common path and not the exotic one. It reached RETURN_PENDING
    // without planning a leg and without a notifiable payload — a parcel nobody
    // could route back, about which nobody was told.
    describe("decided automatically by the reason policy", () => {
      async function refused(tenantId: string): Promise<string> {
        const shipmentId = await outForDelivery(tenantId);
        await asStaff(tenantId, () =>
          shipments.recordFailedAttempt(
            shipmentId,
            {
              idempotencyKey: randomUUID(),
              // `allows_reattempt = false` — one refusal ends it (migration 0026).
              reasonCode: "CUSTOMER_REFUSED",
            },
            courierOf(shipmentId),
          ),
        );
        return shipmentId;
      }

      it("returns the parcel on a refusal without waiting for the attempt cap", async () => {
        const tenantId = await seedTenant("rto");
        const shipmentId = await refused(tenantId);

        const shipment = await asStaff(tenantId, () => shipments.getById(shipmentId));
        expect(shipment.status).toBe("RETURN_PENDING");
        expect(shipment.attemptCount).toBe(1);
      });

      it("plans the RETURN leg too — rule 6 does not care who decided", async () => {
        const tenantId = await seedTenant("rto");
        const shipmentId = await refused(tenantId);

        const legs = await legsOf(tenantId, shipmentId);
        expect(legs.find((l) => l.leg_type === "RETURN")?.status).toBe("PLANNED");
      });

      it("carries a notifiable payload, like the dispatcher-decided path", async () => {
        const tenantId = await seedTenant("rto");
        const shipmentId = await refused(tenantId);

        const rows = await withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx<{ event_type: string; payload: Record<string, unknown> }[]>`
            select event_type, payload from outbox where aggregate_id = ${shipmentId}
          `,
        );
        const event = rows.find((r) => r.event_type === "shipment.return_initiated");
        expect(event?.payload["reason"]).toBe("NOT_REATTEMPTABLE:CUSTOMER_REFUSED");
        expect(event?.payload["recipientPhone"]).toBe("+21620000002");
        expect(event?.payload["trackingNumber"]).toBeDefined();
      });

      it("can be closed out from there, the same as any other return", async () => {
        const tenantId = await seedTenant("rto");
        const shipmentId = await refused(tenantId);

        const returned = await asStaff(tenantId, () =>
          shipments.completeReturn(
            shipmentId,
            { idempotencyKey: randomUUID() },
            courierOf(shipmentId),
          ),
        );
        expect(returned.status).toBe("RETURNED");
        expect(returned.codStatus).toBe("CANCELLED");
      });
    });
  });

  // ── Completing — the transition that did not exist ─────────────────────────

  describe("complete", () => {
    async function returning(tenantId: string, codAmountMinor = 45_000): Promise<string> {
      const shipmentId = await attemptFailed(tenantId, codAmountMinor);
      await asStaff(tenantId, () =>
        shipments.initiateReturn(
          shipmentId,
          { idempotencyKey: randomUUID(), reason: "unreachable" },
          ctx,
        ),
      );
      return shipmentId;
    }

    it("closes the lifecycle at RETURNED", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId);

      const returned = await asStaff(tenantId, () =>
        shipments.completeReturn(
          shipmentId,
          { idempotencyKey: randomUUID(), receivedByName: "Ines (Boutique)" },
          courierOf(shipmentId),
        ),
      );

      expect(returned.status).toBe("RETURNED");
    });

    it("CLOSES the COD instead of leaving it PENDING", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId, 45_000);

      const before = await asStaff(tenantId, () => shipments.getById(shipmentId));
      expect(before.codStatus).toBe("PENDING");

      await asStaff(tenantId, () =>
        shipments.completeReturn(
          shipmentId,
          { idempotencyKey: randomUUID() },
          courierOf(shipmentId),
        ),
      );

      const after = await asStaff(tenantId, () => shipments.getById(shipmentId));
      // ⚠️ The cash was never collected and never will be for this shipment.
      // Left at PENDING it would sit in cash-in-field (§4.5 #5.5) forever —
      // over-reporting the money a courier expects to reconcile by the value of
      // every returned parcel.
      expect(after.codStatus).toBe("CANCELLED");
      // The amount SURVIVES. NOT_APPLICABLE would have required zeroing it (I6),
      // erasing what the parcel was worth — the number a merchant dispute is
      // argued over months later.
      expect(after.codAmountMinor).toBe(45_000n);
    });

    it("leaves a non-COD shipment's status alone", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId, 0);

      await asStaff(tenantId, () =>
        shipments.completeReturn(
          shipmentId,
          { idempotencyKey: randomUUID() },
          courierOf(shipmentId),
        ),
      );

      const after = await asStaff(tenantId, () => shipments.getById(shipmentId));
      expect(after.codStatus).toBe("NOT_APPLICABLE");
    });

    it("completes the RETURN leg", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId);

      await asStaff(tenantId, () =>
        shipments.completeReturn(
          shipmentId,
          { idempotencyKey: randomUUID() },
          courierOf(shipmentId),
        ),
      );

      const legs = await legsOf(tenantId, shipmentId);
      expect(legs.find((l) => l.leg_type === "RETURN")?.status).toBe("COMPLETED");
    });

    it("tells the merchant the parcel is back and no money was collected", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId);

      await asStaff(tenantId, () =>
        shipments.completeReturn(
          shipmentId,
          { idempotencyKey: randomUUID() },
          courierOf(shipmentId),
        ),
      );

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ event_type: string; payload: Record<string, unknown> }[]>`
          select event_type, payload from outbox where aggregate_id = ${shipmentId}
        `,
      );
      const event = rows.find((r) => r.event_type === "shipment.returned");
      expect(event).toBeDefined();
      // The merchant closes their own order on this, and stops expecting the COD.
      expect(event?.payload["codCollected"]).toBe(false);
      expect(event?.payload["merchantId"]).toBeDefined();
    });

    it("is idempotent on the key", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId);
      const key = randomUUID();

      await asStaff(tenantId, () =>
        shipments.completeReturn(shipmentId, { idempotencyKey: key }, courierOf(shipmentId)),
      );
      await asStaff(tenantId, () =>
        shipments.completeReturn(shipmentId, { idempotencyKey: key }, courierOf(shipmentId)),
      );

      const types = await eventTypesOf(tenantId, shipmentId);
      // The driver app is offline-first and re-submits on reconnect.
      expect(types.filter((t) => t === "shipment.returned")).toHaveLength(1);
    });

    it("refuses to complete a return that was never initiated", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await outForDelivery(tenantId);

      await expect(
        asStaff(tenantId, () =>
          shipments.completeReturn(
            shipmentId,
            { idempotencyKey: randomUUID() },
            courierOf(shipmentId),
          ),
        ),
        // OUT_FOR_DELIVERY → RETURNED is not in the state machine. A parcel
        // cannot be marked "back with the merchant" without a return first.
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("refuses any further lifecycle event once RETURNED", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId);

      await asStaff(tenantId, () =>
        shipments.completeReturn(
          shipmentId,
          { idempotencyKey: randomUUID() },
          courierOf(shipmentId),
        ),
      );

      // Domain rule 11: terminal states accept no further lifecycle events.
      await expect(
        asStaff(tenantId, () =>
          shipments.initiateReturn(
            shipmentId,
            { idempotencyKey: randomUUID(), reason: "again" },
            ctx,
          ),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("closes the COD on a cancellation too — same money, other command", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await attemptFailed(tenantId, 45_000);

      await asStaff(tenantId, () =>
        shipments.cancel(
          shipmentId,
          { idempotencyKey: randomUUID(), reason: "merchant withdrew the order" },
          { ...ctx, canOverride: true },
        ),
      );

      const after = await asStaff(tenantId, () => shipments.getById(shipmentId));
      expect(after.status).toBe("CANCELLED");
      // A cancelled parcel's cash is as uncollectable as a returned one's, and it
      // sat in cash-in-field for exactly the same reason.
      expect(after.codStatus).toBe("CANCELLED");
    });

    it("records the full custody chain", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId);
      await asStaff(tenantId, () =>
        shipments.completeReturn(
          shipmentId,
          { idempotencyKey: randomUUID() },
          courierOf(shipmentId),
        ),
      );

      const types = await eventTypesOf(tenantId, shipmentId);
      // The custody log is the legal record; the return is part of it.
      expect(types).toContain("shipment.return_initiated");
      expect(types).toContain("shipment.returned");
      expect(types.indexOf("shipment.return_initiated")).toBeLessThan(
        types.indexOf("shipment.returned"),
      );
    });

    // ── Who handed it back (invariant I26) ─────────────────────────────────

    async function returnedBy(tenantId: string, shipmentId: string): Promise<string | null> {
      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ driver_id: string | null }[]>`
          select driver_id from shipment_events
           where shipment_id = ${shipmentId} and event_type = 'returned'`,
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error("no returned event");
      }
      return row.driver_id;
    }

    it("books the return to the driver who handed it back, from the login", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId);

      await asStaff(tenantId, () =>
        shipments.completeReturn(
          shipmentId,
          { idempotencyKey: randomUUID() },
          courierOf(shipmentId),
        ),
      );

      expect(await returnedBy(tenantId, shipmentId)).toBe(couriers.get(shipmentId)?.driverId);
    });

    it("refuses a driver closing a return another driver is carrying", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId);
      const colleague = await seedDriverLogin(database.migrator, tenantId);

      await expect(
        asStaff(tenantId, () =>
          shipments.completeReturn(
            shipmentId,
            { idempotencyKey: randomUUID() },
            { actor: { actorType: "DRIVER", actorId: colleague.userId } },
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const after = await asStaff(tenantId, () => shipments.getById(shipmentId));
      expect(after.status).toBe("RETURN_PENDING");
      expect(after.codStatus).toBe("PENDING");
    });

    it("lets staff close a return at the counter, booked to no driver", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId);

      const returned = await asStaff(tenantId, () =>
        shipments.completeReturn(shipmentId, { idempotencyKey: randomUUID() }, ctx),
      );

      expect(returned.status).toBe("RETURNED");
      expect(await returnedBy(tenantId, shipmentId)).toBeNull();

      // Decision 2 (9318622 release review): a staff closure is audit-logged.
      const audit = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<
          { actor_id: string | null; changes: Record<string, { from: unknown; to: unknown }> }[]
        >`select actor_id, changes from audit_log
           where action = 'shipment.return_closed_by_staff' and resource_id = ${shipmentId}`,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actor_id).toBe(ctx.actor.actorId);
      expect(audit[0]?.changes["codStatus"]).toEqual({ from: "PENDING", to: "CANCELLED" });
    });

    it("writes no staff audit entry when the carrying driver closes the return", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId);

      await asStaff(tenantId, () =>
        shipments.completeReturn(
          shipmentId,
          { idempotencyKey: randomUUID() },
          courierOf(shipmentId),
        ),
      );

      const audit = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ n: number }[]>`
          select count(*)::int as n from audit_log
           where action = 'shipment.return_closed_by_staff' and resource_id = ${shipmentId}`,
      );
      expect(audit[0]?.n).toBe(0);
    });

    it("rolls a staff closure back whole when its audit entry cannot be written", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId);
      // Fault injection in the real database: refuse THIS shipment's audit row,
      // the last write of the closure's transaction.
      const refuse = `refuse_audit_${shipmentId.replaceAll("-", "")}`;
      await database.migrator.unsafe(`
        CREATE FUNCTION ${refuse}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.resource_id = '${shipmentId}'::uuid THEN
            RAISE EXCEPTION 'injected audit failure';
          END IF;
          RETURN NEW;
        END $$`);
      await database.migrator.unsafe(
        `CREATE TRIGGER ${refuse} BEFORE INSERT ON audit_log
           FOR EACH ROW EXECUTE FUNCTION ${refuse}()`,
      );
      const key = randomUUID();
      try {
        const failure = await asStaff(tenantId, () =>
          shipments.completeReturn(shipmentId, { idempotencyKey: key }, ctx),
        ).then(
          () => null,
          (error: unknown) => error,
        );
        // The injected failure itself, found down the driver's `.cause` chain.
        const messages: string[] = [];
        for (let e: unknown = failure; e instanceof Error; e = e.cause) {
          messages.push(e.message);
        }
        expect(messages).toContain("injected audit failure");
      } finally {
        await database.migrator.unsafe(`DROP TRIGGER ${refuse} ON audit_log`);
        await database.migrator.unsafe(`DROP FUNCTION ${refuse}()`);
      }

      // No closure without its record: status, COD, custody event and outbox
      // all rolled back with the audit row.
      const after = await asStaff(tenantId, () => shipments.getById(shipmentId));
      expect(after.status).toBe("RETURN_PENDING");
      expect(after.codStatus).toBe("PENDING");
      expect(await eventTypesOf(tenantId, shipmentId)).not.toContain("shipment.returned");
      // The idempotency key was not consumed either: the same request succeeds.
      const retried = await asStaff(tenantId, () =>
        shipments.completeReturn(shipmentId, { idempotencyKey: key }, ctx),
      );
      expect(retried.status).toBe("RETURNED");
      const audit = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ n: number }[]>`
          select count(*)::int as n from audit_log
           where action = 'shipment.return_closed_by_staff' and resource_id = ${shipmentId}`,
      );
      expect(audit[0]?.n).toBe(1);
    });

    it("refuses a driver login with no driver record behind it", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId);

      await expect(
        asStaff(tenantId, () =>
          shipments.completeReturn(
            shipmentId,
            { idempotencyKey: randomUUID() },
            { actor: { actorType: "DRIVER", actorId: randomUUID() } },
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("rejects a driverId in the body instead of trusting it", async () => {
      const tenantId = await seedTenant("rto");
      const shipmentId = await returning(tenantId);
      const colleague = await seedDriverLogin(database.migrator, tenantId);

      await expect(
        asStaff(tenantId, () =>
          shipments.completeReturn(
            shipmentId,
            { idempotencyKey: randomUUID(), driverId: colleague.driverId },
            ctx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
