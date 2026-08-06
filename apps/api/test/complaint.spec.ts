import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ComplaintService } from "../src/modules/complaint/application/complaint.service.js";
import { canComplaintTransition, formatComplaintCode } from "../src/modules/complaint/index.js";
import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { LedgerService } from "../src/modules/finance/application/ledger.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
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
 * Complaints / réclamations (docs/02-domain-model.md §3.20).
 *
 * The interesting part is not the CRUD — it is `COD_DISPUTE`, which answers
 * hotspot H8: what happens to collected cash when a delivery is later disputed.
 * The answer is a REVERSING ledger transaction, and the tests below hold it to
 * that: the original entries must survive untouched, the reversal must balance,
 * and it must be impossible to run twice.
 */
describe("complaints", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let complaints: ComplaintService;
  let shipments: ShipmentService;
  let merchants: MerchantService;
  let ledger: LedgerService;
  let createdTenants: string[] = [];

  const STAFF = randomUUID();

  async function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run(
      { tenantId: asTenantId(tenantId), actorType: "user", actorId: STAFF },
      fn,
    );
  }

  async function asMerchant<T>(
    tenantId: string,
    merchantId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "user", merchantId }, fn);
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  async function seedMerchant(tenantId: string, name: string): Promise<string> {
    return asStaff(tenantId, async () => (await merchants.create({ name })).id);
  }

  /**
   * Inserts a driver directly.
   *
   * `complaints.driver_id` carries a real foreign key, so an invented UUID is
   * correctly rejected — which is the constraint doing its job, not a nuisance.
   */
  async function seedDriver(tenantId: string): Promise<string> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into drivers (tenant_id, employee_code, full_name, phone, status, employment_type)
        values (${tenantId}, ${`D-${randomUUID().slice(0, 6)}`}, 'Test Driver',
                ${`+2162${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`},
                'ACTIVE', 'EMPLOYEE')
        returning id
      `,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed driver");
    return row.id;
  }

  async function seedShipment(
    tenantId: string,
    merchantId: string,
    codAmountMinor = 45_000,
  ): Promise<string> {
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
        { actor: { actorType: "API_CLIENT" } },
      ),
    );
    return created.id;
  }

  /** Posts the COD_COLLECTED transaction a delivery would produce. */
  async function collectCod(
    tenantId: string,
    shipmentId: string,
    merchantId: string,
    amountMinor: bigint,
  ): Promise<void> {
    const driverId = randomUUID();
    await db.withTenant(async (tx) => {
      await ledger.postTransaction(tx, {
        tenantId,
        entryType: "COD_COLLECTED",
        currency: "TND",
        shipmentId,
        description: "COD collected on delivery",
        lines: [
          {
            account: { ownerType: "DRIVER", ownerId: driverId, accountType: "DRIVER_CASH" },
            direction: "DEBIT",
            amountMinor,
          },
          {
            account: {
              ownerType: "MERCHANT",
              ownerId: merchantId,
              accountType: "MERCHANT_PAYABLE",
            },
            direction: "CREDIT",
            amountMinor,
          },
        ],
      });
    }, asTenantId(tenantId));
  }

  async function raise(
    tenantId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; code: string }> {
    const complaint = await asStaff(tenantId, () =>
      complaints.create({
        idempotencyKey: randomUUID(),
        type: "DAMAGED",
        description: "Parcel arrived crushed",
        raisedByType: "STAFF",
        ...overrides,
      }),
    );
    return { id: complaint.id, code: complaint.code };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const audit = new AuditService(db);
    const addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    merchants = new MerchantService(db, outbox, new AuditService(db), new AddressService(db, outbox, new ManualGeocodingProvider()));
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
    );
    ledger = new LedgerService(db);
    complaints = new ComplaintService(db, outbox, audit, ledger, shipments);
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── Raising ────────────────────────────────────────────────────────────────

  describe("create", () => {
    it("raises a complaint with a quotable code and an SLA", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");

      const complaint = await asStaff(tenantId, () =>
        complaints.create({
          idempotencyKey: randomUUID(),
          type: "LATE",
          description: "Three days late",
          raisedByType: "MERCHANT",
          merchantId,
        }),
      );

      // `RC` for réclamation — the word the business actually uses.
      expect(complaint.code).toMatch(/^RC-\d{8}-\d{3}$/u);
      expect(complaint.status).toBe("OPEN");
      expect(complaint.severity).toBe("MEDIUM");
      // Computed from the type's SLA hours, so a dashboard can show a deadline.
      expect(complaint.slaDueAt).not.toBeNull();
    });

    it("inherits the merchant from the shipment rather than trusting the request", async () => {
      const tenantId = await seedTenant("cx");
      const real = await seedMerchant(tenantId, "Real");
      const other = await seedMerchant(tenantId, "Other");
      const shipmentId = await seedShipment(tenantId, real);

      const complaint = await asStaff(tenantId, () =>
        complaints.create({
          idempotencyKey: randomUUID(),
          type: "DAMAGED",
          description: "Crushed",
          raisedByType: "STAFF",
          shipmentId,
          // A caller naming the WRONG merchant must not be able to hide the
          // complaint from the party it concerns — merchant_id is what the RLS
          // narrowing keys on.
          merchantId: other,
        }),
      );

      expect(complaint.merchantId).toBe(real);
    });

    it("is idempotent — a retried request returns the first complaint", async () => {
      const tenantId = await seedTenant("cx");
      const key = randomUUID();
      const input = {
        idempotencyKey: key,
        type: "LOST" as const,
        description: "Never arrived",
        raisedByType: "STAFF" as const,
        merchantId: await seedMerchant(tenantId, "Boutique"),
      };

      const first = await asStaff(tenantId, () => complaints.create(input));
      const second = await asStaff(tenantId, () => complaints.create(input));

      // A duplicate splits one dispute into two half-investigations.
      expect(second.id).toBe(first.id);
      expect(second.code).toBe(first.code);
    });

    it("refuses a complaint that references nothing", async () => {
      const tenantId = await seedTenant("cx");
      await expect(
        asStaff(tenantId, () =>
          complaints.create({
            idempotencyKey: randomUUID(),
            type: "OTHER",
            description: "Something happened",
            raisedByType: "STAFF",
          }),
        ),
        // A complaint naming no subject cannot be investigated, routed or counted.
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses a COD_DISPUTE with no shipment", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      await expect(
        asStaff(tenantId, () =>
          complaints.create({
            idempotencyKey: randomUUID(),
            type: "COD_DISPUTE",
            description: "Money not received",
            raisedByType: "MERCHANT",
            merchantId,
          }),
        ),
        // There would be nothing to reverse and no way to size the claim.
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses a shipment from another tenant", async () => {
      const tenantA = await seedTenant("cx-a");
      const tenantB = await seedTenant("cx-b");
      const merchantB = await seedMerchant(tenantB, "Other Courier");
      const foreign = await seedShipment(tenantB, merchantB);

      await expect(
        asStaff(tenantA, () =>
          complaints.create({
            idempotencyKey: randomUUID(),
            type: "DAMAGED",
            description: "Crushed",
            raisedByType: "STAFF",
            shipmentId: foreign,
          }),
        ),
        // Rule 1, enforced by RLS rather than by a WHERE clause.
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("records the opening in the append-only trail", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const { id } = await raise(tenantId, { merchantId });

      const detail = await asStaff(tenantId, () => complaints.getById(id));
      const opening = detail.activity.find((a) => a.kind === "STATUS_CHANGED");
      expect(opening?.toStatus).toBe("OPEN");
    });

    it("publishes complaint.raised", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const { id } = await raise(tenantId, { merchantId });

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ event_type: string }[]>`
          select event_type from outbox where aggregate_id = ${id}
        `,
      );
      expect(rows.map((r) => r.event_type)).toContain("complaint.raised");
    });
  });

  // ── The lifecycle ──────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("walks OPEN → INVESTIGATING → RESOLVED", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const { id } = await raise(tenantId, { merchantId });

      await asStaff(tenantId, () =>
        complaints.transition(id, { status: "INVESTIGATING", idempotencyKey: randomUUID() }),
      );
      const resolved = await asStaff(tenantId, () =>
        complaints.transition(id, {
          status: "RESOLVED",
          resolution: "Replaced the item and refunded shipping",
          idempotencyKey: randomUUID(),
        }),
      );

      expect(resolved.status).toBe("RESOLVED");
      expect(resolved.resolvedAt).not.toBeNull();
      expect(resolved.resolvedByUserId).toBe(STAFF);
    });

    it("REFUSES to close without a recorded outcome", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const { id } = await raise(tenantId, { merchantId });

      await expect(
        asStaff(tenantId, () =>
          complaints.transition(id, { status: "RESOLVED", idempotencyKey: randomUUID() }),
        ),
        // Rule 2. A closed complaint with no outcome is not a record of anything.
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("enforces rule 2 in the DATABASE, not only in the service", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const { id } = await raise(tenantId, { merchantId });

      // Bypassing the service entirely: the constraint is what makes the rule
      // survive a future code path that forgets it.
      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`
            update complaints set status = 'RESOLVED', resolved_at = now() where id = ${id}
          `,
        ),
      ).rejects.toThrow(/complaints_resolution_chk/u);
    });

    it("refuses to reopen a closed complaint", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const { id } = await raise(tenantId, { merchantId });

      await asStaff(tenantId, () =>
        complaints.transition(id, {
          status: "REJECTED",
          resolution: "No evidence of damage",
          idempotencyKey: randomUUID(),
        }),
      );

      await expect(
        asStaff(tenantId, () =>
          complaints.transition(id, { status: "INVESTIGATING", idempotencyKey: randomUUID() }),
        ),
        // Reopening rewrites a closed outcome. The correct move is a new
        // complaint that references this one.
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("refuses an illegal transition", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const { id } = await raise(tenantId, { merchantId });

      await asStaff(tenantId, () =>
        complaints.transition(id, { status: "ESCALATED", idempotencyKey: randomUUID() }),
      );

      await expect(
        asStaff(tenantId, () =>
          complaints.transition(id, { status: "INVESTIGATING", idempotencyKey: randomUUID() }),
        ),
        // ESCALATED does not go back to INVESTIGATING.
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("is idempotent on the transition key", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const { id } = await raise(tenantId, { merchantId });
      const key = randomUUID();

      await asStaff(tenantId, () =>
        complaints.transition(id, { status: "INVESTIGATING", idempotencyKey: key }),
      );
      // A retry must not append a second status entry, or the trail claims the
      // complaint moved twice.
      await asStaff(tenantId, () =>
        complaints.transition(id, { status: "ESCALATED", idempotencyKey: key }),
      );

      const detail = await asStaff(tenantId, () => complaints.getById(id));
      expect(detail.complaint.status).toBe("INVESTIGATING");
    });

    it("records every transition in the trail", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const { id } = await raise(tenantId, { merchantId });

      await asStaff(tenantId, () =>
        complaints.transition(id, { status: "INVESTIGATING", idempotencyKey: randomUUID() }),
      );
      await asStaff(tenantId, () =>
        complaints.transition(id, {
          status: "RESOLVED",
          resolution: "Compensated",
          idempotencyKey: randomUUID(),
        }),
      );

      const detail = await asStaff(tenantId, () => complaints.getById(id));
      const statuses = detail.activity
        .filter((a) => a.kind === "STATUS_CHANGED")
        .map((a) => a.toStatus);
      expect(statuses).toEqual(["OPEN", "INVESTIGATING", "RESOLVED"]);
    });

    it("has an append-only trail — UPDATE is refused even to the owner", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const { id } = await raise(tenantId, { merchantId });

      const rows = await database.migrator<{ privilege_type: string }[]>`
        select privilege_type from information_schema.role_table_grants
        where table_name = 'complaint_activity' and grantee = 'dp_app'
      `;
      const granted = new Set(rows.map((r) => r.privilege_type));
      expect(granted.has("SELECT")).toBe(true);
      expect(granted.has("INSERT")).toBe(true);
      // Rule 5. A dispute's history must not be rewritable, because a dispute is
      // exactly when it is read.
      expect(granted.has("UPDATE")).toBe(false);
      expect(granted.has("DELETE")).toBe(false);
      expect(id).toBeDefined();
    });

    it("never allows a complaint to be deleted", async () => {
      const rows = await database.migrator<{ privilege_type: string }[]>`
        select privilege_type from information_schema.role_table_grants
        where table_name = 'complaints' and grantee = 'dp_app'
      `;
      const granted = new Set(rows.map((r) => r.privilege_type));
      // Rule 7 — status is the lifecycle.
      expect(granted.has("DELETE")).toBe(false);
      expect(granted.has("UPDATE")).toBe(true);
    });
  });

  // ── COD_DISPUTE: hotspot H8 ────────────────────────────────────────────────

  describe("COD dispute reversal", () => {
    async function disputeWithCollectedCod(
      amountMinor = 45_000n,
    ): Promise<{ tenantId: string; complaintId: string; shipmentId: string; merchantId: string }> {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const shipmentId = await seedShipment(tenantId, merchantId, Number(amountMinor));
      await collectCod(tenantId, shipmentId, merchantId, amountMinor);

      const complaint = await asStaff(tenantId, () =>
        complaints.create({
          idempotencyKey: randomUUID(),
          type: "COD_DISPUTE",
          description: "Buyer says they never paid this",
          raisedByType: "MERCHANT",
          shipmentId,
        }),
      );

      return { tenantId, complaintId: complaint.id, shipmentId, merchantId };
    }

    it("posts a balanced REVERSAL that mirrors the original entries", async () => {
      const { tenantId, complaintId, shipmentId } = await disputeWithCollectedCod();

      const resolved = await asStaff(tenantId, () =>
        complaints.transition(complaintId, {
          status: "RESOLVED",
          resolution: "Dispute upheld — COD returned",
          reverseCod: true,
          idempotencyKey: randomUUID(),
        }),
      );

      expect(resolved.reversalTransactionId).not.toBeNull();

      const entries = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ entry_type: string; direction: string; amount_minor: string }[]>`
          select entry_type, direction, amount_minor from ledger_entries
          where shipment_id = ${shipmentId} order by id
        `,
      );

      const originals = entries.filter((e) => e.entry_type === "COD_COLLECTED");
      const reversals = entries.filter((e) => e.entry_type === "REVERSAL");

      // The original entries survive UNTOUCHED. An accounting record that can be
      // amended is not a record.
      expect(originals).toHaveLength(2);
      expect(reversals).toHaveLength(2);

      // Every direction mirrored, so the reversal balances by construction.
      const originalDebit = originals.find((e) => e.direction === "DEBIT");
      const reversalCredit = reversals.find((e) => e.direction === "CREDIT");
      expect(reversalCredit?.amount_minor).toBe(originalDebit?.amount_minor);

      const sum = (
        rows: readonly { direction: string; amount_minor: string }[],
        direction: string,
      ): bigint =>
        rows
          .filter((e) => e.direction === direction)
          .reduce((total, e) => total + BigInt(e.amount_minor), 0n);
      // Zero-sum, which the DEFERRABLE trigger also enforces — asserted here so
      // the reversal's own construction is what is being tested.
      expect(sum(reversals, "DEBIT")).toBe(sum(reversals, "CREDIT"));
    });

    it("returns the merchant's payable balance to zero", async () => {
      const amount = 45_000n;
      const { tenantId, complaintId, merchantId } = await disputeWithCollectedCod(amount);

      const before = await db.withTenant(
        (tx) =>
          ledger.balanceOf(tx, tenantId, "TND", {
            ownerType: "MERCHANT",
            ownerId: merchantId,
            accountType: "MERCHANT_PAYABLE",
          }),
        asTenantId(tenantId),
      );
      expect(before).toBe(amount);

      await asStaff(tenantId, () =>
        complaints.transition(complaintId, {
          status: "RESOLVED",
          resolution: "Upheld",
          reverseCod: true,
          idempotencyKey: randomUUID(),
        }),
      );

      const after = await db.withTenant(
        (tx) =>
          ledger.balanceOf(tx, tenantId, "TND", {
            ownerType: "MERCHANT",
            ownerId: merchantId,
            accountType: "MERCHANT_PAYABLE",
          }),
        asTenantId(tenantId),
      );
      // The money the courier owed the merchant is no longer owed.
      expect(after).toBe(0n);
    });

    it("reverses the amount ACTUALLY collected, not the amount ordered", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      // Ordered 50.000, collected 30.000 — a partial collection.
      const shipmentId = await seedShipment(tenantId, merchantId, 50_000);
      await collectCod(tenantId, shipmentId, merchantId, 30_000n);

      const complaint = await asStaff(tenantId, () =>
        complaints.create({
          idempotencyKey: randomUUID(),
          type: "COD_DISPUTE",
          description: "Partial payment disputed",
          raisedByType: "MERCHANT",
          shipmentId,
        }),
      );

      await asStaff(tenantId, () =>
        complaints.transition(complaint.id, {
          status: "RESOLVED",
          resolution: "Upheld",
          reverseCod: true,
          idempotencyKey: randomUUID(),
        }),
      );

      const reversals = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ amount_minor: string }[]>`
          select amount_minor from ledger_entries
          where shipment_id = ${shipmentId} and entry_type = 'REVERSAL'
        `,
      );
      // 30.000, not 50.000. Reversing a recomputed figure leaves the ledger
      // balanced against itself but wrong against reality.
      for (const row of reversals) {
        expect(row.amount_minor).toBe("30000");
      }
    });

    it("refuses to reverse twice", async () => {
      const { tenantId, complaintId } = await disputeWithCollectedCod();

      await asStaff(tenantId, () =>
        complaints.transition(complaintId, {
          status: "RESOLVED",
          resolution: "Upheld",
          reverseCod: true,
          idempotencyKey: randomUUID(),
        }),
      );

      // Already closed, so the transition itself is refused — and even reaching
      // the reversal would hit `reversal_transaction_id`.
      await expect(
        asStaff(tenantId, () =>
          complaints.transition(complaintId, {
            status: "RESOLVED",
            resolution: "Upheld again",
            reverseCod: true,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("does NOT reverse when the dispute is rejected", async () => {
      const { tenantId, complaintId, shipmentId } = await disputeWithCollectedCod();

      await asStaff(tenantId, () =>
        complaints.transition(complaintId, {
          status: "REJECTED",
          resolution: "Signed POD and cash receipt on file",
          idempotencyKey: randomUUID(),
        }),
      );

      const reversals = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ id: string }[]>`
          select id from ledger_entries
          where shipment_id = ${shipmentId} and entry_type = 'REVERSAL'
        `,
      );
      // A dispute found to be without merit moves no money.
      expect(reversals).toHaveLength(0);
    });

    it("refuses reverseCod on a REJECTED transition", async () => {
      const { tenantId, complaintId } = await disputeWithCollectedCod();
      await expect(
        asStaff(tenantId, () =>
          complaints.transition(complaintId, {
            status: "REJECTED",
            resolution: "No merit",
            reverseCod: true,
            idempotencyKey: randomUUID(),
          }),
        ),
        // Rejecting a claim and refunding it is a contradiction.
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses to reverse a non-COD_DISPUTE complaint", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const shipmentId = await seedShipment(tenantId, merchantId);
      await collectCod(tenantId, shipmentId, merchantId, 45_000n);
      const { id } = await raise(tenantId, { shipmentId });

      await expect(
        asStaff(tenantId, () =>
          complaints.transition(id, {
            status: "RESOLVED",
            resolution: "Replaced",
            reverseCod: true,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("refuses to reverse when no COD was ever collected", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const shipmentId = await seedShipment(tenantId, merchantId);
      // No collectCod call — the parcel was never delivered.

      const complaint = await asStaff(tenantId, () =>
        complaints.create({
          idempotencyKey: randomUUID(),
          type: "COD_DISPUTE",
          description: "Disputed",
          raisedByType: "MERCHANT",
          shipmentId,
        }),
      );

      await expect(
        asStaff(tenantId, () =>
          complaints.transition(complaint.id, {
            status: "RESOLVED",
            resolution: "Upheld",
            reverseCod: true,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("records the reversal in the trail", async () => {
      const { tenantId, complaintId } = await disputeWithCollectedCod();

      await asStaff(tenantId, () =>
        complaints.transition(complaintId, {
          status: "RESOLVED",
          resolution: "Upheld",
          reverseCod: true,
          idempotencyKey: randomUUID(),
        }),
      );

      const detail = await asStaff(tenantId, () => complaints.getById(complaintId));
      const reversal = detail.activity.find((a) => a.kind === "REVERSAL_POSTED");
      expect(reversal?.note).toContain("COD reversed");
    });

    it("audits the reversal as a ledger adjustment", async () => {
      const { tenantId, complaintId } = await disputeWithCollectedCod();

      await asStaff(tenantId, () =>
        complaints.transition(complaintId, {
          status: "RESOLVED",
          resolution: "Upheld",
          reverseCod: true,
          idempotencyKey: randomUUID(),
        }),
      );

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ action: string }[]>`
          select action from audit_log where resource_id = ${complaintId}
        `,
      );
      // Moving money is a §10 mandatory audit action.
      expect(rows.map((r) => r.action)).toContain("ledger.adjusted");
    });
  });

  // ── Merchant scoping ───────────────────────────────────────────────────────

  describe("merchant isolation", () => {
    it("shows a merchant only their own complaints", async () => {
      const tenantId = await seedTenant("cx");
      const alpha = await seedMerchant(tenantId, "Alpha");
      const beta = await seedMerchant(tenantId, "Beta");

      await raise(tenantId, { merchantId: alpha, description: "Alpha issue" });
      await raise(tenantId, { merchantId: beta, description: "Beta issue" });

      const forAlpha = await asMerchant(tenantId, alpha, () => complaints.list({}));
      expect(forAlpha.items).toHaveLength(1);
      expect(forAlpha.items[0]?.merchantId).toBe(alpha);
    });

    it("hides a courier-internal complaint from every merchant", async () => {
      const tenantId = await seedTenant("cx");
      const alpha = await seedMerchant(tenantId, "Alpha");
      // Driver conduct: no merchant, so it is the courier's own business.
      const driverId = await seedDriver(tenantId);
      await raise(tenantId, { driverId, type: "DRIVER_CONDUCT" });

      const forAlpha = await asMerchant(tenantId, alpha, () => complaints.list({}));
      // `current_merchant_allows` fails closed on a NULL merchant_id.
      expect(forAlpha.items).toHaveLength(0);

      const forStaff = await asStaff(tenantId, () => complaints.list({}));
      expect(forStaff.items).toHaveLength(1);
    });

    it("never shows another tenant's complaints", async () => {
      const tenantA = await seedTenant("cx-a");
      const tenantB = await seedTenant("cx-b");
      const merchantA = await seedMerchant(tenantA, "A");
      await raise(tenantA, { merchantId: merchantA });

      const inB = await asStaff(tenantB, () => complaints.list({}));
      expect(inB.items).toHaveLength(0);
    });
  });

  // ── Queue management ───────────────────────────────────────────────────────

  describe("queue", () => {
    it("filters by status, type, severity and overdue", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");

      await raise(tenantId, { merchantId, type: "DAMAGED", severity: "HIGH" });
      const late = await raise(tenantId, { merchantId, type: "LATE", severity: "LOW" });

      const byType = await asStaff(tenantId, () => complaints.list({ type: "LATE" }));
      expect(byType.items.map((c) => c.id)).toEqual([late.id]);

      const bySeverity = await asStaff(tenantId, () => complaints.list({ severity: "HIGH" }));
      expect(bySeverity.items).toHaveLength(1);

      // Nothing is overdue yet.
      const overdue = await asStaff(tenantId, () => complaints.list({ overdueOnly: true }));
      expect(overdue.items).toHaveLength(0);

      await withTenantContext(
        database.migrator,
        tenantId,
        (tx) =>
          tx`update complaints set sla_due_at = now() - interval '1 hour' where id = ${late.id}`,
      );
      const nowOverdue = await asStaff(tenantId, () => complaints.list({ overdueOnly: true }));
      expect(nowOverdue.items.map((c) => c.id)).toEqual([late.id]);
    });

    it("assigns and records it", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const { id } = await raise(tenantId, { merchantId });
      const assignee = randomUUID();

      const assigned = await asStaff(tenantId, () =>
        complaints.assign(id, { assignedToUserId: assignee }),
      );
      expect(assigned.assignedToUserId).toBe(assignee);

      const detail = await asStaff(tenantId, () => complaints.getById(id));
      expect(detail.activity.some((a) => a.kind === "ASSIGNED")).toBe(true);
    });

    it("refuses to reassign a closed complaint", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const { id } = await raise(tenantId, { merchantId });

      await asStaff(tenantId, () =>
        complaints.transition(id, {
          status: "RESOLVED",
          resolution: "Done",
          idempotencyKey: randomUUID(),
        }),
      );

      await expect(
        asStaff(tenantId, () => complaints.assign(id, { assignedToUserId: randomUUID() })),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("adds comments as entries, never editing the description", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const { id } = await raise(tenantId, { merchantId });

      await asStaff(tenantId, () => complaints.comment(id, { note: "Called the buyer" }));

      const detail = await asStaff(tenantId, () => complaints.getById(id));
      expect(
        detail.activity.some((a) => a.kind === "COMMENT" && a.note === "Called the buyer"),
      ).toBe(true);
      expect(detail.complaint.description).toBe("Parcel arrived crushed");
    });

    it("paginates", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      for (let i = 0; i < 3; i += 1) {
        await raise(tenantId, { merchantId, description: `Issue ${String(i)}` });
      }

      const first = await asStaff(tenantId, () => complaints.list({ limit: 2 }));
      expect(first.items).toHaveLength(2);
      const second = await asStaff(tenantId, () =>
        complaints.list({ limit: 2, cursor: first.nextCursor ?? undefined }),
      );
      const ids = new Set([...first.items, ...second.items].map((c) => c.id));
      expect(ids.size).toBe(3);
    });
  });

  // ── SLA configuration ──────────────────────────────────────────────────────

  describe("sla policies", () => {
    it("uses a tenant's configured hours over the default", async () => {
      const tenantId = await seedTenant("cx");
      const merchantId = await seedMerchant(tenantId, "Boutique");

      await asStaff(tenantId, () => complaints.setSlaPolicy({ type: "LATE", dueHours: 4 }));

      const before = Date.now();
      const complaint = await asStaff(tenantId, () =>
        complaints.create({
          idempotencyKey: randomUUID(),
          type: "LATE",
          description: "Very late",
          raisedByType: "MERCHANT",
          merchantId,
        }),
      );

      const dueIn = (complaint.slaDueAt?.getTime() ?? 0) - before;
      // 4 hours, not the 48-hour default for LATE.
      expect(dueIn).toBeGreaterThan(3.5 * 3_600_000);
      expect(dueIn).toBeLessThan(4.5 * 3_600_000);
    });

    it("updates an existing policy rather than duplicating it", async () => {
      const tenantId = await seedTenant("cx");
      await asStaff(tenantId, () => complaints.setSlaPolicy({ type: "DAMAGED", dueHours: 6 }));
      await asStaff(tenantId, () => complaints.setSlaPolicy({ type: "DAMAGED", dueHours: 12 }));

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ due_hours: number }[]>`
          select due_hours from complaint_sla_policies where type = 'DAMAGED'
        `,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.due_hours).toBe(12);
    });
  });

  // ── Pure domain ────────────────────────────────────────────────────────────

  describe("domain", () => {
    it("formats a quotable code", () => {
      expect(formatComplaintCode(new Date("2026-07-29T10:00:00Z"), 7)).toBe("RC-20260729-007");
    });

    it("rejects a non-positive ordinal", () => {
      expect(() => formatComplaintCode(new Date(), 0)).toThrow(/positive integer/u);
    });

    it("permits only the lifecycle's transitions", () => {
      expect(canComplaintTransition("OPEN", "INVESTIGATING")).toBe(true);
      expect(canComplaintTransition("INVESTIGATING", "ESCALATED")).toBe(true);
      expect(canComplaintTransition("ESCALATED", "RESOLVED")).toBe(true);
      // Terminal.
      expect(canComplaintTransition("RESOLVED", "OPEN")).toBe(false);
      expect(canComplaintTransition("REJECTED", "INVESTIGATING")).toBe(false);
      // Backwards.
      expect(canComplaintTransition("ESCALATED", "INVESTIGATING")).toBe(false);
    });
  });
});
