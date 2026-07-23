import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CurrencyService } from "../src/modules/finance/application/currency.service.js";
import { LedgerService } from "../src/modules/finance/application/ledger.service.js";
import type { AccountRef } from "../src/modules/finance/application/ledger.service.js";
import { LedgerEventHandler } from "../src/modules/finance/application/ledger-event.handler.js";
import { ledgerAccounts, ledgerEntries } from "../src/modules/finance/domain/schema.js";
import { formatMinorUnits, parseMinorUnits } from "../src/modules/finance/domain/money.js";
import type { ConsumedEvent } from "../src/modules/platform/index.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { asTenantId } from "../src/shared/database/tenant-context.js";
import { createTenant, createTestDatabase, deleteTenants } from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Finance module — the double-entry ledger — against a real PostgreSQL with the
 * real currencies seed, RLS, the append-only REVOKE, and the deferred zero-sum
 * trigger. None of those guarantees can be proven against a mock, and this is
 * money: correct TND round-tripping and a ledger that literally cannot store an
 * unbalanced transaction are P0 acceptance criteria (docs/01-mvp-scope.md §7.1, §9).
 */
describe("finance", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let currency: CurrencyService;
  let ledger: LedgerService;
  let createdTenants: string[] = [];

  const driverAccount = (driverId: string): AccountRef => ({
    ownerType: "DRIVER",
    ownerId: driverId,
    accountType: "DRIVER_CASH",
  });
  const merchantAccount = (merchantId: string): AccountRef => ({
    ownerType: "MERCHANT",
    ownerId: merchantId,
    accountType: "MERCHANT_PAYABLE",
  });

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  function codCollectedEvent(
    tenantId: string,
    fields: { driverId?: string; merchantId?: string; amountMinor?: string; currency?: string },
  ): ConsumedEvent {
    return {
      streamId: "0-1",
      seq: 1n,
      eventId: randomUUID(),
      tenantId,
      eventType: "cod.collected",
      eventVersion: 1,
      aggregateType: "shipment",
      aggregateId: randomUUID(),
      occurredAt: new Date(),
      correlationId: null,
      causationId: null,
      deliveryCount: 1,
      traceparent: null,
      tracestate: null,
      payload: {
        shipmentId: randomUUID(),
        ...(fields.driverId === undefined ? {} : { driverId: fields.driverId }),
        ...(fields.merchantId === undefined ? {} : { merchantId: fields.merchantId }),
        amountMinor: fields.amountMinor ?? "12500",
        currency: fields.currency ?? "TND",
      },
    };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    currency = new CurrencyService(db);
    ledger = new LedgerService(db);
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    await database.close();
  });

  // ── Currency / minor units (the TND trap) ──────────────────────────────────
  describe("money minor units (pure)", () => {
    it("round-trips TND (exponent 3) losslessly", () => {
      expect(formatMinorUnits(12500n, 3)).toBe("12.500");
      expect(parseMinorUnits("12.500", 3)).toBe(12500n);
      // 0.500 TND is 500 millimes, NOT 50 — the ×100 trap.
      expect(parseMinorUnits("0.5", 3)).toBe(500n);
      expect(formatMinorUnits(500n, 3)).toBe("0.500");
    });

    it("handles two-decimal currencies and negatives", () => {
      expect(formatMinorUnits(12500n, 2)).toBe("125.00");
      expect(parseMinorUnits("125", 2)).toBe(12500n);
      expect(formatMinorUnits(-500n, 3)).toBe("-0.500");
    });

    it("rejects more fractional digits than the currency allows", () => {
      expect(() => parseMinorUnits("1.2345", 3)).toThrow();
      expect(() => parseMinorUnits("not-money", 2)).toThrow();
    });
  });

  describe("CurrencyService", () => {
    it("reads the ISO 4217 exponent from the seeded currencies table", async () => {
      expect(await currency.exponentOf("TND")).toBe(3);
      expect(await currency.exponentOf("EUR")).toBe(2);
    });

    it("round-trips through the currency's real exponent", async () => {
      expect(await currency.toDecimal(12500n, "TND")).toBe("12.500");
      expect(await currency.toMinor("12.5", "TND")).toBe(12500n);
    });

    it("rejects an unknown currency", async () => {
      await expect(currency.exponentOf("XYZ")).rejects.toThrow();
    });
  });

  // ── The ledger ──────────────────────────────────────────────────────────────
  describe("LedgerService", () => {
    it("posts a balanced COD transaction and moves both cached balances", async () => {
      const tenantId = await seedTenant("ledger-post");
      const driverId = randomUUID();
      const merchantId = randomUUID();

      await db.withTenant(async (tx) => {
        await ledger.postTransaction(tx, {
          tenantId,
          entryType: "COD_COLLECTED",
          currency: "TND",
          lines: [
            { account: driverAccount(driverId), direction: "DEBIT", amountMinor: 12500n },
            { account: merchantAccount(merchantId), direction: "CREDIT", amountMinor: 12500n },
          ],
        });
      }, asTenantId(tenantId));

      await db.withTenant(async (tx) => {
        // DRIVER_CASH normal balance is DEBIT → a debit increases it.
        expect(await ledger.balanceOf(tx, tenantId, "TND", driverAccount(driverId))).toBe(12500n);
        // MERCHANT_PAYABLE normal balance is CREDIT → a credit increases it.
        expect(await ledger.balanceOf(tx, tenantId, "TND", merchantAccount(merchantId))).toBe(
          12500n,
        );
      }, asTenantId(tenantId));
    });

    it("rejects an unbalanced transaction in application code", async () => {
      const tenantId = await seedTenant("ledger-unbalanced");
      await expect(
        db.withTenant(
          (tx) =>
            ledger.postTransaction(tx, {
              tenantId,
              entryType: "COD_COLLECTED",
              currency: "TND",
              lines: [
                { account: driverAccount(randomUUID()), direction: "DEBIT", amountMinor: 12500n },
                {
                  account: merchantAccount(randomUUID()),
                  direction: "CREDIT",
                  amountMinor: 12000n,
                },
              ],
            }),
          asTenantId(tenantId),
        ),
      ).rejects.toThrow(/balanced/i);
    });

    it("rejects a non-positive amount", async () => {
      const tenantId = await seedTenant("ledger-nonpos");
      await expect(
        db.withTenant(
          (tx) =>
            ledger.postTransaction(tx, {
              tenantId,
              entryType: "ADJUSTMENT",
              currency: "TND",
              lines: [
                { account: driverAccount(randomUUID()), direction: "DEBIT", amountMinor: 0n },
                { account: merchantAccount(randomUUID()), direction: "CREDIT", amountMinor: 0n },
              ],
            }),
          asTenantId(tenantId),
        ),
      ).rejects.toThrow(/positive/i);
    });

    it("the database itself refuses a one-sided (unbalanced) transaction", async () => {
      const tenantId = await seedTenant("ledger-db-guard");
      const driverId = randomUUID();
      // Create a real account via a valid post first.
      await db.withTenant(
        (tx) =>
          ledger.postTransaction(tx, {
            tenantId,
            entryType: "COD_COLLECTED",
            currency: "TND",
            lines: [
              { account: driverAccount(driverId), direction: "DEBIT", amountMinor: 1000n },
              { account: merchantAccount(randomUUID()), direction: "CREDIT", amountMinor: 1000n },
            ],
          }),
        asTenantId(tenantId),
      );

      const accountId = await db.withTenant(async (tx) => {
        const rows = await tx
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.ownerId, driverId)))
          .limit(1);
        return rows[0]?.id;
      }, asTenantId(tenantId));
      expect(accountId).toBeDefined();

      // A lone entry (no matching credit) must fail — the deferred trigger fires
      // at COMMIT, so the whole transaction rolls back.
      await expect(
        db.withTenant(async (tx) => {
          await tx.insert(ledgerEntries).values({
            tenantId,
            transactionId: randomUUID(),
            accountId: accountId ?? randomUUID(),
            direction: "DEBIT",
            amountMinor: 999n,
            currency: "TND",
            entryType: "ADJUSTMENT",
          });
        }, asTenantId(tenantId)),
      ).rejects.toThrow();
    });

    it("is append-only: the app role cannot UPDATE or DELETE entries", async () => {
      const tenantId = await seedTenant("ledger-append-only");
      await db.withTenant(
        (tx) =>
          ledger.postTransaction(tx, {
            tenantId,
            entryType: "COD_COLLECTED",
            currency: "TND",
            lines: [
              { account: driverAccount(randomUUID()), direction: "DEBIT", amountMinor: 100n },
              { account: merchantAccount(randomUUID()), direction: "CREDIT", amountMinor: 100n },
            ],
          }),
        asTenantId(tenantId),
      );

      // Use the raw dp_app client: the REVOKE fires before RLS, so no tenant
      // context is needed, and postgres.js surfaces "permission denied" directly
      // (drizzle's tx.execute would wrap it as "Failed query", hiding the cause).
      await expect(database.app`update ledger_entries set amount_minor = 1`).rejects.toThrow(
        /permission denied/i,
      );
      await expect(database.app`delete from ledger_entries`).rejects.toThrow(/permission denied/i);
    });
  });

  // ── The consumer that closes the loop ────────────────────────────────────────
  describe("LedgerEventHandler (cod.collected)", () => {
    it("posts DEBIT driver_cash / CREDIT merchant_payable from the event", async () => {
      const tenantId = await seedTenant("ledger-consume");
      const driverId = randomUUID();
      const merchantId = randomUUID();
      const handler = new LedgerEventHandler(db, ledger);

      await handler.handle(
        codCollectedEvent(tenantId, {
          driverId,
          merchantId,
          amountMinor: "12500",
          currency: "TND",
        }),
      );

      await db.withTenant(async (tx) => {
        expect(await ledger.balanceOf(tx, tenantId, "TND", driverAccount(driverId))).toBe(12500n);
        expect(await ledger.balanceOf(tx, tenantId, "TND", merchantAccount(merchantId))).toBe(
          12500n,
        );
      }, asTenantId(tenantId));
    });

    it("is idempotent: a redelivered event does not double-post", async () => {
      const tenantId = await seedTenant("ledger-idem");
      const driverId = randomUUID();
      const merchantId = randomUUID();
      const handler = new LedgerEventHandler(db, ledger);
      const event = codCollectedEvent(tenantId, {
        driverId,
        merchantId,
        amountMinor: "5000",
        currency: "TND",
      });

      await handler.handle(event);
      await handler.handle(event); // redelivery

      const balance = await db.withTenant(
        (tx) => ledger.balanceOf(tx, tenantId, "TND", driverAccount(driverId)),
        asTenantId(tenantId),
      );
      expect(balance).toBe(5000n); // posted once, not 10000

      const txnCount = await db.withTenant(async (tx) => {
        const rows = await tx
          .select({ n: sql<string>`count(distinct ${ledgerEntries.transactionId})::text` })
          .from(ledgerEntries)
          .where(eq(ledgerEntries.tenantId, tenantId));
        return Number(rows[0]?.n ?? "0");
      }, asTenantId(tenantId));
      expect(txnCount).toBe(1);
    });

    it("credits a tenant-level payable when the shipment has no merchant", async () => {
      const tenantId = await seedTenant("ledger-nomerchant");
      const driverId = randomUUID();
      const handler = new LedgerEventHandler(db, ledger);

      await handler.handle(codCollectedEvent(tenantId, { driverId, amountMinor: "3000" }));

      await db.withTenant(async (tx) => {
        expect(await ledger.balanceOf(tx, tenantId, "TND", driverAccount(driverId))).toBe(3000n);
        expect(
          await ledger.balanceOf(tx, tenantId, "TND", {
            ownerType: "TENANT",
            ownerId: tenantId,
            accountType: "MERCHANT_PAYABLE",
          }),
        ).toBe(3000n);
      }, asTenantId(tenantId));
    });

    it("throws on a malformed money event so it retries and dead-letters", async () => {
      const tenantId = await seedTenant("ledger-malformed");
      const handler = new LedgerEventHandler(db, ledger);
      // No driverId → cannot post → must fail loudly, never silently drop cash.
      await expect(
        handler.handle(codCollectedEvent(tenantId, { amountMinor: "1000" })),
      ).rejects.toThrow();
    });
  });
});
