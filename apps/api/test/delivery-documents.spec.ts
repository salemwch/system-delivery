import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { TenantService } from "../src/modules/platform/application/tenant.service.js";
import { DocumentService } from "../src/modules/shipment/application/document.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import { escapeHtml, renderDocument } from "../src/modules/shipment/domain/document.js";
import type { DocumentData } from "../src/modules/shipment/domain/document.js";
import { parcelQrSvg } from "../src/modules/shipment/domain/parcel-qr.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError } from "../src/shared/errors/index.js";
import { CurrencyService } from "../src/shared/money/index.js";
import { createTenant, createTestDatabase, deleteTenants } from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Delivery documents (docs/01-mvp-scope.md §4.2 #2.14).
 *
 * Paper is not decoration in this market: a bon de livraison is signed by the
 * person receiving the parcel and is the evidence in a dispute. Two properties
 * therefore matter more than layout —
 *
 *  1. **The COD amount is right.** TND has THREE decimal places. A ×100
 *     assumption prints 12.50 on a document a driver collects 12.500 against.
 *  2. **Arabic is genuinely RTL**, because half this market reads it.
 */
describe("delivery documents", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let shipments: ShipmentService;
  let merchants: MerchantService;
  let documents: DocumentService;
  let createdTenants: string[] = [];

  const ctx = { actor: { actorType: "DISPATCHER" as const, actorId: randomUUID() } };
  const driverCtx = { actor: { actorType: "DRIVER" as const, actorId: randomUUID() } };

  async function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  async function makeShipment(
    tenantId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const merchantId = await asStaff(
      tenantId,
      async () => (await merchants.create({ name: "Boutique El Manar" })).id,
    );
    const created = await asStaff(tenantId, () =>
      shipments.create(
        {
          idempotencyKey: randomUUID(),
          merchantId,
          senderName: "Boutique El Manar",
          senderPhone: "+21620000001",
          origin: { rawInput: "12 Rue de Rome, Tunis", countryCode: "TN" },
          recipientName: "Ahmed Ben Ali",
          recipientPhone: "+21620000002",
          destination: { rawInput: "5 Avenue Habib Bourguiba, Sfax", countryCode: "TN" },
          currency: "TND",
          codAmountMinor: 45_500,
          parcelCount: 2,
          weightGrams: 2_500,
          ...overrides,
        },
        ctx,
      ),
    );
    return created.id;
  }

  /** Drives a shipment to RETURN_PENDING through the reason policy. */
  async function returning(tenantId: string): Promise<string> {
    const shipmentId = await makeShipment(tenantId);
    await asStaff(tenantId, () =>
      shipments.recordEvent(
        shipmentId,
        { idempotencyKey: randomUUID(), eventType: "assigned" },
        ctx,
      ),
    );
    await asStaff(tenantId, () =>
      shipments.recordPickup(
        shipmentId,
        { idempotencyKey: randomUUID(), driverId: randomUUID() },
        ctx,
      ),
    );
    await asStaff(tenantId, () =>
      shipments.recordEvent(
        shipmentId,
        { idempotencyKey: randomUUID(), eventType: "out_for_delivery" },
        ctx,
      ),
    );
    await asStaff(tenantId, () =>
      shipments.recordFailedAttempt(
        shipmentId,
        {
          idempotencyKey: randomUUID(),
          driverId: randomUUID(),
          // Not re-attemptable, so the reason policy returns it immediately.
          reasonCode: "CUSTOMER_REFUSED",
        },
        driverCtx,
      ),
    );
    return shipmentId;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
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
    const tenants = new TenantService(db, outbox, operatingConfig);
    documents = new DocumentService(shipments, addresses, tenants, new CurrencyService(db));
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── The money, which is the point ──────────────────────────────────────────

  describe("COD amount", () => {
    it("prints TND at THREE decimal places, not two", async () => {
      const tenantId = await seedTenant("doc-cod");
      const shipmentId = await makeShipment(tenantId);

      const doc = await asStaff(tenantId, () => documents.render(shipmentId, "DELIVERY_NOTE"));

      // ⚠️ 45500 minor units of TND is 45.500, not 455.00 and not 45.50. This is
      // the number a driver collects cash against, and the reason the currency
      // exponent is read from the `currencies` table rather than hardcoded.
      expect(doc.html).toContain("45.500");
      expect(doc.html).not.toContain("455.00");
      expect(doc.html).toContain("TND");
    });

    it("says 'none' rather than printing a zero for a non-COD parcel", async () => {
      const tenantId = await seedTenant("doc-nocod");
      const shipmentId = await makeShipment(tenantId, { codAmountMinor: 0 });

      const doc = await asStaff(tenantId, () => documents.render(shipmentId, "DELIVERY_NOTE"));

      // A printed "0.000" invites a driver to ask for nothing and a recipient to
      // wonder what it means.
      expect(doc.html).toContain("Aucun");
      expect(doc.html).not.toContain("0.000");
    });

    it("repeats a COD amount in a boxed notice the driver cannot miss", async () => {
      const tenantId = await seedTenant("doc-notice");
      const shipmentId = await makeShipment(tenantId);

      const doc = await asStaff(tenantId, () => documents.render(shipmentId, "DELIVERY_NOTE"));

      expect(doc.html).toContain("cod-notice");
      expect(doc.html).toContain("Montant à encaisser");
    });
  });

  // ── Arabic, which is why this is HTML and not a generated PDF ──────────────

  describe("localisation", () => {
    it("marks an Arabic document RTL at the document root", async () => {
      const tenantId = await seedTenant("doc-ar");
      const shipmentId = await makeShipment(tenantId);

      const doc = await asStaff(tenantId, () =>
        documents.render(shipmentId, "DELIVERY_NOTE", "ar"),
      );

      expect(doc.html).toContain('lang="ar"');
      expect(doc.html).toContain('dir="rtl"');
      expect(doc.html).toContain("بون توصيل");
    });

    it("keeps the tracking number and phones LTR inside an RTL document", async () => {
      const tenantId = await seedTenant("doc-bidi");
      const shipmentId = await makeShipment(tenantId);

      const doc = await asStaff(tenantId, () =>
        documents.render(shipmentId, "DELIVERY_NOTE", "ar"),
      );

      // ⚠️ A tracking number or an E.164 phone rendered right-to-left is read back
      // to a call centre wrong. `unicode-bidi: isolate` is what prevents it, and
      // it is easy to delete while "tidying" the stylesheet.
      expect(doc.html).toContain("unicode-bidi: isolate");
      expect(doc.html).toContain(".tracking");
      expect(doc.html).toContain(".phone");
    });

    it("renders French and English too", async () => {
      const tenantId = await seedTenant("doc-locales");
      const shipmentId = await makeShipment(tenantId);

      const [fr, en] = await Promise.all([
        asStaff(tenantId, () => documents.render(shipmentId, "DELIVERY_NOTE", "fr")),
        asStaff(tenantId, () => documents.render(shipmentId, "DELIVERY_NOTE", "en")),
      ]);

      expect(fr.html).toContain("Bon de livraison");
      expect(fr.html).toContain('dir="ltr"');
      expect(en.html).toContain("Delivery note");
    });

    it("falls back to the tenant's own language, not to English", async () => {
      const tenantId = await seedTenant("doc-default");
      const shipmentId = await makeShipment(tenantId);

      // The harness seeds tenants with `default_locale = 'fr'`; French is the
      // working language of Tunisian courier administration.
      const doc = await asStaff(tenantId, () => documents.render(shipmentId, "DELIVERY_NOTE"));

      expect(doc.locale).toBe("fr");
      expect(doc.html).toContain("Bon de livraison");
    });

    it("falls back rather than failing on a locale it does not have", async () => {
      const tenantId = await seedTenant("doc-badlocale");
      const shipmentId = await makeShipment(tenantId);

      const doc = await asStaff(tenantId, () =>
        documents.render(shipmentId, "DELIVERY_NOTE", "de"),
      );

      // A document is printed under time pressure; an unknown language parameter
      // must not be the reason a driver leaves without paperwork.
      expect(doc.locale).toBe("fr");
    });
  });

  // ── The three documents are actually different ─────────────────────────────

  describe("document types", () => {
    it("titles each document and names the right signatories", async () => {
      const tenantId = await seedTenant("doc-types");
      const shipmentId = await makeShipment(tenantId);

      const [delivery, consignment] = await Promise.all([
        asStaff(tenantId, () => documents.render(shipmentId, "DELIVERY_NOTE")),
        asStaff(tenantId, () => documents.render(shipmentId, "CONSIGNMENT_NOTE")),
      ]);

      expect(delivery.html).toContain("Bon de livraison");
      // Signed by whoever receives the parcel.
      expect(delivery.html).toContain("Signature du destinataire");

      // `&#39;` because EVERY interpolated value is escaped, labels included —
      // one rule with no exceptions is what stops a tenant-configurable label
      // later becoming an injection point. It renders as an apostrophe.
      expect(consignment.html).toContain("Bon d&#39;envoi");
      // Signed by the merchant handing it over — a different piece of evidence.
      expect(consignment.html).toContain("Signature de l&#39;expéditeur");
      expect(consignment.html).not.toContain("Signature du destinataire");
    });

    it("REFUSES a return note for a parcel that is not going back", async () => {
      const tenantId = await seedTenant("doc-badreturn");
      const shipmentId = await makeShipment(tenantId);

      // ⚠️ A bon de retour for a live parcel is a forgery with a letterhead on it:
      // a merchant would sign it as proof they took back something still out for
      // delivery.
      await expect(
        asStaff(tenantId, () => documents.render(shipmentId, "RETURN_NOTE")),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("issues a return note once the parcel really is returning", async () => {
      const tenantId = await seedTenant("doc-return");
      const shipmentId = await returning(tenantId);

      const doc = await asStaff(tenantId, () => documents.render(shipmentId, "RETURN_NOTE"));

      expect(doc.html).toContain("Bon de retour");
      // The reason is persisted on the EVENT, not only in the outbox payload —
      // outbox rows are relayed away, and a merchant queries a return weeks later.
      expect(doc.html).toContain("Motif du retour");
      expect(doc.html).toContain("CUSTOMER_REFUSED");
    });

    it("names the file after the document, in ASCII", async () => {
      const tenantId = await seedTenant("doc-filename");
      const shipmentId = await makeShipment(tenantId);

      const doc = await asStaff(tenantId, () => documents.render(shipmentId, "DELIVERY_NOTE"));

      // Filenames travel badly across Windows, macOS and a thermal-printer PC.
      expect(doc.filename).toMatch(/^bon-de-livraison-[A-Z0-9-]+\.html$/u);
    });
  });

  // ── Safety and self-containment ────────────────────────────────────────────

  describe("rendering safety", () => {
    it("escapes operator-supplied text instead of executing it", async () => {
      const tenantId = await seedTenant("doc-xss");
      const shipmentId = await makeShipment(tenantId, {
        recipientName: '<script>alert("x")</script>',
      });

      const doc = await asStaff(tenantId, () => documents.render(shipmentId, "DELIVERY_NOTE"));

      // ⚠️ A recipient name is free text typed by a merchant. Unescaped, it runs
      // in whatever browser opens the document.
      expect(doc.html).not.toContain("<script>alert");
      expect(doc.html).toContain("&lt;script&gt;");
    });

    it("escapes ampersands first, so nothing is double-escaped", () => {
      // "&lt;" must not become "&amp;lt;" — the classic ordering bug, which shows
      // up as literal entity text on a printed page.
      expect(escapeHtml('Ben Ali & Co <"x">')).toBe("Ben Ali &amp; Co &lt;&quot;x&quot;&gt;");
    });

    it("embeds the QR inline as SVG with no external request", async () => {
      const tenantId = await seedTenant("doc-qr");
      const shipmentId = await makeShipment(tenantId);

      const doc = await asStaff(tenantId, () => documents.render(shipmentId, "DELIVERY_NOTE"));

      expect(doc.html).toContain("<svg");
      // A warehouse PC on a bad connection must print the same document as a
      // developer's laptop.
      expect(doc.html).not.toMatch(/<(?:script|link|img)\b/u);
      // No FETCHABLE reference. Not a blanket "http://" ban: the inline SVG
      // carries an `xmlns` namespace URI, which is an identifier and is never
      // requested by a renderer.
      expect(doc.html).not.toMatch(/\s(?:src|href)=/u);
    });

    it("strips the XML prolog and fixed size from the QR SVG", async () => {
      const svg = await parcelQrSvg("TN-4F2K9QX7");

      // A stray `<?xml …?>` inside an HTML body is a parse error in some
      // renderers; fixed width/height would override the print stylesheet.
      expect(svg).not.toContain("<?xml");
      expect(svg).toContain("<svg");
      expect(svg).not.toMatch(/<svg[^>]*\swidth=/u);
    });

    it("encodes the bare tracking number, the same payload the label uses", async () => {
      const tenantId = await seedTenant("doc-qrpayload");
      const shipmentId = await makeShipment(tenantId);
      const shipment = await asStaff(tenantId, () => shipments.getById(shipmentId));

      const doc = await asStaff(tenantId, () => documents.render(shipmentId, "DELIVERY_NOTE"));

      // One QR convention shared with LabelService: a scanned document must drop
      // straight into the same custody endpoints a scanned label does.
      expect(doc.trackingNumber).toBe(shipment.trackingNumber);
      expect(doc.html).toContain(shipment.trackingNumber);
    });

    it("is a complete standalone page sized for A5", async () => {
      const tenantId = await seedTenant("doc-page");
      const shipmentId = await makeShipment(tenantId);

      const doc = await asStaff(tenantId, () => documents.render(shipmentId, "DELIVERY_NOTE"));

      expect(doc.html.startsWith("<!doctype html>")).toBe(true);
      expect(doc.html).toContain("@page { size: A5");
      // A signature block split across a page break is not a signature block.
      expect(doc.html).toContain("break-inside: avoid");
    });
  });

  // ── The pure renderer, exercised without a database ────────────────────────

  describe("renderer", () => {
    const base: DocumentData = {
      documentType: "DELIVERY_NOTE",
      locale: "fr",
      courierName: "Rapide Express",
      trackingNumber: "TN-4F2K9QX7",
      qrSvg: "<svg></svg>",
      issuedAt: new Date("2026-07-30T09:12:00Z"),
      timezone: "Africa/Tunis",
      senderName: "Boutique",
      senderPhone: "+21620000001",
      originLines: ["12 Rue de Rome", "1000 Tunis"],
      recipientName: "Ahmed",
      recipientPhone: "+21620000002",
      destinationLines: ["5 Avenue Habib Bourguiba", "3000 Sfax"],
      parcelCount: 2,
      weightGrams: 2_500,
      serviceLevel: "STANDARD",
      codAmount: "45.500",
      currency: "TND",
      notes: null,
      returnReason: null,
    };

    it("prints the courier's LOCAL time, not UTC", () => {
      // 09:12 UTC is 10:12 in Tunis. A signed document showing the wrong hour is
      // a document that disagrees with the custody log it is evidence for.
      const html = renderDocument(base);
      expect(html).toContain("10:12");
    });

    it("renders weights under a kilo in grams", () => {
      expect(renderDocument({ ...base, weightGrams: 800 })).toContain("800 g");
      expect(renderDocument({ ...base, weightGrams: 2_500 })).toContain("2.50 kg");
      expect(renderDocument({ ...base, weightGrams: 3_000 })).toContain("3 kg");
    });

    it("omits an empty address line rather than printing a blank row", () => {
      const html = renderDocument({ ...base, originLines: ["12 Rue de Rome", "", "  "] });
      expect(html).toContain("12 Rue de Rome");
      expect(html).not.toContain("<div></div>");
    });

    it("omits the notes row entirely when there are none", () => {
      expect(renderDocument(base)).not.toContain("Observations");
      expect(renderDocument({ ...base, notes: "Deuxième étage, pas d'ascenseur" })).toContain(
        "Observations",
      );
    });
  });
});
