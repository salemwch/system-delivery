import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { InvoiceService } from "../src/modules/finance/application/invoice.service.js";
import { AddressService, MerchantService } from "../src/modules/directory/index.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import {
  AuditService,
  OperatingConfigService,
  OutboxService,
  TenantService,
} from "../src/modules/platform/index.js";
import { CurrencyService } from "../src/shared/money/index.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError, NotFoundError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Factures et avoirs, against a real PostgreSQL.
 *
 * Everything worth proving here is a database guarantee, not a code path:
 * gapless numbering under real concurrency, the immutability triggers, the
 * arithmetic CHECK, and the two sub-tenant RLS narrowings. A mocked repository
 * would pass every one of these tests while the production system silently
 * issued duplicate invoice numbers.
 *
 * Amounts are TND millimes throughout — three decimals, so 12_500 is 12.500.
 */
describe("invoices", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let invoices: InvoiceService;
  let merchants: MerchantService;
  let createdTenants: string[] = [];

  const YEAR = new Date().getUTCFullYear();

  /** A staff caller: full tenant scope, no merchant and no portfolio narrowing. */
  function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run(
      { tenantId: asTenantId(tenantId), actorType: "user", actorId: ACTOR_ID },
      fn,
    );
  }

  /** A merchant login: narrowed to one merchant (invariant I24). */
  function asMerchant<T>(tenantId: string, merchantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run(
      { tenantId: asTenantId(tenantId), actorType: "user", actorId: ACTOR_ID, merchantId },
      fn,
    );
  }

  /** A commercial login: narrowed to the merchants they manage (invariant I25). */
  function asCommercial<T>(
    tenantId: string,
    accountManagerId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return TenantContext.run(
      {
        tenantId: asTenantId(tenantId),
        actorType: "user",
        actorId: accountManagerId,
        accountManagerId,
      },
      fn,
    );
  }

  const ACTOR_ID = randomUUID();

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  async function seedMerchant(tenantId: string, name: string): Promise<string> {
    const merchant = await asStaff(tenantId, () =>
      merchants.create({ name, code: `M-${Math.random().toString(36).slice(2, 8)}` }),
    );
    return merchant.id;
  }

  /** A staff user row, so `account_manager_id` has something real to point at. */
  async function seedUser(tenantId: string, role: string): Promise<string> {
    const email = `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@test.tn`;
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        with u as (
          insert into users (tenant_id, email, password_hash, full_name, status)
          values (${tenantId}, ${email}, 'hash', ${email}, 'ACTIVE')
          returning id
        )
        insert into user_roles (tenant_id, user_id, role)
        select ${tenantId}, u.id, ${role} from u
        returning user_id as id
      `,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to provision user");
    return row.id;
  }

  const line = (description: string, quantity: number, unitPriceMinor: string) => ({
    description,
    quantity,
    unitPriceMinor,
  });

  /** Drafts an invoice with one line, which is what most cases need. */
  async function draft(
    tenantId: string,
    merchantId: string,
    lines = [line("Livraisons août", 40, "4500")],
  ) {
    return asStaff(tenantId, () =>
      invoices.createDraft(
        {
          merchantId,
          periodFrom: "2026-08-01",
          periodTo: "2026-08-31",
          currency: "TND",
          lines,
        },
        ACTOR_ID,
      ),
    );
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const audit = new AuditService(db);
    merchants = new MerchantService(
      db,
      outbox,
      audit,
      new AddressService(db, outbox, new ManualGeocodingProvider()),
    );
    invoices = new InvoiceService(
      db,
      outbox,
      audit,
      new TenantService(db, outbox, new OperatingConfigService(db), new AuditService(db)),
      new CurrencyService(db),
    );
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    await database.close();
  });

  // ── Drafting ───────────────────────────────────────────────────────────────
  describe("createDraft", () => {
    let tenantId: string;
    let merchantId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("inv-draft");
      merchantId = await seedMerchant(tenantId, "Boutique Alpha");
    });

    it("opens a draft with NO number — an abandoned draft must consume none", async () => {
      const { invoice } = await draft(tenantId, merchantId);

      expect(invoice.status).toBe("DRAFT");
      expect(invoice.number).toBeNull();
      expect(invoice.numberYear).toBeNull();
      expect(invoice.issuedAt).toBeNull();
    });

    it("computes the totals from the lines using the tenant's rate", async () => {
      // 40 × 4.500 = 180.000; TVA 19% = 34.200; timbre 1.000.
      const { invoice, lines } = await draft(tenantId, merchantId);

      expect(invoice.subtotalMinor).toBe(180_000n);
      expect(invoice.vatRateBp).toBe(1900);
      expect(invoice.vatAmountMinor).toBe(34_200n);
      expect(invoice.stampDutyMinor).toBe(1_000n);
      expect(invoice.totalMinor).toBe(215_200n);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.lineTotalMinor).toBe(180_000n);
      expect(lines[0]?.position).toBe(1);
    });

    it("accepts a draft with no lines and totals it at the stamp duty", async () => {
      // The UI opens an empty draft and adds lines afterwards. Refusing to
      // total it would mean no running figure while the user works.
      const { invoice } = await draft(tenantId, merchantId, []);
      expect(invoice.subtotalMinor).toBe(0n);
      expect(invoice.totalMinor).toBe(1_000n);
    });

    it("records an audit entry, because an invoice is a financial document", async () => {
      const { invoice } = await draft(tenantId, merchantId);

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ action: string }[]>`
          select action from audit_log where resource_id = ${invoice.id}
        `,
      );
      expect(rows.map((r) => r.action)).toContain("invoice.drafted");
    });
  });

  // ── Editing a draft ────────────────────────────────────────────────────────
  describe("setLines", () => {
    it("replaces every line and recomputes the totals", async () => {
      const tenantId = await seedTenant("inv-lines");
      const merchantId = await seedMerchant(tenantId, "Boutique Beta");
      const { invoice } = await draft(tenantId, merchantId);

      const updated = await asStaff(tenantId, () =>
        invoices.setLines(invoice.id, {
          lines: [line("Livraisons", 10, "5000"), line("Retours", 2, "3000")],
        }),
      );

      expect(updated.lines).toHaveLength(2);
      expect(updated.lines.map((l) => l.position)).toEqual([1, 2]);
      expect(updated.invoice.subtotalMinor).toBe(56_000n); // 50.000 + 6.000
      expect(updated.invoice.vatAmountMinor).toBe(10_640n);
      expect(updated.invoice.totalMinor).toBe(67_640n);
    });

    it("renumbers positions contiguously when a middle line is removed", async () => {
      const tenantId = await seedTenant("inv-renumber");
      const merchantId = await seedMerchant(tenantId, "Boutique Gamma");
      const { invoice } = await draft(tenantId, merchantId, [
        line("A", 1, "1000"),
        line("B", 1, "2000"),
        line("C", 1, "3000"),
      ]);

      const updated = await asStaff(tenantId, () =>
        invoices.setLines(invoice.id, { lines: [line("A", 1, "1000"), line("C", 1, "3000")] }),
      );

      expect(updated.lines.map((l) => [l.position, l.description])).toEqual([
        [1, "A"],
        [2, "C"],
      ]);
    });

    it("keeps the rate the draft was created with when settings change later", async () => {
      // ⚠️ A rate change must never rewrite a document an operator has already
      // reviewed. The rate lives on the invoice, not on a join.
      const tenantId = await seedTenant("inv-rate-frozen");
      const merchantId = await seedMerchant(tenantId, "Boutique Delta");
      const { invoice } = await draft(tenantId, merchantId);

      await asStaff(tenantId, () => invoices.updateSettings({ vatRateBp: 700 }));

      const updated = await asStaff(tenantId, () =>
        invoices.setLines(invoice.id, { lines: [line("Livraisons", 1, "100000")] }),
      );
      expect(updated.invoice.vatRateBp).toBe(1900);
      expect(updated.invoice.vatAmountMinor).toBe(19_000n);
    });
  });

  // ── Issuing ────────────────────────────────────────────────────────────────
  describe("issue", () => {
    let tenantId: string;
    let merchantId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("inv-issue");
      merchantId = await seedMerchant(tenantId, "Boutique Epsilon");
    });

    it("assigns FA-YYYY-00001 and freezes the document", async () => {
      const { invoice } = await draft(tenantId, merchantId);
      const issued = await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));

      expect(issued.invoice.number).toBe(`FA-${YEAR}-00001`);
      expect(issued.invoice.numberYear).toBe(YEAR);
      expect(issued.invoice.status).toBe("ISSUED");
      expect(issued.invoice.issuedAt).not.toBeNull();
      expect(issued.invoice.issuedByUserId).toBe(ACTOR_ID);
    });

    it("numbers consecutively with no gaps", async () => {
      const numbers: (string | null)[] = [];
      for (let i = 0; i < 3; i += 1) {
        const { invoice } = await draft(tenantId, merchantId);
        const issued = await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));
        numbers.push(issued.invoice.number);
      }
      expect(numbers).toEqual([
        `FA-${YEAR}-00001`,
        `FA-${YEAR}-00002`,
        `FA-${YEAR}-00003`,
      ]);
    });

    /**
     * The one that justifies the whole `invoice_sequences` design.
     *
     * ⚠️ Ten simultaneous issues. Without `SELECT … FOR UPDATE` two of them read
     * the same `last_number`, produce the same string, and one dies on the
     * unique index — leaving a hole in a legal series. This asserts ten DISTINCT
     * numbers covering 2…11 with nothing missing.
     *
     * ⚠️ THE WARM-UP ISSUE IS LOAD-BEARING, and it is why this test proves
     * anything. `nextSequence` starts with `INSERT … ON CONFLICT DO NOTHING` to
     * create the counter row, and on a cold sequence that insert takes a lock on
     * the unique index — so nine of the ten transactions block there and the
     * whole burst serialises for free. The test then passes with the `FOR
     * UPDATE` removed, which is a test that proves nothing.
     *
     * Issuing one invoice first creates the row, so the burst hits the path
     * production actually runs: insert does nothing, and the row lock is the
     * ONLY thing serialising them. Verified by deleting `for update` and
     * watching this fail with a duplicate-key error.
     */
    it("stays gapless and duplicate-free under ten concurrent issues", async () => {
      const warmUp = await draft(tenantId, merchantId);
      await asStaff(tenantId, () => invoices.issue(warmUp.invoice.id, ACTOR_ID));

      const drafts = await Promise.all(
        Array.from({ length: 10 }, () => draft(tenantId, merchantId)),
      );

      const issued = await Promise.all(
        drafts.map(({ invoice }) => asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID))),
      );

      const numbers = issued.map((i) => i.invoice.number).sort();
      expect(new Set(numbers).size).toBe(10);
      expect(numbers).toEqual(
        Array.from({ length: 10 }, (_, i) => `FA-${YEAR}-${String(i + 2).padStart(5, "0")}`),
      );
    });

    it("refuses to issue an invoice with no lines", async () => {
      const { invoice } = await draft(tenantId, merchantId, []);
      await expect(asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID))).rejects.toThrow(
        BusinessRuleError,
      );
    });

    it("refuses to issue the same invoice twice", async () => {
      const { invoice } = await draft(tenantId, merchantId);
      await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));
      await expect(asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID))).rejects.toThrow(
        /immutable/i,
      );
    });

    it("snapshots the parties rather than joining them at read time", async () => {
      const { invoice } = await draft(tenantId, merchantId);
      const issued = await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));

      expect(issued.invoice.buyerName).toBe("Boutique Epsilon");
      expect(issued.invoice.sellerName).not.toBeNull();

      // Rename the merchant. The issued document must not change.
      await asStaff(tenantId, () => merchants.update(merchantId, { name: "Renamed SARL" }));
      const reread = await asStaff(tenantId, () => invoices.getById(invoice.id));
      expect(reread.invoice.buyerName).toBe("Boutique Epsilon");
    });

    it("prints the configured legal identity when billing settings exist", async () => {
      await asStaff(tenantId, () =>
        invoices.updateSettings({
          legalName: "Rapide Express SARL",
          taxIdentifier: "1234567/A/M/000",
          legalAddress: "12 rue de Marseille, Tunis",
        }),
      );

      const { invoice } = await draft(tenantId, merchantId);
      const issued = await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));

      expect(issued.invoice.sellerName).toBe("Rapide Express SARL");
      expect(issued.invoice.sellerTaxId).toBe("1234567/A/M/000");
    });

    it("sets the due date from the tenant's payment terms", async () => {
      await asStaff(tenantId, () => invoices.updateSettings({ paymentTermsDays: 15 }));
      const { invoice } = await draft(tenantId, merchantId);
      const issued = await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));

      const issuedAt = issued.invoice.issuedAt;
      const dueAt = issued.invoice.dueAt;
      if (issuedAt === null || dueAt === null) throw new Error("expected both timestamps");
      const days = Math.round((dueAt.getTime() - issuedAt.getTime()) / 86_400_000);
      expect(days).toBe(15);
    });

    it("records who issued it and which number it took", async () => {
      const { invoice } = await draft(tenantId, merchantId);
      await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ action: string; changes: unknown }[]>`
          select action, changes from audit_log
           where resource_id = ${invoice.id} and action = 'invoice.issued'
        `,
      );
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0]?.changes)).toContain(`FA-${YEAR}-00001`);
    });

    it("publishes invoice.issued to the outbox", async () => {
      const { invoice } = await draft(tenantId, merchantId);
      await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ event_type: string }[]>`
          select event_type from outbox where aggregate_id = ${invoice.id}
        `,
      );
      expect(rows.map((r) => r.event_type)).toContain("invoice.issued");
    });
  });

  // ── Immutability, enforced by the database ─────────────────────────────────
  describe("immutability (database triggers)", () => {
    let tenantId: string;
    let merchantId: string;
    let issuedId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("inv-immutable");
      merchantId = await seedMerchant(tenantId, "Boutique Zeta");
      const { invoice } = await draft(tenantId, merchantId);
      issuedId = (await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID))).invoice.id;
    });

    it("refuses a direct UPDATE of an issued invoice's total", async () => {
      // Not through the service — straight SQL, as a compromised process or a
      // careless script would. The guarantee has to hold there too.
      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`update invoices set total_minor = 1 where id = ${issuedId}`,
        ),
      ).rejects.toThrow(/immutable/i);
    });

    it("refuses to change an issued invoice's number", async () => {
      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`update invoices set number = 'FA-2026-09999' where id = ${issuedId}`,
        ),
      ).rejects.toThrow(/immutable/i);
    });

    it("refuses ISSUED → CANCELLED, because the number was already reported", async () => {
      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`update invoices set status = 'CANCELLED' where id = ${issuedId}`,
        ),
      ).rejects.toThrow(/credit note/i);
    });

    it("refuses ISSUED → DRAFT", async () => {
      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`update invoices set status = 'DRAFT' where id = ${issuedId}`,
        ),
      ).rejects.toThrow(/cannot become/i);
    });

    it("freezes the lines of an issued invoice against INSERT, UPDATE and DELETE", async () => {
      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`update invoice_lines set quantity = 999 where invoice_id = ${issuedId}`,
        ),
      ).rejects.toThrow(/cannot be changed/i);

      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`delete from invoice_lines where invoice_id = ${issuedId}`,
        ),
      ).rejects.toThrow(/cannot be changed/i);

      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`
            insert into invoice_lines
              (tenant_id, invoice_id, position, description, quantity, unit_price_minor, line_total_minor)
            values (${tenantId}, ${issuedId}, 99, 'Frais ajoutés', 1, 50000, 50000)
          `,
        ),
      ).rejects.toThrow(/cannot be changed/i);
    });

    it("rejects a total that does not equal subtotal + VAT + stamp", async () => {
      // The arithmetic CHECK, proven on a DRAFT where immutability is not the
      // reason for the rejection.
      const { invoice } = await draft(tenantId, merchantId);
      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`update invoices set total_minor = total_minor + 1 where id = ${invoice.id}`,
        ),
      ).rejects.toThrow(/invoices_total_chk/i);
    });

    it("allows the service to record payment (ISSUED → PAID)", async () => {
      const paid = await asStaff(tenantId, () => invoices.markPaid(issuedId, ACTOR_ID));
      expect(paid.invoice.status).toBe("PAID");
      expect(paid.invoice.number).toBe(`FA-${YEAR}-00001`);
    });

    it("refuses to mark a draft paid", async () => {
      const { invoice } = await draft(tenantId, merchantId);
      await expect(
        asStaff(tenantId, () => invoices.markPaid(invoice.id, ACTOR_ID)),
      ).rejects.toThrow(BusinessRuleError);
    });
  });

  // ── Cancelling ─────────────────────────────────────────────────────────────
  describe("cancelDraft", () => {
    it("cancels a draft and leaves the number series untouched", async () => {
      const tenantId = await seedTenant("inv-cancel");
      const merchantId = await seedMerchant(tenantId, "Boutique Eta");
      const { invoice } = await draft(tenantId, merchantId);

      const cancelled = await asStaff(tenantId, () =>
        invoices.cancelDraft(invoice.id, "Créée par erreur"),
      );
      expect(cancelled.invoice.status).toBe("CANCELLED");
      expect(cancelled.invoice.number).toBeNull();

      // The next issue still takes number 1 — the abandoned draft consumed none.
      const next = await draft(tenantId, merchantId);
      const issued = await asStaff(tenantId, () => invoices.issue(next.invoice.id, ACTOR_ID));
      expect(issued.invoice.number).toBe(`FA-${YEAR}-00001`);
    });

    it("refuses to cancel an issued invoice", async () => {
      const tenantId = await seedTenant("inv-cancel-issued");
      const merchantId = await seedMerchant(tenantId, "Boutique Theta");
      const { invoice } = await draft(tenantId, merchantId);
      await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));

      await expect(
        asStaff(tenantId, () => invoices.cancelDraft(invoice.id, "changed my mind")),
      ).rejects.toThrow(/credit note/i);
    });
  });

  // ── Credit notes ───────────────────────────────────────────────────────────
  describe("createCreditNote", () => {
    let tenantId: string;
    let merchantId: string;
    let issuedId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("inv-avoir");
      merchantId = await seedMerchant(tenantId, "Boutique Iota");
      const { invoice } = await draft(tenantId, merchantId);
      issuedId = (await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID))).invoice.id;
    });

    it("copies the original's lines when none are given (a full credit)", async () => {
      const note = await asStaff(tenantId, () =>
        invoices.createCreditNote(
          { correctsInvoiceId: issuedId, reason: "Facturation en double" },
          ACTOR_ID,
        ),
      );

      expect(note.invoice.kind).toBe("CREDIT_NOTE");
      expect(note.invoice.status).toBe("DRAFT");
      expect(note.invoice.correctsInvoiceId).toBe(issuedId);
      expect(note.invoice.subtotalMinor).toBe(180_000n);
      expect(note.lines).toHaveLength(1);
    });

    it("accepts explicit lines for a partial credit", async () => {
      const note = await asStaff(tenantId, () =>
        invoices.createCreditNote(
          {
            correctsInvoiceId: issuedId,
            reason: "Deux colis non livrés",
            lines: [line("Colis non livrés", 2, "4500")],
          },
          ACTOR_ID,
        ),
      );
      expect(note.invoice.subtotalMinor).toBe(9_000n);
    });

    it("uses the ORIGINAL invoice's VAT rate, not today's", async () => {
      // A credit note reverses a specific document and must reverse the tax
      // that document actually charged.
      await asStaff(tenantId, () => invoices.updateSettings({ vatRateBp: 700 }));

      const note = await asStaff(tenantId, () =>
        invoices.createCreditNote({ correctsInvoiceId: issuedId }, ACTOR_ID),
      );
      expect(note.invoice.vatRateBp).toBe(1900);
      expect(note.invoice.vatAmountMinor).toBe(34_200n);
    });

    it("numbers credit notes in their own AV series, starting at 1", async () => {
      const note = await asStaff(tenantId, () =>
        invoices.createCreditNote({ correctsInvoiceId: issuedId }, ACTOR_ID),
      );
      const issued = await asStaff(tenantId, () => invoices.issue(note.invoice.id, ACTOR_ID));

      // The invoice series is already at 1; the credit-note series is separate.
      expect(issued.invoice.number).toBe(`AV-${YEAR}-00001`);
    });

    it("refuses to credit a draft", async () => {
      const { invoice } = await draft(tenantId, merchantId);
      await expect(
        asStaff(tenantId, () => invoices.createCreditNote({ correctsInvoiceId: invoice.id }, ACTOR_ID)),
      ).rejects.toThrow(/issued invoice/i);
    });

    it("refuses to credit a credit note", async () => {
      const note = await asStaff(tenantId, () =>
        invoices.createCreditNote({ correctsInvoiceId: issuedId }, ACTOR_ID),
      );
      await asStaff(tenantId, () => invoices.issue(note.invoice.id, ACTOR_ID));

      await expect(
        asStaff(tenantId, () =>
          invoices.createCreditNote({ correctsInvoiceId: note.invoice.id }, ACTOR_ID),
        ),
      ).rejects.toThrow(/not another credit note/i);
    });
  });

  // ── Listing ────────────────────────────────────────────────────────────────
  describe("list", () => {
    it("filters by status, kind and merchant, and pages by cursor", async () => {
      const tenantId = await seedTenant("inv-list");
      const alpha = await seedMerchant(tenantId, "Alpha");
      const beta = await seedMerchant(tenantId, "Beta");

      const first = await draft(tenantId, alpha);
      await asStaff(tenantId, () => invoices.issue(first.invoice.id, ACTOR_ID));
      await draft(tenantId, alpha);
      await draft(tenantId, beta);

      const issued = await asStaff(tenantId, () => invoices.list({ status: "ISSUED" }));
      expect(issued.items).toHaveLength(1);

      const forBeta = await asStaff(tenantId, () => invoices.list({ merchantId: beta }));
      expect(forBeta.items).toHaveLength(1);

      const page1 = await asStaff(tenantId, () => invoices.list({ limit: 2 }));
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await asStaff(tenantId, () =>
        invoices.list({ limit: 2, cursor: page1.nextCursor ?? undefined }),
      );
      expect(page2.items).toHaveLength(1);
      // Cursor paging must not repeat a row across pages.
      const ids = new Set([...page1.items, ...page2.items].map((i) => i.id));
      expect(ids.size).toBe(3);
    });
  });

  // ── Tenant and sub-tenant isolation ────────────────────────────────────────
  describe("isolation", () => {
    it("hides another tenant's invoice entirely", async () => {
      const tenantA = await seedTenant("inv-iso-a");
      const tenantB = await seedTenant("inv-iso-b");
      const merchantA = await seedMerchant(tenantA, "Alpha");
      const { invoice } = await draft(tenantA, merchantA);

      await expect(asStaff(tenantB, () => invoices.getById(invoice.id))).rejects.toThrow(
        NotFoundError,
      );
      const listed = await asStaff(tenantB, () => invoices.list({}));
      expect(listed.items).toHaveLength(0);
    });

    it("shows a MERCHANT login only its own invoices (I24)", async () => {
      // ⚠️ The disclosure this prevents: a merchant reading a rival's invoice
      // learns that rival's entire revenue through this courier.
      const tenantId = await seedTenant("inv-i24");
      const mine = await seedMerchant(tenantId, "Mine");
      const rival = await seedMerchant(tenantId, "Rival");
      const own = await draft(tenantId, mine);
      const theirs = await draft(tenantId, rival);

      const visible = await asMerchant(tenantId, mine, () => invoices.list({}));
      expect(visible.items.map((i) => i.id)).toEqual([own.invoice.id]);

      await expect(
        asMerchant(tenantId, mine, () => invoices.getById(theirs.invoice.id)),
      ).rejects.toThrow(NotFoundError);
    });

    it("shows a COMMERCIAL login only its portfolio's invoices (I25)", async () => {
      const tenantId = await seedTenant("inv-i25");
      const managerId = await seedUser(tenantId, "COMMERCIAL");
      const otherManagerId = await seedUser(tenantId, "COMMERCIAL");

      const managed = await seedMerchant(tenantId, "Managed");
      const unmanaged = await seedMerchant(tenantId, "Unmanaged");
      await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx`update merchants set account_manager_id = ${managerId} where id = ${managed}`,
      );

      const mineInvoice = await draft(tenantId, managed);
      const otherInvoice = await draft(tenantId, unmanaged);

      const visible = await asCommercial(tenantId, managerId, () => invoices.list({}));
      expect(visible.items.map((i) => i.id)).toEqual([mineInvoice.invoice.id]);

      await expect(
        asCommercial(tenantId, managerId, () => invoices.getById(otherInvoice.invoice.id)),
      ).rejects.toThrow(NotFoundError);

      // And a different commercial sees neither.
      const none = await asCommercial(tenantId, otherManagerId, () => invoices.list({}));
      expect(none.items).toHaveLength(0);
    });

    it("keeps each tenant's number series independent", async () => {
      const tenantA = await seedTenant("inv-seq-a");
      const tenantB = await seedTenant("inv-seq-b");
      const merchantA = await seedMerchant(tenantA, "Alpha");
      const merchantB = await seedMerchant(tenantB, "Beta");

      const a = await draft(tenantA, merchantA);
      await asStaff(tenantA, () => invoices.issue(a.invoice.id, ACTOR_ID));
      const b = await draft(tenantB, merchantB);
      const issuedB = await asStaff(tenantB, () => invoices.issue(b.invoice.id, ACTOR_ID));

      // Both are number 1. Sharing a counter would leak how much the other
      // tenant invoices — a competitive disclosure, not just untidy.
      expect(issuedB.invoice.number).toBe(`FA-${YEAR}-00001`);
    });
  });

  // ── The printable document ─────────────────────────────────────────────────
  describe("renderDocument", () => {
    let tenantId: string;
    let merchantId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("inv-doc");
      merchantId = await seedMerchant(tenantId, "Boutique Kappa");
      await asStaff(tenantId, () =>
        invoices.updateSettings({
          legalName: "Rapide Express SARL",
          taxIdentifier: "1234567/A/M/000",
        }),
      );
    });

    it("prints every amount through the currency's real exponent", async () => {
      // ⚠️ TND has THREE decimals. A hardcoded ×100 prints 21.52 instead of
      // 215.200 — a hundredfold error on the one number a customer pays.
      const { invoice } = await draft(tenantId, merchantId);
      const issued = await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));
      const html = await asStaff(tenantId, () =>
        invoices.renderDocument(issued.invoice.id, "fr"),
      );

      expect(html).toContain("215.200"); // total TTC
      expect(html).toContain("180.000"); // total HT
      expect(html).toContain("34.200"); // TVA
      expect(html).toContain("1.000"); // timbre fiscal
      expect(html).not.toContain("215200");
    });

    it("prints the number, the rate and the fiscal identity", async () => {
      const { invoice } = await draft(tenantId, merchantId);
      const issued = await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));
      const html = await asStaff(tenantId, () =>
        invoices.renderDocument(issued.invoice.id, "fr"),
      );

      expect(html).toContain(`FA-${YEAR}-00001`);
      expect(html).toContain("19.00%");
      expect(html).toContain("Matricule fiscal");
      expect(html).toContain("1234567/A/M/000");
      expect(html).toContain("Rapide Express SARL");
      expect(html).toContain("Boutique Kappa");
    });

    it("watermarks a draft so it cannot be mistaken for a real invoice", async () => {
      // Without this, a draft printed for internal review differs from a real
      // invoice only by a missing number — and it ends up with a customer.
      const { invoice } = await draft(tenantId, merchantId);
      const html = await asStaff(tenantId, () => invoices.renderDocument(invoice.id, "fr"));
      expect(html).toContain("BROUILLON");
    });

    it("renders Arabic right-to-left with Latin digits", async () => {
      const { invoice } = await draft(tenantId, merchantId);
      const issued = await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));
      const html = await asStaff(tenantId, () =>
        invoices.renderDocument(issued.invoice.id, "ar"),
      );

      expect(html).toContain('dir="rtl"');
      expect(html).toContain("فاتورة");
      expect(html).toContain("المعرف الجبائي");
      // Latin digits: an invoice number is read back to an accountant and typed
      // into a ledger. Eastern-Arabic numerals there are a transcription error.
      expect(html).toContain(`FA-${YEAR}-00001`);
      expect(html).toContain("215.200");
    });

    it("escapes free text, so a line description cannot inject script", async () => {
      const { invoice } = await draft(tenantId, merchantId, [
        line('<script>alert("x")</script>', 1, "1000"),
      ]);
      const html = await asStaff(tenantId, () => invoices.renderDocument(invoice.id, "fr"));

      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;");
    });

    it("prints a credit note as an avoir referencing the original", async () => {
      const { invoice } = await draft(tenantId, merchantId);
      const original = await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));
      const note = await asStaff(tenantId, () =>
        invoices.createCreditNote({ correctsInvoiceId: original.invoice.id }, ACTOR_ID),
      );
      const issuedNote = await asStaff(tenantId, () => invoices.issue(note.invoice.id, ACTOR_ID));

      const html = await asStaff(tenantId, () =>
        invoices.renderDocument(issuedNote.invoice.id, "fr"),
      );
      expect(html).toContain("Avoir");
      expect(html).toContain(`AV-${YEAR}-00001`);
      expect(html).toContain("Annule et remplace la facture");
      expect(html).toContain(`FA-${YEAR}-00001`);
    });

    it("reproduces an old invoice exactly after the merchant is renamed", async () => {
      const { invoice } = await draft(tenantId, merchantId);
      const issued = await asStaff(tenantId, () => invoices.issue(invoice.id, ACTOR_ID));
      await asStaff(tenantId, () => merchants.update(merchantId, { name: "Nouveau Nom SARL" }));

      const html = await asStaff(tenantId, () =>
        invoices.renderDocument(issued.invoice.id, "fr"),
      );
      expect(html).toContain("Boutique Kappa");
      expect(html).not.toContain("Nouveau Nom SARL");
    });

    it("defaults to the tenant's own language when none is asked for", async () => {
      const { invoice } = await draft(tenantId, merchantId);
      const html = await asStaff(tenantId, () => invoices.renderDocument(invoice.id, undefined));
      // The harness provisions tenants without an explicit locale, so this lands
      // on the French default — the working language of Tunisian accounting.
      expect(html).toContain("Total TTC");
    });

    it("refuses to render an invoice outside the caller's scope", async () => {
      const other = await seedTenant("inv-doc-other");
      const { invoice } = await draft(tenantId, merchantId);
      await expect(
        asStaff(other, () => invoices.renderDocument(invoice.id, "fr")),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // ── Billing settings ───────────────────────────────────────────────────────
  describe("settings", () => {
    it("falls back to 19% TVA and a 1.000 TND timbre when never configured", async () => {
      const tenantId = await seedTenant("inv-settings-default");
      const settings = await asStaff(tenantId, () => invoices.settings());

      expect(settings.vatRateBp).toBe(1900);
      expect(settings.stampDutyMinor).toBe(1_000n);
      expect(settings.paymentTermsDays).toBe(30);
    });

    it("creates the row on first write and updates it thereafter", async () => {
      const tenantId = await seedTenant("inv-settings-write");

      const created = await asStaff(tenantId, () =>
        invoices.updateSettings({ vatRateBp: 700, stampDutyMinor: "0" }),
      );
      expect(created.vatRateBp).toBe(700);
      expect(created.stampDutyMinor).toBe(0n);

      const updated = await asStaff(tenantId, () =>
        invoices.updateSettings({ legalName: "Rapide Express SARL" }),
      );
      expect(updated.legalName).toBe("Rapide Express SARL");
      // The earlier fields survive a partial update.
      expect(updated.vatRateBp).toBe(700);
    });

    it("applies a configured exempt rate to new drafts", async () => {
      const tenantId = await seedTenant("inv-settings-exempt");
      const merchantId = await seedMerchant(tenantId, "Exonéré");
      await asStaff(tenantId, () => invoices.updateSettings({ vatRateBp: 0, stampDutyMinor: "0" }));

      const { invoice } = await draft(tenantId, merchantId);
      expect(invoice.vatAmountMinor).toBe(0n);
      expect(invoice.totalMinor).toBe(180_000n);
    });

    it("rejects a rate above 100%", async () => {
      const tenantId = await seedTenant("inv-settings-invalid");
      await expect(
        asStaff(tenantId, () => invoices.updateSettings({ vatRateBp: 10_001 })),
      ).rejects.toThrow();
    });

    it("rejects an empty update rather than writing nothing", async () => {
      const tenantId = await seedTenant("inv-settings-empty");
      await expect(asStaff(tenantId, () => invoices.updateSettings({}))).rejects.toThrow();
    });
  });
});
