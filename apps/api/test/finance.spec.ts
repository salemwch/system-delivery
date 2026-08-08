import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CurrencyService } from "../src/shared/money/index.js";
import { LedgerService } from "../src/modules/finance/application/ledger.service.js";
import type { AccountRef } from "../src/modules/finance/application/ledger.service.js";
import { LedgerEventHandler } from "../src/modules/finance/application/ledger-event.handler.js";
import { RemittanceService } from "../src/modules/finance/application/remittance.service.js";
import { SettlementService } from "../src/modules/finance/application/settlement.service.js";
import { PaymentNoteService } from "../src/modules/finance/application/payment-note.service.js";
import { ReconciliationService } from "../src/modules/finance/application/reconciliation.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { TenantService } from "../src/modules/platform/application/tenant.service.js";
import { ledgerAccounts, ledgerEntries } from "../src/modules/finance/domain/schema.js";
import { formatMinorUnits, parseMinorUnits } from "../src/shared/money/index.js";
import { OutboxService } from "../src/modules/platform/index.js";
import type { ConsumedEvent } from "../src/modules/platform/index.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
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

    /**
     * Currencies are immutable global reference data, so the exponent map is read
     * once per process. This asserts the COALESCING, which is the part that only
     * matters under load: a cold process serving a burst would otherwise issue one
     * identical reference-data query per concurrent caller.
     *
     * A fresh instance, because the shared one is already warm.
     */
    it("issues ONE query for concurrent first-callers, not one each", async () => {
      let queries = 0;
      const counting = new CurrencyService({
        withoutTenantScope: async (fn: Parameters<typeof db.withoutTenantScope>[0]) => {
          queries += 1;
          return db.withoutTenantScope(fn);
        },
      } as never);

      const exponents = await Promise.all(
        Array.from({ length: 25 }, () => counting.exponentOf("TND")),
      );

      expect(exponents.every((e) => e === 3)).toBe(true);
      expect(queries).toBe(1);

      // And still cached afterwards — the in-flight promise is cleared on settle,
      // which must not discard the result it just loaded.
      await counting.exponentOf("EUR");
      expect(queries).toBe(1);
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

  // ── Remittance (increment 2): the driver → hub cash handoff ──────────────────
  describe("RemittanceService", () => {
    const ctx = { actorUserId: randomUUID() };

    function service(): RemittanceService {
      return new RemittanceService(db, ledger, currency, new OutboxService());
    }

    async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
      return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
    }

    /** Give a driver a DRIVER_CASH balance by posting a COD collection. */
    async function collect(tenantId: string, driverId: string, amount: bigint): Promise<void> {
      await db.withTenant(
        (tx) =>
          ledger.postTransaction(tx, {
            tenantId,
            entryType: "COD_COLLECTED",
            currency: "TND",
            lines: [
              { account: driverAccount(driverId), direction: "DEBIT", amountMinor: amount },
              { account: merchantAccount(randomUUID()), direction: "CREDIT", amountMinor: amount },
            ],
          }),
        asTenantId(tenantId),
      );
    }

    async function varianceEventCount(tenantId: string): Promise<number> {
      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) =>
          tx<{ n: string }[]>`select count(*)::text as n from outbox
           where tenant_id = ${tenantId} and event_type = 'cod.variance_detected'`,
      );
      return Number(rows[0]?.n ?? "0");
    }

    it("submits with the system-computed expected amount from the ledger", async () => {
      const tenantId = await seedTenant("rem-submit");
      const driverId = randomUUID();
      await collect(tenantId, driverId, 30000n);

      const remittance = await asTenant(tenantId, () =>
        service().submit(
          { driverId, hubId: randomUUID(), declaredAmountMinor: "30000", currency: "TND" },
          ctx,
        ),
      );

      expect(remittance.status).toBe("SUBMITTED");
      expect(remittance.expectedAmountMinor).toBe(30000n); // read from the ledger, not the input
      expect(remittance.declaredAmountMinor).toBe(30000n);
      expect(remittance.code).toMatch(/^RM-\d{8}-[0-9A-F]{6}$/);
    });

    it("confirms an exact remittance: DEBIT hub_cash / CREDIT driver_cash, zero variance", async () => {
      const tenantId = await seedTenant("rem-exact");
      const driverId = randomUUID();
      const hubId = randomUUID();
      await collect(tenantId, driverId, 30000n);
      const svc = service();

      const submitted = await asTenant(tenantId, () =>
        svc.submit({ driverId, hubId, declaredAmountMinor: "30000", currency: "TND" }, ctx),
      );
      const confirmed = await asTenant(tenantId, () =>
        svc.confirm(submitted.id, { countedAmountMinor: "30000" }, ctx),
      );

      expect(confirmed.status).toBe("CONFIRMED");
      expect(confirmed.varianceMinor).toBe(0n);

      await db.withTenant(async (tx) => {
        // Driver handed over everything → their cash is now zero, the hub holds it.
        expect(await ledger.balanceOf(tx, tenantId, "TND", driverAccount(driverId))).toBe(0n);
        expect(
          await ledger.balanceOf(tx, tenantId, "TND", {
            ownerType: "HUB",
            ownerId: hubId,
            accountType: "HUB_CASH",
          }),
        ).toBe(30000n);
      }, asTenantId(tenantId));
      expect(await varianceEventCount(tenantId)).toBe(0);
    });

    it("rejects a variance with no reason, and records one with a reason", async () => {
      const tenantId = await seedTenant("rem-variance");
      const driverId = randomUUID();
      const hubId = randomUUID();
      await collect(tenantId, driverId, 30000n);
      const svc = service();

      const submitted = await asTenant(tenantId, () =>
        svc.submit({ driverId, hubId, declaredAmountMinor: "30000", currency: "TND" }, ctx),
      );

      // Short by 0.500 TND (500 millimes) with no explanation → refused.
      await expect(
        asTenant(tenantId, () => svc.confirm(submitted.id, { countedAmountMinor: "29500" }, ctx)),
      ).rejects.toThrow(/reason/i);

      const confirmed = await asTenant(tenantId, () =>
        svc.confirm(
          submitted.id,
          { countedAmountMinor: "29500", varianceReason: "short by 500 millimes" },
          ctx,
        ),
      );
      expect(confirmed.status).toBe("CONFIRMED");
      expect(confirmed.varianceMinor).toBe(-500n); // counted − expected, SHORTAGE

      await db.withTenant(async (tx) => {
        // The 500-millime shortfall stays as the driver's open cash balance.
        expect(await ledger.balanceOf(tx, tenantId, "TND", driverAccount(driverId))).toBe(500n);
        expect(
          await ledger.balanceOf(tx, tenantId, "TND", {
            ownerType: "HUB",
            ownerId: hubId,
            accountType: "HUB_CASH",
          }),
        ).toBe(29500n);
      }, asTenantId(tenantId));
      expect(await varianceEventCount(tenantId)).toBe(1);
    });

    it("cannot confirm the same remittance twice", async () => {
      const tenantId = await seedTenant("rem-double");
      const driverId = randomUUID();
      await collect(tenantId, driverId, 10000n);
      const svc = service();
      const submitted = await asTenant(tenantId, () =>
        svc.submit(
          { driverId, hubId: randomUUID(), declaredAmountMinor: "10000", currency: "TND" },
          ctx,
        ),
      );
      await asTenant(tenantId, () =>
        svc.confirm(submitted.id, { countedAmountMinor: "10000" }, ctx),
      );

      await expect(
        asTenant(tenantId, () => svc.confirm(submitted.id, { countedAmountMinor: "10000" }, ctx)),
      ).rejects.toThrow(/SUBMITTED|confirm/i);
    });

    it("disputes then resolves", async () => {
      const tenantId = await seedTenant("rem-dispute");
      const driverId = randomUUID();
      await collect(tenantId, driverId, 8000n);
      const svc = service();
      const submitted = await asTenant(tenantId, () =>
        svc.submit(
          { driverId, hubId: randomUUID(), declaredAmountMinor: "8000", currency: "TND" },
          ctx,
        ),
      );

      const disputed = await asTenant(tenantId, () =>
        svc.dispute(submitted.id, { reason: "counts do not match" }, ctx),
      );
      expect(disputed.status).toBe("DISPUTED");

      const resolved = await asTenant(tenantId, () => svc.resolve(submitted.id, ctx));
      expect(resolved.status).toBe("RESOLVED");
    });
  });

  // ── Settlement (increment 3): merchant payout ────────────────────────────────
  describe("SettlementService", () => {
    const drafter = { actorUserId: randomUUID(), role: "FINANCE" };
    const approver = { actorUserId: randomUUID(), role: "OWNER" };

    function service(): SettlementService {
      return new SettlementService(db, ledger, currency, new OutboxService());
    }
    async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
      return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
    }
    const today = (): string => new Date().toISOString().slice(0, 10);

    /** Post a COD collection for a merchant so it accrues to MERCHANT_PAYABLE. */
    async function collectForMerchant(
      tenantId: string,
      merchantId: string,
      amount: bigint,
    ): Promise<void> {
      const handler = new LedgerEventHandler(db, ledger);
      await handler.handle(
        codCollectedEvent(tenantId, {
          driverId: randomUUID(),
          merchantId,
          amountMinor: amount.toString(),
          currency: "TND",
        }),
      );
    }

    it("drafts from the merchant's collected COD in the period", async () => {
      const tenantId = await seedTenant("settle-draft");
      const merchantId = randomUUID();
      await collectForMerchant(tenantId, merchantId, 10000n);
      await collectForMerchant(tenantId, merchantId, 5000n);

      const draft = await asTenant(tenantId, () =>
        service().createDraft(
          {
            merchantId,
            periodFrom: today(),
            periodTo: today(),
            currency: "TND",
            deliveryFeesMinor: "1500",
          },
          drafter,
        ),
      );

      expect(draft.status).toBe("DRAFT");
      expect(draft.grossCodAmountMinor).toBe(15000n);
      expect(draft.deliveryFeesMinor).toBe(1500n);
      expect(draft.netPayableMinor).toBe(13500n);
      expect(draft.shipmentCount).toBe(2);
    });

    it("enforces separation of duties: the drafter cannot approve, and only FINANCE/OWNER can", async () => {
      const tenantId = await seedTenant("settle-sod");
      const merchantId = randomUUID();
      await collectForMerchant(tenantId, merchantId, 9000n);
      const svc = service();
      const draft = await asTenant(tenantId, () =>
        svc.createDraft(
          { merchantId, periodFrom: today(), periodTo: today(), currency: "TND" },
          drafter,
        ),
      );

      // Same user who drafted it → refused.
      await expect(asTenant(tenantId, () => svc.approve(draft.id, drafter))).rejects.toThrow(
        /separation of duties|drafted/i,
      );
      // A dispatcher (wrong role) → refused.
      await expect(
        asTenant(tenantId, () =>
          svc.approve(draft.id, { actorUserId: randomUUID(), role: "DISPATCHER" }),
        ),
      ).rejects.toThrow(/FINANCE|OWNER/i);

      const approved = await asTenant(tenantId, () => svc.approve(draft.id, approver));
      expect(approved.status).toBe("APPROVED");
      expect(approved.approvedByUserId).toBe(approver.actorUserId);
    });

    it("posts the ledger on payment: merchant_payable cleared, bank out, fees to revenue", async () => {
      const tenantId = await seedTenant("settle-paid");
      const merchantId = randomUUID();
      await collectForMerchant(tenantId, merchantId, 15000n);
      const svc = service();
      const draft = await asTenant(tenantId, () =>
        svc.createDraft(
          {
            merchantId,
            periodFrom: today(),
            periodTo: today(),
            currency: "TND",
            deliveryFeesMinor: "1500",
          },
          drafter,
        ),
      );
      await asTenant(tenantId, () => svc.approve(draft.id, approver));
      const paid = await asTenant(tenantId, () =>
        svc.markPaid(
          draft.id,
          { paymentMethod: "BANK_TRANSFER", paymentReference: "TX-1" },
          approver,
        ),
      );
      expect(paid.status).toBe("PAID");

      await db.withTenant(async (tx) => {
        // The full payable is cleared.
        expect(
          await ledger.balanceOf(tx, tenantId, "TND", {
            ownerType: "MERCHANT",
            ownerId: merchantId,
            accountType: "MERCHANT_PAYABLE",
          }),
        ).toBe(0n);
        // Bank paid out the net (a credit to a debit-normal asset → negative from 0).
        expect(
          await ledger.balanceOf(tx, tenantId, "TND", {
            ownerType: "TENANT",
            ownerId: tenantId,
            accountType: "BANK",
          }),
        ).toBe(-13500n);
        // The delivery fee is recognised as platform revenue.
        expect(
          await ledger.balanceOf(tx, tenantId, "TND", {
            ownerType: "TENANT",
            ownerId: tenantId,
            accountType: "PLATFORM_REVENUE",
          }),
        ).toBe(1500n);
      }, asTenantId(tenantId));
    });

    it("never settles a shipment twice, and cancel frees them again", async () => {
      const tenantId = await seedTenant("settle-once");
      const merchantId = randomUUID();
      await collectForMerchant(tenantId, merchantId, 4000n);
      const svc = service();
      const period = { periodFrom: today(), periodTo: today(), currency: "TND" as const };

      const first = await asTenant(tenantId, () =>
        svc.createDraft({ merchantId, ...period }, drafter),
      );
      expect(first.shipmentCount).toBe(1);

      // The shipment is now spoken for → a second draft finds nothing.
      await expect(
        asTenant(tenantId, () => svc.createDraft({ merchantId, ...period }, drafter)),
      ).rejects.toThrow(/unsettled|nothing to settle/i);

      // Cancelling frees it for a fresh draft.
      await asTenant(tenantId, () => svc.cancel(first.id, drafter));
      const redraft = await asTenant(tenantId, () =>
        svc.createDraft({ merchantId, ...period }, drafter),
      );
      expect(redraft.grossCodAmountMinor).toBe(4000n);
    });
  });

  // ── Reconciliation reads (increment 3) ───────────────────────────────────────
  describe("ReconciliationService", () => {
    async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
      return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
    }
    const today = (): string => new Date().toISOString().slice(0, 10);

    it("cash-in-field sums the drivers' current cash", async () => {
      const tenantId = await seedTenant("recon-cif");
      const handler = new LedgerEventHandler(db, ledger);
      const driverA = randomUUID();
      const driverB = randomUUID();
      await handler.handle(
        codCollectedEvent(tenantId, {
          driverId: driverA,
          merchantId: randomUUID(),
          amountMinor: "10000",
        }),
      );
      await handler.handle(
        codCollectedEvent(tenantId, {
          driverId: driverB,
          merchantId: randomUUID(),
          amountMinor: "5000",
        }),
      );

      const recon = new ReconciliationService(db);
      const cif = await asTenant(tenantId, () => recon.cashInField("TND"));
      expect(cif.totalMinor).toBe(15000n);
      expect(cif.drivers).toHaveLength(2);
    });

    it("reports the day's collected / remitted / variance", async () => {
      const tenantId = await seedTenant("recon-daily");
      const handler = new LedgerEventHandler(db, ledger);
      const driverId = randomUUID();
      await handler.handle(
        codCollectedEvent(tenantId, { driverId, merchantId: randomUUID(), amountMinor: "20000" }),
      );

      const remit = new RemittanceService(db, ledger, currency, new OutboxService());
      const submitted = await asTenant(tenantId, () =>
        remit.submit(
          { driverId, hubId: randomUUID(), declaredAmountMinor: "20000", currency: "TND" },
          { actorUserId: randomUUID() },
        ),
      );
      await asTenant(tenantId, () =>
        remit.confirm(submitted.id, { countedAmountMinor: "20000" }, { actorUserId: randomUUID() }),
      );

      const recon = new ReconciliationService(db);
      const day = await asTenant(tenantId, () => recon.dailyReconciliation(today(), "TND"));
      expect(day.collectedMinor).toBe(20000n);
      expect(day.remittedMinor).toBe(20000n);
      expect(day.varianceMinor).toBe(0n);
      expect(day.outstandingMinor).toBe(0n);
    });
  });

  // ── Payment note (increment H): the receipt a merchant signs for their money ──
  describe("PaymentNoteService", () => {
    const drafter = { actorUserId: randomUUID(), role: "FINANCE" };
    const approver = { actorUserId: randomUUID(), role: "OWNER" };

    function service(): PaymentNoteService {
      return new PaymentNoteService(
        db,
        new TenantService(
          db,
          new OutboxService(),
          new OperatingConfigService(db),
          new AuditService(db),
        ),
        currency,
      );
    }
    async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
      return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
    }
    const today = (): string => new Date().toISOString().slice(0, 10);

    /**
     * A real merchant row.
     *
     * ⚠️ The settlement suite above invents a UUID, which is fine there because
     * `settlements.merchant_id` carries no key. The receipt PRINTS the merchant's
     * name, so it must resolve a row that exists — and reading that name is the
     * exact code path this suite is here to cover.
     */
    async function seedMerchant(tenantId: string, name: string): Promise<string> {
      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ id: string }[]>`
          insert into merchants (tenant_id, name, status)
          values (${tenantId}, ${name}, 'ACTIVE')
          returning id
        `,
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error("merchant seed failed");
      }
      return row.id;
    }

    async function approvedSettlement(
      tenantId: string,
      merchantId: string,
    ): Promise<{ id: string; code: string }> {
      const handler = new LedgerEventHandler(db, ledger);
      await handler.handle(
        codCollectedEvent(tenantId, {
          driverId: randomUUID(),
          merchantId,
          amountMinor: "30000",
          currency: "TND",
        }),
      );
      const settlements = new SettlementService(db, ledger, currency, new OutboxService());
      const draft = await asTenant(tenantId, () =>
        settlements.createDraft(
          {
            merchantId,
            periodFrom: today(),
            periodTo: today(),
            currency: "TND",
            deliveryFeesMinor: "2500",
          },
          drafter,
        ),
      );
      const approved = await asTenant(tenantId, () => settlements.approve(draft.id, approver));
      return { id: approved.id, code: approved.code };
    }

    it("prints the merchant name, the arithmetic and the awaiting-payment mark", async () => {
      const tenantId = await seedTenant("note-approved");
      const merchantId = await seedMerchant(tenantId, "Boutique El Manar");
      const settlement = await approvedSettlement(tenantId, merchantId);

      const rendered = await asTenant(tenantId, () => service().render(settlement.id));

      expect(rendered.filename).toBe(`bon-de-paiement-${settlement.code}.html`);
      expect(rendered.html).toContain("Boutique El Manar");
      // The arithmetic, line by line: gross 30.000 − fees 2.500 = net 27.500.
      // ⚠️ 30000 minor units is THIRTY dinars, not three hundred: TND carries
      // three decimals, so this also proves the exponent came from `currencies`
      // and not from a hardcoded ×100.
      expect(rendered.html).toContain("30.000");
      expect(rendered.html).toContain("2.500");
      expect(rendered.html).toContain("27.500");
    });

    it("refuses a DRAFT settlement, whose figures can still change", async () => {
      const tenantId = await seedTenant("note-draft");
      const merchantId = await seedMerchant(tenantId, "Draft Merchant");
      const handler = new LedgerEventHandler(db, ledger);
      await handler.handle(
        codCollectedEvent(tenantId, {
          driverId: randomUUID(),
          merchantId,
          amountMinor: "10000",
          currency: "TND",
        }),
      );
      const settlements = new SettlementService(db, ledger, currency, new OutboxService());
      const draft = await asTenant(tenantId, () =>
        settlements.createDraft(
          { merchantId, periodFrom: today(), periodTo: today(), currency: "TND" },
          drafter,
        ),
      );

      // A signed receipt for a number that later changes is worse than none.
      await expect(asTenant(tenantId, () => service().render(draft.id))).rejects.toThrow(
        /not found/iu,
      );
    });

    it("does not render another tenant's settlement", async () => {
      const tenantA = await seedTenant("note-tenant-a");
      const tenantB = await seedTenant("note-tenant-b");
      const merchantId = await seedMerchant(tenantA, "A Merchant");
      const settlement = await approvedSettlement(tenantA, merchantId);

      // RLS, not a WHERE clause the caller could forget.
      await expect(asTenant(tenantB, () => service().render(settlement.id))).rejects.toThrow(
        /not found/iu,
      );
    });

    it("refuses a settlement whose merchant row is gone rather than printing a blank payee", async () => {
      const tenantId = await seedTenant("note-no-merchant");
      const merchantId = await seedMerchant(tenantId, "Vanishing Merchant");
      const settlement = await approvedSettlement(tenantId, merchantId);
      await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx`delete from merchants where id = ${merchantId}`,
      );

      // A receipt with an empty payee is a document nobody can act on, and the
      // name lookup is `?.name` — without the explicit guard it would render one.
      await expect(asTenant(tenantId, () => service().render(settlement.id))).rejects.toThrow(
        /not found/iu,
      );
    });
  });
});
