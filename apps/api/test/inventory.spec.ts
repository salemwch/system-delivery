import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { InventoryService } from "../src/modules/inventory/application/inventory.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError, ConflictError, ValidationError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Gestion de stock — the consumables a hub runs on.
 *
 * ⚠️ The level is `SUM(movements)` read from a view, so most of these tests
 * assert an arithmetic consequence rather than a stored value. That is the
 * design: there is no counter to drift, and therefore never a question about
 * whether the shelf or the number is wrong.
 */
describe("inventory", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let inventory: InventoryService;
  let createdTenants: string[] = [];

  const ACTOR_ID = randomUUID();

  function asStaff<T>(tenantId: string, fn: () => Promise<T>, actorId = ACTOR_ID): Promise<T> {
    return TenantContext.run(
      { tenantId: asTenantId(tenantId), actorType: "user", actorId },
      fn,
    );
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  async function seedUser(tenantId: string): Promise<string> {
    const email = `u-${Math.random().toString(36).slice(2, 8)}@test.tn`;
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, full_name, status)
        values (${tenantId}, ${email}, 'hash', 'Magasinier', 'ACTIVE')
        returning id`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed user");
    return row.id;
  }

  async function seedHub(tenantId: string, code = `H-${Math.random().toString(36).slice(2, 8)}`) {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        with a as (
          insert into addresses (tenant_id, raw_input, country_code, location)
          values (${tenantId}, 'Zone industrielle', 'TN',
                  ST_SetSRID(ST_MakePoint(10.18, 36.80), 4326)::geography)
          returning id
        )
        insert into hubs (tenant_id, code, name, type, address_id, location, timezone)
        select ${tenantId}, ${code}, 'Hub', 'SORTING_CENTER', a.id,
               ST_SetSRID(ST_MakePoint(10.18, 36.80), 4326)::geography, 'Africa/Tunis'
          from a
        returning id`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed hub");
    return row.id;
  }

  /** The level of one item at one hub, or 0 when it has never moved there. */
  async function levelOf(tenantId: string, hubId: string, itemId: string): Promise<number> {
    const rows = await asStaff(tenantId, () => inventory.stock({ hubId }));
    return rows.find((row) => row.itemId === itemId)?.quantity ?? 0;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    inventory = new InventoryService(db);
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    await database.close();
  });

  // ── Items ──────────────────────────────────────────────────────────────────
  describe("items", () => {
    it("upper-cases the SKU so ROLL and roll are one item", async () => {
      const tenantId = await seedTenant("inv-sku");
      const item = await asStaff(tenantId, () =>
        inventory.createItem({ sku: "roll-thermal", name: "Rouleau thermique" }),
      );
      expect(item.sku).toBe("ROLL-THERMAL");
    });

    it("refuses a duplicate SKU", async () => {
      const tenantId = await seedTenant("inv-dup");
      await asStaff(tenantId, () => inventory.createItem({ sku: "TAPE", name: "Ruban" }));

      await expect(
        asStaff(tenantId, () => inventory.createItem({ sku: "TAPE", name: "Autre" })),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("retires rather than deletes — past movements reference it", async () => {
      const tenantId = await seedTenant("inv-retire");
      const item = await asStaff(tenantId, () =>
        inventory.createItem({ sku: "TAPE", name: "Ruban" }),
      );

      await asStaff(tenantId, () => inventory.updateItem(item.id, { active: false }));

      expect(await asStaff(tenantId, () => inventory.listItems(true))).toHaveLength(0);
      expect(await asStaff(tenantId, () => inventory.listItems(false))).toHaveLength(1);
    });
  });

  // ── Movements ──────────────────────────────────────────────────────────────
  describe("movements", () => {
    let tenantId: string;
    let userId: string;
    let hubId: string;
    let itemId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("inv-move");
      userId = await seedUser(tenantId);
      hubId = await seedHub(tenantId);
      const item = await asStaff(tenantId, () =>
        inventory.createItem({ sku: "ROLL", name: "Rouleau", unit: "ROLL", reorderLevel: 5 }),
      );
      itemId = item.id;
    });

    it("a receipt raises the level; consumption lowers it", async () => {
      await asStaff(tenantId, () =>
        inventory.record(
          { idempotencyKey: randomUUID(), itemId, hubId, direction: "IN", quantity: 20, reason: "RECEIPT" },
          userId,
        ),
      );
      expect(await levelOf(tenantId, hubId, itemId)).toBe(20);

      await asStaff(tenantId, () =>
        inventory.record(
          {
            idempotencyKey: randomUUID(),
            itemId,
            hubId,
            direction: "OUT",
            quantity: 8,
            reason: "CONSUMPTION",
          },
          userId,
        ),
      );
      expect(await levelOf(tenantId, hubId, itemId)).toBe(12);
    });

    it("⚠️ refuses to consume more than the shelf holds", async () => {
      await asStaff(tenantId, () =>
        inventory.record(
          { idempotencyKey: randomUUID(), itemId, hubId, direction: "IN", quantity: 5, reason: "RECEIPT" },
          userId,
        ),
      );

      // Negative stock is always a data-entry error — you cannot consume tape you
      // do not have — and letting it through means the real error, a missed
      // receipt, is never found.
      await expect(
        asStaff(tenantId, () =>
          inventory.record(
            {
              idempotencyKey: randomUUID(),
              itemId,
              hubId,
              direction: "OUT",
              quantity: 50,
              reason: "CONSUMPTION",
            },
            userId,
          ),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);

      expect(await levelOf(tenantId, hubId, itemId)).toBe(5);
    });

    it("ALLOWS a stocktake that comes up short — that IS the correction", async () => {
      await asStaff(tenantId, () =>
        inventory.record(
          { idempotencyKey: randomUUID(), itemId, hubId, direction: "IN", quantity: 5, reason: "RECEIPT" },
          userId,
        ),
      );

      // Refusing it would leave the book permanently wrong.
      await asStaff(tenantId, () =>
        inventory.record(
          {
            idempotencyKey: randomUUID(),
            itemId,
            hubId,
            direction: "OUT",
            quantity: 7,
            reason: "STOCKTAKE",
            note: "Comptage physique",
          },
          userId,
        ),
      );

      expect(await levelOf(tenantId, hubId, itemId)).toBe(-2);
    });

    it("is idempotent — a double tap does not double the shelf", async () => {
      const key = randomUUID();
      const first = await asStaff(tenantId, () =>
        inventory.record(
          { idempotencyKey: key, itemId, hubId, direction: "IN", quantity: 10, reason: "RECEIPT" },
          userId,
        ),
      );
      const again = await asStaff(tenantId, () =>
        inventory.record(
          { idempotencyKey: key, itemId, hubId, direction: "IN", quantity: 10, reason: "RECEIPT" },
          userId,
        ),
      );

      // A storeman on a bad connection taps "receive" twice; the shelf must not
      // gain stock that never arrived.
      expect(again.id).toBe(first.id);
      expect(await levelOf(tenantId, hubId, itemId)).toBe(10);
    });

    it("refuses a zero or negative quantity — direction carries the sign", async () => {
      await expect(
        asStaff(tenantId, () =>
          inventory.record(
            { idempotencyKey: randomUUID(), itemId, hubId, direction: "IN", quantity: 0, reason: "RECEIPT" },
            userId,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        asStaff(tenantId, () =>
          inventory.record(
            { idempotencyKey: randomUUID(), itemId, hubId, direction: "IN", quantity: -5, reason: "RECEIPT" },
            userId,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses TRANSFER through the single-hub command", async () => {
      // A transfer must write both legs; a caller that could post one alone
      // would make stock vanish in transit.
      await expect(
        asStaff(tenantId, () =>
          inventory.record(
            {
              idempotencyKey: randomUUID(),
              itemId,
              hubId,
              direction: "OUT",
              quantity: 1,
              reason: "TRANSFER",
            },
            userId,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // ── Transfers ──────────────────────────────────────────────────────────────
  describe("transfer", () => {
    let tenantId: string;
    let userId: string;
    let fromHubId: string;
    let toHubId: string;
    let itemId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("inv-transfer");
      userId = await seedUser(tenantId);
      fromHubId = await seedHub(tenantId, "H-FROM");
      toHubId = await seedHub(tenantId, "H-TO");
      const item = await asStaff(tenantId, () => inventory.createItem({ sku: "ROLL", name: "Rouleau" }));
      itemId = item.id;

      await asStaff(tenantId, () =>
        inventory.record(
          {
            idempotencyKey: randomUUID(),
            itemId,
            hubId: fromHubId,
            direction: "IN",
            quantity: 30,
            reason: "RECEIPT",
          },
          userId,
        ),
      );
    });

    it("moves stock between hubs, writing BOTH legs", async () => {
      const legs = await asStaff(tenantId, () =>
        inventory.transfer(
          { idempotencyKey: randomUUID(), itemId, fromHubId, toHubId, quantity: 12 },
          userId,
        ),
      );

      expect(legs).toHaveLength(2);
      expect(await levelOf(tenantId, fromHubId, itemId)).toBe(18);
      expect(await levelOf(tenantId, toHubId, itemId)).toBe(12);
    });

    it("each leg points at the other hub", async () => {
      const legs = await asStaff(tenantId, () =>
        inventory.transfer(
          { idempotencyKey: randomUUID(), itemId, fromHubId, toHubId, quantity: 5 },
          userId,
        ),
      );

      const out = legs.find((leg) => leg.direction === "OUT");
      const incoming = legs.find((leg) => leg.direction === "IN");
      expect(out?.counterpartHubId).toBe(toHubId);
      expect(incoming?.counterpartHubId).toBe(fromHubId);
    });

    it("⚠️ refuses to send more than the source holds — nothing is written", async () => {
      await expect(
        asStaff(tenantId, () =>
          inventory.transfer(
            { idempotencyKey: randomUUID(), itemId, fromHubId, toHubId, quantity: 500 },
            userId,
          ),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);

      // Neither leg landed: the destination must not gain stock that never left.
      expect(await levelOf(tenantId, fromHubId, itemId)).toBe(30);
      expect(await levelOf(tenantId, toHubId, itemId)).toBe(0);
    });

    it("is idempotent across BOTH legs", async () => {
      const key = randomUUID();
      await asStaff(tenantId, () =>
        inventory.transfer({ idempotencyKey: key, itemId, fromHubId, toHubId, quantity: 10 }, userId),
      );
      await asStaff(tenantId, () =>
        inventory.transfer({ idempotencyKey: key, itemId, fromHubId, toHubId, quantity: 10 }, userId),
      );

      expect(await levelOf(tenantId, fromHubId, itemId)).toBe(20);
      expect(await levelOf(tenantId, toHubId, itemId)).toBe(10);
    });

    it("refuses a transfer to the same hub", async () => {
      await expect(
        asStaff(tenantId, () =>
          inventory.transfer(
            { idempotencyKey: randomUUID(), itemId, fromHubId, toHubId: fromHubId, quantity: 1 },
            userId,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // ── The log is append-only ─────────────────────────────────────────────────
  describe("immutability", () => {
    it("dp_app cannot UPDATE or DELETE a movement", async () => {
      const tenantId = await seedTenant("inv-frozen");
      const userId = await seedUser(tenantId);
      const hubId = await seedHub(tenantId);
      const item = await asStaff(tenantId, () => inventory.createItem({ sku: "ROLL", name: "R" }));
      const movement = await asStaff(tenantId, () =>
        inventory.record(
          {
            idempotencyKey: randomUUID(),
            itemId: item.id,
            hubId,
            direction: "IN",
            quantity: 10,
            reason: "RECEIPT",
          },
          userId,
        ),
      );

      // ⚠️ Attacked as dp_app on the REAL connection, not through the service —
      // the guarantee is the GRANT (SELECT and INSERT only), and a test that
      // went through the service would prove nothing but that the service has
      // no update method.
      //
      // A mistake is corrected by a STOCKTAKE, which leaves both the error and
      // the correction visible.
      await expect(
        database.app.begin(async (tx) => {
          await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
          return tx`update inventory_movements set quantity = 999 where id = ${movement.id}`;
        }),
      ).rejects.toThrow(/permission denied/iu);

      await expect(
        database.app.begin(async (tx) => {
          await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
          return tx`delete from inventory_movements where id = ${movement.id}`;
        }),
      ).rejects.toThrow(/permission denied/iu);
    });
  });

  // ── Low stock ──────────────────────────────────────────────────────────────
  describe("low stock", () => {
    it("flags a shelf at or below its reorder level", async () => {
      const tenantId = await seedTenant("inv-low");
      const userId = await seedUser(tenantId);
      const hubId = await seedHub(tenantId);
      const item = await asStaff(tenantId, () =>
        inventory.createItem({ sku: "ROLL", name: "Rouleau", reorderLevel: 5 }),
      );

      await asStaff(tenantId, () =>
        inventory.record(
          {
            idempotencyKey: randomUUID(),
            itemId: item.id,
            hubId,
            direction: "IN",
            quantity: 5,
            reason: "RECEIPT",
          },
          userId,
        ),
      );

      // AT the level counts as low: a courier that waits until it is below has
      // already run out by the time the order arrives.
      const rows = await asStaff(tenantId, () => inventory.stock({ lowOnly: true }));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.low).toBe(true);
      expect(await asStaff(tenantId, () => inventory.lowStockCount())).toBe(1);
    });

    it("ignores an item with NO reorder level", async () => {
      const tenantId = await seedTenant("inv-nolevel");
      const userId = await seedUser(tenantId);
      const hubId = await seedHub(tenantId);
      const item = await asStaff(tenantId, () => inventory.createItem({ sku: "MISC", name: "Divers" }));

      await asStaff(tenantId, () =>
        inventory.record(
          {
            idempotencyKey: randomUUID(),
            itemId: item.id,
            hubId,
            direction: "IN",
            quantity: 1,
            reason: "RECEIPT",
          },
          userId,
        ),
      );

      // NULL means "never warn", and `lte` against NULL yields NULL, which
      // filters the row out.
      expect(await asStaff(tenantId, () => inventory.lowStockCount())).toBe(0);
    });

    it("shows nothing for a SKU that has never moved at a hub", async () => {
      const tenantId = await seedTenant("inv-never");
      const hubId = await seedHub(tenantId);
      await asStaff(tenantId, () => inventory.createItem({ sku: "NEW", name: "Jamais reçu" }));

      // Its level is not "zero" — it is "never stocked here", and inventing a
      // zero would put every SKU on every hub's screen.
      expect(await asStaff(tenantId, () => inventory.stock({ hubId }))).toHaveLength(0);
    });
  });

  // ── Isolation ──────────────────────────────────────────────────────────────
  describe("tenant isolation", () => {
    it("never shows another courier's stock", async () => {
      const alpha = await seedTenant("inv-iso-a");
      const beta = await seedTenant("inv-iso-b");
      const userId = await seedUser(alpha);
      const hubId = await seedHub(alpha);
      const item = await asStaff(alpha, () => inventory.createItem({ sku: "ROLL", name: "R" }));

      await asStaff(alpha, () =>
        inventory.record(
          {
            idempotencyKey: randomUUID(),
            itemId: item.id,
            hubId,
            direction: "IN",
            quantity: 10,
            reason: "RECEIPT",
          },
          userId,
        ),
      );

      // The level VIEW runs with security_invoker, so RLS applies to it exactly
      // as it does to the table underneath.
      expect(await asStaff(beta, () => inventory.stock())).toHaveLength(0);
      expect(await asStaff(beta, () => inventory.listItems())).toHaveLength(0);
      expect((await asStaff(beta, () => inventory.listMovements())).items).toHaveLength(0);
    });

    it("lets both tenants use the same SKU independently", async () => {
      const alpha = await seedTenant("inv-iso-c");
      const beta = await seedTenant("inv-iso-d");

      await asStaff(alpha, () => inventory.createItem({ sku: "ROLL", name: "Rouleau" }));
      // The unique index is per tenant; two couriers stocking label rolls is
      // normal, not a duplicate.
      await expect(
        asStaff(beta, () => inventory.createItem({ sku: "ROLL", name: "Rouleau" })),
      ).resolves.toBeDefined();
    });
  });
});
