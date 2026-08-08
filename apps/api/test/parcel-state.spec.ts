import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AddressService, MerchantService, RecipientService } from "../src/modules/directory/index.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { AuditService, OperatingConfigService, OutboxService } from "../src/modules/platform/index.js";
import { ParcelStateService } from "../src/modules/shipment/application/parcel-state.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import type { CommandContext } from "../src/modules/shipment/application/shipment.service.js";
import { csvCell, toCsv } from "../src/modules/shipment/domain/parcel-state-csv.js";
import { CurrencyService } from "../src/shared/money/index.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { ValidationError } from "../src/shared/errors/index.js";
import { createTenant, createTestDatabase, deleteTenants } from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * État Colis (Entreprise) — every merchant's parcels, by status, over a period.
 *
 * The CSV escaping is tested first and hardest: the merchant name in this file
 * is chosen by whoever signed up, the file is opened by a finance clerk in
 * Excel, and a cell beginning `=` is executed as a formula.
 */
describe("parcel state report", () => {
  // ── CSV serialisation (pure) ───────────────────────────────────────────────
  describe("csvCell", () => {
    it("⚠️ NEUTRALISES A FORMULA — the merchant chose this name", () => {
      // `=HYPERLINK(...)` becomes a live link in the courier's spreadsheet, and
      // `=cmd|'/c calc'!A1` is the DDE variant that has produced remote code
      // execution in the wild.
      expect(csvCell("=HYPERLINK(\"https://evil.tn\")")).toBe(
        "\"'=HYPERLINK(\"\"https://evil.tn\"\")\"",
      );
      expect(csvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    });

    it("neutralises every dangerous leading character, not just =", () => {
      // Excel treats all of these as the start of a formula.
      expect(csvCell("+1")).toBe("'+1");
      expect(csvCell("-1+1")).toBe("'-1+1");
      expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
      expect(csvCell("\tTab")).toBe("'\tTab");
      expect(csvCell("\rCR")).toBe('"\'\rCR"');
    });

    it("leaves an ordinary name alone", () => {
      expect(csvCell("Boutique Yasmine")).toBe("Boutique Yasmine");
      expect(csvCell("متجر ياسمين")).toBe("متجر ياسمين");
      // A minus INSIDE the value is not a formula; only a leading one is.
      expect(csvCell("Ben-Salah")).toBe("Ben-Salah");
    });

    it("quotes and doubles per RFC 4180", () => {
      expect(csvCell('Say "hello"')).toBe('"Say ""hello"""');
      expect(csvCell("Tunis, Ariana")).toBe('"Tunis, Ariana"');
      expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    });

    it("renders null as an empty cell, not the word null", () => {
      expect(csvCell(null)).toBe("");
      expect(csvCell(0)).toBe("0");
    });
  });

  describe("toCsv", () => {
    it("⚠️ emits a UTF-8 BOM so Excel reads Arabic correctly", () => {
      const csv = toCsv(["merchant"], [["متجر ياسمين"]]);
      // Without it, Excel on Windows reads the file as the system codepage and
      // every Arabic and accented French name becomes mojibake.
      expect(csv.startsWith("﻿")).toBe(true);
    });

    it("uses CRLF line endings, as RFC 4180 specifies", () => {
      const csv = toCsv(["a", "b"], [["1", "2"]]);
      expect(csv).toBe("﻿a,b\r\n1,2\r\n");
    });
  });

  // ── The report ─────────────────────────────────────────────────────────────
  describe("report", () => {
    let database: TestDatabase;
    let db: DatabaseService;
    let shipments: ShipmentService;
    let merchants: MerchantService;
    let parcelState: ParcelStateService;
    let createdTenants: string[] = [];

    const ACTOR_ID = randomUUID();
    const dispatcher: CommandContext = { actor: { actorType: "DISPATCHER", actorId: ACTOR_ID } };

    function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
      return TenantContext.run(
        { tenantId: asTenantId(tenantId), actorType: "user", actorId: ACTOR_ID },
        fn,
      );
    }

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

    async function seedShipment(
      tenantId: string,
      merchantId: string,
      overrides: Record<string, unknown> = {},
    ): Promise<string> {
      const shipment = await asStaff(tenantId, () =>
        shipments.create(
          {
            idempotencyKey: randomUUID(),
            merchantId,
            senderName: "Boutique",
            senderPhone: "+21620123456",
            origin: {
              rawInput: "Rue de Marseille, Tunis",
              countryCode: "TN",
              coordinates: { lat: 36.8, lng: 10.18 },
            },
            recipientName: "Sonia Gharbi",
            recipientPhone: `+2162098${Math.floor(1000 + Math.random() * 8999)}`,
            destination: {
              rawInput: "Rue de la Liberté, Ariana",
              countryCode: "TN",
              coordinates: { lat: 36.86, lng: 10.19 },
            },
            currency: "TND",
            ...overrides,
          },
          dispatcher,
        ),
      );
      return shipment.id;
    }

    /** Today and a window that certainly contains it. */
    const period = () => {
      const today = new Date().toISOString().slice(0, 10);
      return { from: today, to: today };
    };

    beforeAll(async () => {
      database = await createTestDatabase();
      db = new DatabaseService(database.app);
      const outbox = new OutboxService();
      const audit = new AuditService(db);
      const addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
      merchants = new MerchantService(db, outbox, audit, addresses);
      shipments = new ShipmentService(
        db,
        new ShipmentEventService(outbox),
        outbox,
        merchants,
        new RecipientService(db),
        addresses,
        new OperatingConfigService(db),
      );
      parcelState = new ParcelStateService(db, merchants, new CurrencyService(db));
    }, 240_000);

    afterAll(async () => {
      await deleteTenants(database.migrator, createdTenants);
      createdTenants = [];
      await database.close();
    });

    let tenantId: string;
    let alpha: string;
    let beta: string;

    beforeEach(async () => {
      tenantId = await seedTenant("state");
      alpha = await seedMerchant(tenantId, "Alpha");
      beta = await seedMerchant(tenantId, "Beta");
    });

    it("counts each merchant's parcels by status", async () => {
      await seedShipment(tenantId, alpha);
      await seedShipment(tenantId, alpha);
      await seedShipment(tenantId, beta);

      const report = await asStaff(tenantId, () => parcelState.report(period()));

      expect(report.rows).toHaveLength(2);
      // Busiest first: the merchant with the most parcels is the one the courier
      // wants to see, and alphabetical order buries them.
      expect(report.rows[0]?.merchantName).toBe("Alpha");
      expect(report.rows[0]?.total).toBe(2);
      expect(report.rows[0]?.byStatus["CREATED"]).toBe(2);
      expect(report.rows[1]?.total).toBe(1);
    });

    it("⚠️ includes EVERY status, zero included", async () => {
      await seedShipment(tenantId, alpha);

      const report = await asStaff(tenantId, () => parcelState.report(period()));

      // A report whose columns move between months cannot be compared, and a CSV
      // whose header changes shape breaks whatever the courier pastes it into.
      expect(report.rows[0]?.byStatus["DELIVERED"]).toBe(0);
      expect(report.rows[0]?.byStatus["RETURNED"]).toBe(0);
      expect(Object.keys(report.rows[0]?.byStatus ?? {})).toHaveLength(11);
    });

    it("splits COD into collected and pending by its STATUS", async () => {
      await seedShipment(tenantId, alpha, { codAmountMinor: 45_000 });
      await seedShipment(tenantId, alpha, { codAmountMinor: 30_000 });

      const report = await asStaff(tenantId, () => parcelState.report(period()));

      // Both are PENDING on creation: nothing has been collected yet, and
      // counting them as collected would overstate what the courier holds.
      expect(report.rows[0]?.codPendingMinor).toBe("75000");
      expect(report.rows[0]?.codCollectedMinor).toBe("0");
      expect(report.rows[0]?.currencyExponent).toBe(3);
    });

    it("excludes a parcel with NO merchant — it belongs to the courier", async () => {
      await seedShipment(tenantId, alpha);
      await asStaff(tenantId, () =>
        shipments.create(
          {
            idempotencyKey: randomUUID(),
            senderName: "Walk-in",
            senderPhone: "+21620123456",
            origin: {
              rawInput: "Comptoir",
              countryCode: "TN",
              coordinates: { lat: 36.8, lng: 10.18 },
            },
            recipientName: "Client",
            recipientPhone: "+21620555111",
            destination: {
              rawInput: "Ariana",
              countryCode: "TN",
              coordinates: { lat: 36.86, lng: 10.19 },
            },
            currency: "TND",
          },
          dispatcher,
        ),
      );

      const report = await asStaff(tenantId, () => parcelState.report(period()));
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]?.total).toBe(1);
    });

    it("narrows to one merchant when asked", async () => {
      await seedShipment(tenantId, alpha);
      await seedShipment(tenantId, beta);

      const report = await asStaff(tenantId, () =>
        parcelState.report({ ...period(), merchantId: beta }),
      );
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]?.merchantName).toBe("Beta");
    });

    it("⚠️ includes the WHOLE final day", async () => {
      await seedShipment(tenantId, alpha);
      const today = new Date().toISOString().slice(0, 10);

      // `<= 2026-08-31` against a timestamp excludes everything after midnight,
      // which silently drops a day's parcels from every month-end report.
      const report = await asStaff(tenantId, () =>
        parcelState.report({ from: today, to: today }),
      );
      expect(report.rows[0]?.total).toBe(1);
    });

    it("returns nothing for a period with no parcels", async () => {
      await seedShipment(tenantId, alpha);

      const report = await asStaff(tenantId, () =>
        parcelState.report({ from: "2020-01-01", to: "2020-01-31" }),
      );
      expect(report.rows).toHaveLength(0);
    });

    it("refuses a backwards period", async () => {
      await expect(
        asStaff(tenantId, () => parcelState.report({ from: "2026-08-31", to: "2026-08-01" })),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("requires the period — an unbounded report is a full scan", async () => {
      await expect(asStaff(tenantId, () => parcelState.report({}))).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("never counts another tenant's parcels", async () => {
      const other = await seedTenant("state-other");
      const otherMerchant = await seedMerchant(other, "Rival");
      await seedShipment(other, otherMerchant);
      await seedShipment(tenantId, alpha);

      const report = await asStaff(tenantId, () => parcelState.report(period()));
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]?.merchantName).toBe("Alpha");
    });

    // ── CSV, end to end ──────────────────────────────────────────────────────
    it("exports the same numbers as the screen, with money as decimals", async () => {
      await seedShipment(tenantId, alpha, { codAmountMinor: 45_000 });

      const csv = await asStaff(tenantId, () => parcelState.csv(period()));

      expect(csv).toContain("merchant_id,merchant,period_from");
      expect(csv).toContain("Alpha");
      // 45000 millimes in a money column is a bug report; the file is read by a
      // human in a spreadsheet.
      expect(csv).toContain("45.000");
      expect(csv).not.toContain(",45000,");
    });

    it("⚠️ neutralises a malicious merchant name in the exported file", async () => {
      const evil = await seedMerchant(tenantId, "=HYPERLINK(\"https://evil.tn\")");
      await seedShipment(tenantId, evil);

      const csv = await asStaff(tenantId, () => parcelState.csv(period()));

      // The apostrophe is what stops Excel evaluating it. Quoting alone does
      // not: Excel strips the quotes and then evaluates what is inside.
      expect(csv).toContain("'=HYPERLINK");
      expect(csv).not.toMatch(/,=HYPERLINK/u);
    });
  });
});
