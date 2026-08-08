import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AddressService, MerchantService, RecipientService } from "../src/modules/directory/index.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import {
  AuditService,
  OperatingConfigService,
  OutboxService,
} from "../src/modules/platform/index.js";
import { ShipmentAmendmentService } from "../src/modules/shipment/application/shipment-amendment.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import type { CommandContext } from "../src/modules/shipment/application/shipment.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Modification Colis — changing a parcel already in the system.
 *
 * Until this existed there was no way at all: `shipment:update` was a permission
 * with nothing behind it, and the only remedy was cancel-and-recreate, which
 * throws away the tracking number the customer already holds.
 *
 * The cases that matter are the guards, not the happy path: a terminal parcel
 * refusing to change, cash that has already been collected refusing to be
 * re-priced, and only ever ONE open request per parcel — because two approved in
 * sequence overwrite each other's `previous` snapshot and lose a value nobody
 * can recover.
 */
describe("shipment amendments", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let shipments: ShipmentService;
  let amendments: ShipmentAmendmentService;
  let createdTenants: string[] = [];

  const ACTOR_ID = randomUUID();

  function asStaff<T>(tenantId: string, fn: () => Promise<T>, actorId = ACTOR_ID): Promise<T> {
    return TenantContext.run(
      { tenantId: asTenantId(tenantId), actorType: "user", actorId },
      fn,
    );
  }

  const dispatcher: CommandContext = { actor: { actorType: "DISPATCHER", actorId: ACTOR_ID } };
  const driver = (): CommandContext => ({
    actor: { actorType: "DRIVER", actorId: randomUUID() },
  });

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  async function seedUser(tenantId: string): Promise<string> {
    const email = `staff-${Math.random().toString(36).slice(2, 8)}@test.tn`;
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, full_name, status)
        values (${tenantId}, ${email}, 'hash', 'Agent', 'ACTIVE')
        returning id`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed user");
    return row.id;
  }

  function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      idempotencyKey: randomUUID(),
      senderName: "Boutique Farah",
      senderPhone: "+21620123456",
      origin: {
        rawInput: "Rue de Marseille, Tunis",
        city: "Tunis",
        countryCode: "TN",
        coordinates: { lat: 36.8008, lng: 10.1817 },
      },
      recipientName: "Sonia Gharbi",
      recipientPhone: "+21620987654",
      destination: {
        rawInput: "Rue de la Liberté, Ariana",
        city: "Ariana",
        countryCode: "TN",
        coordinates: { lat: 36.8625, lng: 10.1956 },
      },
      currency: "TND",
      ...overrides,
    };
  }

  async function seedShipment(
    tenantId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const shipment = await asStaff(tenantId, () =>
      shipments.create(createInput(overrides), dispatcher),
    );
    return shipment.id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const audit = new AuditService(db);
    const addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    const recipients = new RecipientService(db);
    const merchants = new MerchantService(db, outbox, audit, addresses);
    shipments = new ShipmentService(
      db,
      new ShipmentEventService(outbox),
      outbox,
      merchants,
      recipients,
      addresses,
      new OperatingConfigService(db),
    );
    amendments = new ShipmentAmendmentService(db, audit, addresses, recipients);
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    await database.close();
  });

  // ── Requesting ─────────────────────────────────────────────────────────────
  describe("request", () => {
    let tenantId: string;
    let userId: string;
    let shipmentId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("amd-request");
      userId = await seedUser(tenantId);
      shipmentId = await seedShipment(tenantId);
    });

    it("records what was asked for, and leaves the parcel alone", async () => {
      const amendment = await asStaff(tenantId, () =>
        amendments.request(
          shipmentId,
          { recipientPhone: "+21624201314", reason: "numéro erroné" },
          userId,
          false,
        ),
      );

      expect(amendment.status).toBe("PENDING");
      expect(amendment.recipientPhone).toBe("+21624201314");
      expect(amendment.reason).toBe("numéro erroné");
      // Nothing decided yet — the CHECK constraint enforces the empty decision.
      expect(amendment.previous).toBeNull();
      expect(amendment.decidedAt).toBeNull();

      const shipment = await asStaff(tenantId, () => shipments.getById(shipmentId));
      expect(shipment.recipientPhone).toBe("+21620987654");
    });

    it("applies immediately when the requester could approve it anyway", async () => {
      // A dispatcher editing a parcel should not have to approve their own edit.
      // The row still names them twice, which is what happened.
      const amendment = await asStaff(tenantId, () =>
        amendments.request(shipmentId, { recipientName: "Sonia Ben Salah" }, userId, true),
      );

      expect(amendment.status).toBe("APPLIED");
      expect(amendment.decidedByUserId).toBe(userId);
      expect(amendment.requestedByUserId).toBe(userId);

      const shipment = await asStaff(tenantId, () => shipments.getById(shipmentId));
      expect(shipment.recipientName).toBe("Sonia Ben Salah");
    });

    it("refuses a request that asks for nothing", async () => {
      await expect(
        asStaff(tenantId, () => amendments.request(shipmentId, { reason: "juste comme ça" }, userId, false)),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses a city with no street — it is not an address anyone can act on", async () => {
      await expect(
        asStaff(tenantId, () =>
          amendments.request(shipmentId, { destinationCity: "Sfax" }, userId, false),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("⚠️ allows only ONE open request per parcel", async () => {
      await asStaff(tenantId, () =>
        amendments.request(shipmentId, { recipientName: "Premier" }, userId, false),
      );

      // Two pending requests can both be approved, and the second overwrites the
      // first's `previous` snapshot — losing the original value permanently.
      await expect(
        asStaff(tenantId, () =>
          amendments.request(shipmentId, { recipientName: "Deuxième" }, userId, false),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("allows a new request once the previous one is decided", async () => {
      const first = await asStaff(tenantId, () =>
        amendments.request(shipmentId, { recipientName: "Premier" }, userId, false),
      );
      await asStaff(tenantId, () => amendments.reject(first.id, { reason: "non" }, userId));

      const second = await asStaff(tenantId, () =>
        amendments.request(shipmentId, { recipientName: "Deuxième" }, userId, false),
      );
      expect(second.status).toBe("PENDING");
    });

    it("404s on an unknown parcel", async () => {
      await expect(
        asStaff(tenantId, () =>
          amendments.request(randomUUID(), { recipientName: "X" }, userId, false),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── Applying ───────────────────────────────────────────────────────────────
  describe("apply", () => {
    let tenantId: string;
    let userId: string;
    let shipmentId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("amd-apply");
      userId = await seedUser(tenantId);
      shipmentId = await seedShipment(tenantId, { codAmountMinor: 45_000 });
    });

    it("changes the phone AND re-points the parcel at the right person", async () => {
      const before = await asStaff(tenantId, () => shipments.getById(shipmentId));

      const amendment = await asStaff(tenantId, () =>
        amendments.request(shipmentId, { recipientPhone: "+21624201314" }, userId, false),
      );
      await asStaff(tenantId, () => amendments.apply(amendment.id, userId));

      const after = await asStaff(tenantId, () => shipments.getById(shipmentId));
      expect(after.recipientPhone).toBe("+21624201314");
      // The address book is keyed on the phone, so correcting it means the
      // parcel now belongs to a different person there. Leaving recipient_id
      // pointing at the old number would put the delivery in the wrong history.
      expect(after.recipientId).not.toBe(before.recipientId);
    });

    it("re-geocodes a new destination", async () => {
      const before = await asStaff(tenantId, () => shipments.getById(shipmentId));

      const amendment = await asStaff(tenantId, () =>
        amendments.request(
          shipmentId,
          { destinationRawInput: "Avenue Habib Bourguiba, Sfax", destinationCity: "Sfax" },
          userId,
          false,
        ),
      );
      await asStaff(tenantId, () => amendments.apply(amendment.id, userId));

      const after = await asStaff(tenantId, () => shipments.getById(shipmentId));
      expect(after.destinationAddressId).not.toBe(before.destinationAddressId);
    });

    it("moves the COD amount and its STATUS together", async () => {
      const amendment = await asStaff(tenantId, () =>
        amendments.request(shipmentId, { codAmountMinor: 0 }, userId, false),
      );
      await asStaff(tenantId, () => amendments.apply(amendment.id, userId));

      const after = await asStaff(tenantId, () => shipments.getById(shipmentId));
      expect(after.codAmountMinor).toBe(0n);
      // ⚠️ A parcel amended to zero COD that stays PENDING inflates cash-in-field
      // for as long as it exists.
      expect(after.codStatus).toBe("NOT_APPLICABLE");
    });

    it("turns COD on for a parcel that had none", async () => {
      const free = await seedShipment(tenantId);
      const amendment = await asStaff(tenantId, () =>
        amendments.request(free, { codAmountMinor: 30_000 }, userId, false),
      );
      await asStaff(tenantId, () => amendments.apply(amendment.id, userId));

      const after = await asStaff(tenantId, () => shipments.getById(free));
      expect(after.codAmountMinor).toBe(30_000n);
      // The mirror of the case above: NOT_APPLICABLE here means the driver is
      // never asked for the money.
      expect(after.codStatus).toBe("PENDING");
    });

    it("snapshots ONLY the fields it touched", async () => {
      const amendment = await asStaff(tenantId, () =>
        amendments.request(shipmentId, { recipientName: "Nouveau nom" }, userId, false),
      );
      const applied = await asStaff(tenantId, () => amendments.apply(amendment.id, userId));

      // The whole row would drag unrelated PII into a JSONB column retained as
      // long as the shipment, and make the diff unreadable.
      expect(applied.previous).toEqual({ recipientName: "Sonia Gharbi" });
    });

    it("writes BOTH audit entries when the money moved", async () => {
      const amendment = await asStaff(tenantId, () =>
        amendments.request(shipmentId, { codAmountMinor: 12_500 }, userId, false),
      );
      await asStaff(tenantId, () => amendments.apply(amendment.id, userId));

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ action: string }[]>`
          select action from audit_log where resource_id = ${shipmentId} order by action`,
      );
      // `cod.amount_changed` is what a cash reconciliation searches for; burying
      // it inside a generic edit record would make it unfindable.
      expect(rows.map((r) => r.action)).toEqual(["cod.amount_changed", "shipment.amended"]);
    });

    it("writes only the generic entry when no money moved", async () => {
      const amendment = await asStaff(tenantId, () =>
        amendments.request(shipmentId, { recipientName: "Autre" }, userId, false),
      );
      await asStaff(tenantId, () => amendments.apply(amendment.id, userId));

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ action: string }[]>`
          select action from audit_log where resource_id = ${shipmentId}`,
      );
      expect(rows.map((r) => r.action)).toEqual(["shipment.amended"]);
    });

    it("refuses to apply twice", async () => {
      const amendment = await asStaff(tenantId, () =>
        amendments.request(shipmentId, { recipientName: "Une fois" }, userId, false),
      );
      await asStaff(tenantId, () => amendments.apply(amendment.id, userId));

      await expect(
        asStaff(tenantId, () => amendments.apply(amendment.id, userId)),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });
  });

  // ── Guards ─────────────────────────────────────────────────────────────────
  describe("guards", () => {
    let tenantId: string;
    let userId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("amd-guard");
      userId = await seedUser(tenantId);
    });

    it("refuses to change a CANCELLED parcel", async () => {
      const shipmentId = await seedShipment(tenantId);
      await asStaff(tenantId, () =>
        shipments.cancel(shipmentId, { idempotencyKey: randomUUID(), reason: "client" }, dispatcher),
      );

      await expect(
        asStaff(tenantId, () =>
          amendments.request(shipmentId, { recipientName: "Trop tard" }, userId, false),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("refuses to change a DELIVERED parcel", async () => {
      const shipmentId = await seedShipment(tenantId);
      const driverId = randomUUID();
      await asStaff(tenantId, async () => {
        await shipments.recordEvent(
          shipmentId,
          { eventType: "assigned", idempotencyKey: randomUUID() },
          dispatcher,
        );
        await shipments.recordPickup(
          shipmentId,
          { idempotencyKey: randomUUID(), driverId },
          driver(),
        );
        await shipments.recordEvent(
          shipmentId,
          { eventType: "out_for_delivery", idempotencyKey: randomUUID() },
          dispatcher,
        );
        await shipments.confirmDelivery(
          shipmentId,
          {
            idempotencyKey: randomUUID(),
            driverId,
            pod: {
              podType: "signature",
              signatureObjectKey: "pods/sig.png",
              recipientName: "Sonia Gharbi",
            },
          },
          driver(),
        );
      });

      await expect(
        asStaff(tenantId, () =>
          amendments.request(shipmentId, { recipientName: "Trop tard" }, userId, false),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("⚠️ refuses to re-price cash that has already been COLLECTED", async () => {
      const shipmentId = await seedShipment(tenantId, { codAmountMinor: 45_000 });
      // Force the state the guard exists for; getting here through the real
      // lifecycle needs a driver, a route and a delivery.
      await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx`update shipments set cod_status = 'COLLECTED' where id = ${shipmentId}`,
      );

      // Changing the amount now would rewrite what a driver handed over and what
      // the ledger already recorded. The correction for that is a ledger
      // adjustment, not an edit to the parcel.
      await expect(
        asStaff(tenantId, () =>
          amendments.request(shipmentId, { codAmountMinor: 1_000 }, userId, false),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("still allows a NON-money change on a parcel whose cash is collected", async () => {
      const shipmentId = await seedShipment(tenantId, { codAmountMinor: 45_000 });
      await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx`update shipments set cod_status = 'COLLECTED' where id = ${shipmentId}`,
      );

      // The guard is about the amount, not about the parcel. Correcting a
      // misspelt name must not be blocked by it.
      const amendment = await asStaff(tenantId, () =>
        amendments.request(shipmentId, { recipientName: "Orthographe" }, userId, false),
      );
      expect(amendment.status).toBe("PENDING");
    });
  });

  // ── Rejection ──────────────────────────────────────────────────────────────
  describe("reject", () => {
    it("records the reason and leaves the parcel untouched", async () => {
      const tenantId = await seedTenant("amd-reject");
      const userId = await seedUser(tenantId);
      const shipmentId = await seedShipment(tenantId);

      const amendment = await asStaff(tenantId, () =>
        amendments.request(shipmentId, { codAmountMinor: 1 }, userId, false),
      );
      const decided = await asStaff(tenantId, () =>
        amendments.reject(amendment.id, { reason: "Colis déjà en route" }, userId),
      );

      expect(decided.status).toBe("REJECTED");
      expect(decided.decisionReason).toBe("Colis déjà en route");
      expect(decided.previous).toBeNull();

      const shipment = await asStaff(tenantId, () => shipments.getById(shipmentId));
      expect(shipment.codAmountMinor).toBe(0n);
    });

    it("requires a reason", async () => {
      const tenantId = await seedTenant("amd-reject2");
      const userId = await seedUser(tenantId);
      const shipmentId = await seedShipment(tenantId);
      const amendment = await asStaff(tenantId, () =>
        amendments.request(shipmentId, { recipientName: "X" }, userId, false),
      );

      await expect(
        asStaff(tenantId, () => amendments.reject(amendment.id, { reason: "  " }, userId)),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // ── Reading ────────────────────────────────────────────────────────────────
  describe("list", () => {
    it("counts what is waiting and stops once decided", async () => {
      const tenantId = await seedTenant("amd-list");
      const userId = await seedUser(tenantId);
      const first = await seedShipment(tenantId);
      const second = await seedShipment(tenantId);

      await asStaff(tenantId, () => amendments.request(first, { recipientName: "A" }, userId, false));
      const b = await asStaff(tenantId, () =>
        amendments.request(second, { recipientName: "B" }, userId, false),
      );

      expect(await asStaff(tenantId, () => amendments.pendingCount())).toBe(2);
      await asStaff(tenantId, () => amendments.reject(b.id, { reason: "non" }, userId));
      expect(await asStaff(tenantId, () => amendments.pendingCount())).toBe(1);
    });

    it("narrows to one parcel's history", async () => {
      const tenantId = await seedTenant("amd-history");
      const userId = await seedUser(tenantId);
      const mine = await seedShipment(tenantId);
      const other = await seedShipment(tenantId);

      const a = await asStaff(tenantId, () =>
        amendments.request(mine, { recipientName: "A" }, userId, false),
      );
      await asStaff(tenantId, () => amendments.reject(a.id, { reason: "non" }, userId));
      await asStaff(tenantId, () => amendments.request(mine, { recipientName: "B" }, userId, false));
      await asStaff(tenantId, () => amendments.request(other, { recipientName: "C" }, userId, false));

      const history = await asStaff(tenantId, () => amendments.list({ shipmentId: mine }));
      // Newest first on a parcel's own panel.
      expect(history.items.map((x) => x.recipientName)).toEqual(["B", "A"]);
    });
  });

  // ── Isolation ──────────────────────────────────────────────────────────────
  describe("tenant isolation", () => {
    it("never shows or decides another tenant's amendment", async () => {
      const alpha = await seedTenant("amd-iso-a");
      const beta = await seedTenant("amd-iso-b");
      const userId = await seedUser(alpha);
      const shipmentId = await seedShipment(alpha);

      const amendment = await asStaff(alpha, () =>
        amendments.request(shipmentId, { recipientName: "Privé" }, userId, false),
      );

      expect((await asStaff(beta, () => amendments.list())).items).toHaveLength(0);
      expect(await asStaff(beta, () => amendments.pendingCount())).toBe(0);
      await expect(asStaff(beta, () => amendments.getById(amendment.id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});
