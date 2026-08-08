import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ExpenseService } from "../src/modules/finance/application/expense.service.js";
import { LedgerService } from "../src/modules/finance/application/ledger.service.js";
import { AuditService } from "../src/modules/platform/index.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Les dépenses — what the courier spends.
 *
 * ⚠️ THE TEST THAT JUSTIFIES THE WHOLE FEATURE is the one asserting that cash
 * paid out of a hub's box REDUCES that box's balance. That figure is what
 * `cashInField` reconciles against, so an untracked fuel payment reads as a hub
 * being short — and the manager is asked where the money went when the answer is
 * "into the tank of the van outside".
 *
 * Amounts are TND millimes: 45_000 is 45.000 TND.
 */
describe("expenses", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let expenses: ExpenseService;
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
        values (${tenantId}, ${email}, 'hash', 'Comptable', 'ACTIVE')
        returning id`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed user");
    return row.id;
  }

  /** A hub with its address — `hubs.address_id` is NOT NULL. */
  async function seedHub(tenantId: string): Promise<string> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        with a as (
          insert into addresses (tenant_id, raw_input, country_code, location)
          values (${tenantId}, 'Zone industrielle, Tunis', 'TN',
                  ST_SetSRID(ST_MakePoint(10.18, 36.80), 4326)::geography)
          returning id
        )
        insert into hubs (tenant_id, code, name, type, address_id, location, timezone)
        select ${tenantId}, ${`H-${Math.random().toString(36).slice(2, 8)}`}, 'Hub Tunis',
               'SORTING_CENTER', a.id,
               ST_SetSRID(ST_MakePoint(10.18, 36.80), 4326)::geography, 'Africa/Tunis'
          from a
        returning id`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed hub");
    return row.id;
  }

  /** The cached balance of one account type, or null when it does not exist. */
  async function balanceOf(
    tenantId: string,
    accountType: string,
    ownerId: string,
  ): Promise<bigint | null> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ balance_minor: string }[]>`
        select balance_minor from ledger_accounts
         where tenant_id = ${tenantId} and account_type = ${accountType}
           and owner_id = ${ownerId}`,
    );
    const row = rows[0];
    return row === undefined ? null : BigInt(row.balance_minor);
  }

  async function seedCategory(tenantId: string, code = "FUEL"): Promise<string> {
    const category = await asStaff(tenantId, () =>
      expenses.createCategory({ code, name: "Carburant" }),
    );
    return category.id;
  }

  function expenseInput(overrides: Record<string, unknown> = {}) {
    return {
      amountMinor: 45_000,
      currency: "TND",
      spentOn: "2026-08-03",
      description: "Plein de gasoil",
      paidFrom: "BANK",
      ...overrides,
    };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    expenses = new ExpenseService(db, new LedgerService(db), new AuditService(db));
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    await database.close();
  });

  // ── Categories ─────────────────────────────────────────────────────────────
  describe("categories", () => {
    it("refuses a duplicate code", async () => {
      const tenantId = await seedTenant("exp-cat");
      await asStaff(tenantId, () => expenses.createCategory({ code: "FUEL", name: "Carburant" }));

      await expect(
        asStaff(tenantId, () => expenses.createCategory({ code: "FUEL", name: "Autre" })),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("upper-cases the code so FUEL and fuel are one category", async () => {
      const tenantId = await seedTenant("exp-cat-case");
      const category = await asStaff(tenantId, () =>
        expenses.createCategory({ code: "fuel", name: "Carburant" }),
      );
      expect(category.code).toBe("FUEL");
    });

    it("retires rather than deletes — past expenses reference it", async () => {
      const tenantId = await seedTenant("exp-cat-retire");
      const id = await seedCategory(tenantId);

      await asStaff(tenantId, () => expenses.updateCategory(id, { active: false }));

      expect(await asStaff(tenantId, () => expenses.listCategories(true))).toHaveLength(0);
      expect(await asStaff(tenantId, () => expenses.listCategories(false))).toHaveLength(1);
    });
  });

  // ── Recording ──────────────────────────────────────────────────────────────
  describe("create", () => {
    let tenantId: string;
    let userId: string;
    let categoryId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("exp-create");
      userId = await seedUser(tenantId);
      categoryId = await seedCategory(tenantId);
    });

    it("records a DRAFT that has not touched the ledger", async () => {
      const expense = await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId }), userId),
      );

      expect(expense.status).toBe("DRAFT");
      expect(expense.amountMinor).toBe(45_000n);
      expect(expense.reference).toMatch(/^DEP-\d{4}-\d{5}$/u);
      // `expenses_decision_chk` enforces the empty decision.
      expect(expense.transactionId).toBeNull();
      expect(expense.approvedAt).toBeNull();
    });

    it("numbers references sequentially", async () => {
      const first = await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId }), userId),
      );
      const second = await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId }), userId),
      );
      const year = new Date().getUTCFullYear();
      expect(first.reference).toBe(`DEP-${String(year)}-00001`);
      expect(second.reference).toBe(`DEP-${String(year)}-00002`);
    });

    it("⚠️ refuses the same supplier invoice twice", async () => {
      await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId, supplierReference: "FACT-9912" }), userId),
      );

      // Two people both entering the fuel bill is the commonest error in expense
      // bookkeeping, and it overstates the month.
      await expect(
        asStaff(tenantId, () =>
          expenses.create(expenseInput({ categoryId, supplierReference: "FACT-9912" }), userId),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("lets a REJECTED duplicate be re-entered correctly", async () => {
      const first = await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId, supplierReference: "FACT-9912" }), userId),
      );
      await asStaff(tenantId, () => expenses.reject(first.id, { reason: "montant faux" }, userId));

      // The partial index excludes REJECTED so the corrected entry is possible.
      const corrected = await asStaff(tenantId, () =>
        expenses.create(
          expenseInput({ categoryId, supplierReference: "FACT-9912", amountMinor: 52_000 }),
          userId,
        ),
      );
      expect(corrected.amountMinor).toBe(52_000n);
    });

    it("requires a hub when the money came out of a cash box", async () => {
      await expect(
        asStaff(tenantId, () =>
          expenses.create(expenseInput({ categoryId, paidFrom: "HUB_CASH" }), userId),
        ),
      ).rejects.toThrow();
    });

    it("refuses a hub on a bank payment — a transfer leaves no box", async () => {
      const hubId = await seedHub(tenantId);
      await expect(
        asStaff(tenantId, () =>
          expenses.create(
            expenseInput({ categoryId, paidFrom: "BANK", paidFromHubId: hubId }),
            userId,
          ),
        ),
      ).rejects.toThrow();
    });
  });

  // ── Approval: the ledger posting ───────────────────────────────────────────
  describe("approve", () => {
    let tenantId: string;
    let userId: string;
    let categoryId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("exp-approve");
      userId = await seedUser(tenantId);
      categoryId = await seedCategory(tenantId);
    });

    it("⚠️ CASH FROM A HUB BOX REDUCES WHAT THAT BOX HOLDS", async () => {
      const hubId = await seedHub(tenantId);
      const expense = await asStaff(tenantId, () =>
        expenses.create(
          expenseInput({ categoryId, paidFrom: "HUB_CASH", paidFromHubId: hubId }),
          userId,
        ),
      );

      await asStaff(tenantId, () => expenses.approve(expense.id, userId));

      // HUB_CASH is a DEBIT-normal account, so a CREDIT reduces it. This is the
      // number `cashInField` reconciles against: without the expense, the hub
      // reads as 45.000 TND short.
      expect(await balanceOf(tenantId, "HUB_CASH", hubId)).toBe(-45_000n);
      // …and the spending rose by exactly as much.
      expect(await balanceOf(tenantId, "EXPENSE", tenantId)).toBe(45_000n);
    });

    it("a bank payment touches no cash box", async () => {
      const hubId = await seedHub(tenantId);
      const expense = await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId, paidFrom: "BANK" }), userId),
      );

      await asStaff(tenantId, () => expenses.approve(expense.id, userId));

      expect(await balanceOf(tenantId, "BANK", tenantId)).toBe(-45_000n);
      expect(await balanceOf(tenantId, "EXPENSE", tenantId)).toBe(45_000n);
      // The hub was never involved, so no account was created for it.
      expect(await balanceOf(tenantId, "HUB_CASH", hubId)).toBeNull();
    });

    it("posts a BALANCED transaction — the zero-sum trigger proves it", async () => {
      const expense = await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId }), userId),
      );
      const approved = await asStaff(tenantId, () => expenses.approve(expense.id, userId));

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ direction: string; amount_minor: string; entry_type: string }[]>`
          select direction, amount_minor, entry_type from ledger_entries
           where transaction_id = ${approved.transactionId}
           order by direction`,
      );

      // Two lines, equal and opposite. The DEFERRABLE trigger would have
      // rejected the whole transaction at COMMIT otherwise.
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.direction)).toEqual(["CREDIT", "DEBIT"]);
      expect(rows.every((r) => r.amount_minor === "45000")).toBe(true);
      expect(rows.every((r) => r.entry_type === "EXPENSE")).toBe(true);
    });

    it("links the transaction back to the expense", async () => {
      const expense = await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId }), userId),
      );
      const approved = await asStaff(tenantId, () => expenses.approve(expense.id, userId));

      expect(approved.status).toBe("APPROVED");
      // `expenses_decision_chk` refuses APPROVED without one: money spent that
      // the accounts never saw.
      expect(approved.transactionId).not.toBeNull();
      expect(approved.approvedByUserId).toBe(userId);
    });

    it("refuses to approve twice — the money would post twice", async () => {
      const expense = await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId }), userId),
      );
      await asStaff(tenantId, () => expenses.approve(expense.id, userId));

      await expect(
        asStaff(tenantId, () => expenses.approve(expense.id, userId)),
      ).rejects.toBeInstanceOf(BusinessRuleError);

      // And the balance moved exactly once.
      expect(await balanceOf(tenantId, "EXPENSE", tenantId)).toBe(45_000n);
    });

    it("records the approval on the audit trail with the transaction id", async () => {
      const expense = await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId }), userId),
      );
      const approved = await asStaff(tenantId, () => expenses.approve(expense.id, userId));

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ action: string; context: Record<string, unknown> }[]>`
          select action, context from audit_log where resource_id = ${expense.id}`,
      );
      expect(rows[0]?.action).toBe("expense.approved");
      expect(rows[0]?.context).toMatchObject({
        transactionId: approved.transactionId,
        amountMinor: "45000",
      });
    });

    it("404s on an unknown expense", async () => {
      await expect(
        asStaff(tenantId, () => expenses.approve(randomUUID(), userId)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── Rejection ──────────────────────────────────────────────────────────────
  describe("reject", () => {
    it("posts nothing to the ledger", async () => {
      const tenantId = await seedTenant("exp-reject");
      const userId = await seedUser(tenantId);
      const categoryId = await seedCategory(tenantId);
      const expense = await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId }), userId),
      );

      const rejected = await asStaff(tenantId, () =>
        expenses.reject(expense.id, { reason: "Pas de justificatif" }, userId),
      );

      expect(rejected.status).toBe("REJECTED");
      expect(rejected.decisionReason).toBe("Pas de justificatif");
      expect(rejected.transactionId).toBeNull();
      expect(await balanceOf(tenantId, "EXPENSE", tenantId)).toBeNull();
    });

    it("requires a reason", async () => {
      const tenantId = await seedTenant("exp-reject2");
      const userId = await seedUser(tenantId);
      const categoryId = await seedCategory(tenantId);
      const expense = await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId }), userId),
      );

      await expect(
        asStaff(tenantId, () => expenses.reject(expense.id, { reason: "  " }, userId)),
      ).rejects.toThrow();
    });
  });

  // ── The report ─────────────────────────────────────────────────────────────
  describe("summary", () => {
    let tenantId: string;
    let userId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("exp-summary");
      userId = await seedUser(tenantId);
      const fuel = await seedCategory(tenantId, "FUEL");
      const rent = await seedCategory(tenantId, "RENT");

      for (const [categoryId, amountMinor, spentOn] of [
        [fuel, 45_000, "2026-08-03"],
        [fuel, 30_000, "2026-08-10"],
        [rent, 900_000, "2026-08-01"],
        // Outside the window the report asks for.
        [fuel, 99_000, "2026-07-15"],
      ] as const) {
        const expense = await asStaff(tenantId, () =>
          expenses.create(expenseInput({ categoryId, amountMinor, spentOn }), userId),
        );
        await asStaff(tenantId, () => expenses.approve(expense.id, userId));
      }
    });

    it("totals APPROVED spend per category within the period", async () => {
      const rows = await asStaff(tenantId, () =>
        expenses.summary({ from: "2026-08-01", to: "2026-08-31" }),
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ categoryCode: "FUEL", totalMinor: 75_000n, count: 2 });
      expect(rows[1]).toMatchObject({ categoryCode: "RENT", totalMinor: 900_000n, count: 1 });
    });

    it("⚠️ EXCLUDES drafts — a claim is not money that left the business", async () => {
      const fuel = (await asStaff(tenantId, () => expenses.listCategories(true)))[0];
      if (fuel === undefined) throw new Error("expected a category");

      await asStaff(tenantId, () =>
        expenses.create(
          expenseInput({ categoryId: fuel.id, amountMinor: 500_000, spentOn: "2026-08-15" }),
          userId,
        ),
      );

      // Including it would make the report disagree with the ledger, which is
      // the one thing a spend report must never do.
      const rows = await asStaff(tenantId, () =>
        expenses.summary({ from: "2026-08-01", to: "2026-08-31" }),
      );
      expect(rows[0]?.totalMinor).toBe(75_000n);
    });

    it("returns a bigint total, not a rounded number", async () => {
      const rows = await asStaff(tenantId, () =>
        expenses.summary({ from: "2026-08-01", to: "2026-08-31" }),
      );
      // `sum()` comes back as a STRING because the value can exceed a double.
      expect(typeof rows[0]?.totalMinor).toBe("bigint");
    });
  });

  // ── Listing ────────────────────────────────────────────────────────────────
  describe("list", () => {
    it("counts what is waiting, and stops once decided", async () => {
      const tenantId = await seedTenant("exp-list");
      const userId = await seedUser(tenantId);
      const categoryId = await seedCategory(tenantId);

      const first = await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId }), userId),
      );
      await asStaff(tenantId, () => expenses.create(expenseInput({ categoryId }), userId));

      expect(await asStaff(tenantId, () => expenses.pendingCount())).toBe(2);
      await asStaff(tenantId, () => expenses.approve(first.id, userId));
      expect(await asStaff(tenantId, () => expenses.pendingCount())).toBe(1);
    });

    it("filters by period", async () => {
      const tenantId = await seedTenant("exp-period");
      const userId = await seedUser(tenantId);
      const categoryId = await seedCategory(tenantId);

      await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId, spentOn: "2026-08-03" }), userId),
      );
      await asStaff(tenantId, () =>
        expenses.create(expenseInput({ categoryId, spentOn: "2026-07-03" }), userId),
      );

      const august = await asStaff(tenantId, () =>
        expenses.list({ from: "2026-08-01", to: "2026-08-31" }),
      );
      expect(august.items).toHaveLength(1);
      expect(august.items[0]?.spentOn).toBe("2026-08-03");
    });
  });

  // ── Isolation ──────────────────────────────────────────────────────────────
  describe("tenant isolation", () => {
    it("never shows another courier's spending", async () => {
      const alpha = await seedTenant("exp-iso-a");
      const beta = await seedTenant("exp-iso-b");
      const userId = await seedUser(alpha);
      const categoryId = await seedCategory(alpha);

      const expense = await asStaff(alpha, () =>
        expenses.create(expenseInput({ categoryId }), userId),
      );

      // What the courier spends is nobody else's business — and a MERCHANT holds
      // no expense permission at all, so they never reach these rows either.
      expect((await asStaff(beta, () => expenses.list())).items).toHaveLength(0);
      expect(await asStaff(beta, () => expenses.pendingCount())).toBe(0);
      await expect(asStaff(beta, () => expenses.getById(expense.id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});
