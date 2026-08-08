import { describe, expect, it } from "vitest";

import { renderDistributionNote } from "../src/modules/dispatch/domain/distribution-note.js";
import type { DistributionStop } from "../src/modules/dispatch/domain/distribution-note.js";
import { renderPaymentNote } from "../src/modules/finance/domain/payment-note.js";
import type { DocumentLocale } from "../src/shared/documents/index.js";

/**
 * Bon de distribution and bon de paiement.
 *
 * Both renderers are PURE, so these are unit tests with no database: the whole
 * point of keeping the layout free of I/O is that the output can be asserted
 * directly, including the things that only matter on paper — Arabic direction,
 * Latin digits, escaped text, and the repeated table header.
 */
describe("operational notes", () => {
  // ── Bon de distribution ────────────────────────────────────────────────────
  describe("distribution note", () => {
    const stop = (overrides: Partial<DistributionStop> = {}): DistributionStop => ({
      sequence: 1,
      trackingNumber: "TN-2026-000123",
      recipientName: "Sonia Gharbi",
      recipientPhone: "+21620987654",
      addressLine: "Rue de la Liberté, Ariana",
      codAmount: "45.000",
      ...overrides,
    });

    const data = (overrides: Record<string, unknown> = {}) => ({
      locale: "fr" as DocumentLocale,
      courierName: "Rapide Express",
      routeCode: "R-2026-0042",
      plannedDate: "2026-08-09",
      driverName: "Karim Bouazizi",
      vehiclePlate: "123 TUN 4567",
      issuedAt: new Date("2026-08-08T07:30:00Z"),
      timezone: "Africa/Tunis",
      stops: [stop(), stop({ sequence: 2, trackingNumber: "TN-2026-000124", codAmount: null })],
      codTotal: "45.000",
      currency: "TND",
      ...overrides,
    });

    it("lists every parcel with its tracking number and recipient", () => {
      const html = renderDistributionNote(data());

      expect(html).toContain("TN-2026-000123");
      expect(html).toContain("TN-2026-000124");
      expect(html).toContain("Sonia Gharbi");
      expect(html).toContain("Karim Bouazizi");
    });

    it("shows the cash total the driver is accountable for", () => {
      const html = renderDistributionNote(data());
      expect(html).toContain("Total à encaisser");
      expect(html).toContain("45.000");
    });

    it("omits the total — and the notice — when there is no COD", () => {
      const html = renderDistributionNote(data({ codTotal: null }));

      // A driver carrying no cash must not be handed a document telling them
      // they owe a total.
      expect(html).not.toContain("Total à encaisser");
      expect(html).not.toContain("reconnaît avoir reçu les colis");
    });

    it("⚠️ repeats the table header on every printed page", () => {
      const html = renderDistributionNote(data());
      // A second sheet of thirty rows with no column headings is a sheet nobody
      // can read.
      expect(html).toContain("thead { display: table-header-group; }");
    });

    it("carries two signature lines — it is a handover between two people", () => {
      const html = renderDistributionNote(data());
      expect(html).toContain("Signature du répartiteur");
      expect(html).toContain("Signature du livreur");
    });

    it("renders Arabic right-to-left, with LATIN digits", () => {
      const html = renderDistributionNote(data({ locale: "ar" }));

      expect(html).toContain('dir="rtl"');
      expect(html).toContain("وصل التوزيع");
      // ⚠️ Eastern Arabic numerals are correct typography and wrong here: the
      // number is read back down a phone line to someone on a Latin-digit
      // screen, and the two must match.
      expect(html).toContain("TN-2026-000123");
      expect(html).not.toMatch(/[٠-٩]/u);
    });

    it("keeps the tracking number LTR inside an RTL document", () => {
      const html = renderDistributionNote(data({ locale: "ar" }));
      expect(html).toContain(".ltr { direction: ltr; unicode-bidi: isolate; }");
      expect(html).toContain('class="ltr mono">TN-2026-000123');
    });

    it("escapes text that came from a human", () => {
      const html = renderDistributionNote(
        data({ stops: [stop({ recipientName: "<script>alert(1)</script>" })] }),
      );

      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it("renders an empty route without breaking", () => {
      // A published route whose parcels were all cancelled still prints — the
      // driver needs the paper that says there was nothing to take.
      const html = renderDistributionNote(data({ stops: [], codTotal: null }));
      expect(html).toContain("Bon de distribution");
      expect(html).toContain("R-2026-0042");
    });

    it("omits the vehicle line when no vehicle is assigned", () => {
      const html = renderDistributionNote(data({ vehiclePlate: null }));
      expect(html).not.toContain("Véhicule");
    });
  });

  // ── Bon de paiement ────────────────────────────────────────────────────────
  describe("payment note", () => {
    const data = (overrides: Record<string, unknown> = {}) => ({
      locale: "fr" as DocumentLocale,
      courierName: "Rapide Express",
      reference: "STL-2026-0007",
      merchantName: "Boutique Yasmine",
      periodFrom: "2026-07-01",
      periodTo: "2026-07-31",
      shipmentCount: 128,
      grossCod: "5 760.000",
      deliveryFees: "384.000",
      adjustments: "0.000",
      netPayable: "5 376.000",
      currency: "TND",
      paymentMethod: "BANK_TRANSFER",
      paymentReference: "VIR-88213",
      paidAt: new Date("2026-08-05T09:00:00Z"),
      issuedAt: new Date("2026-08-08T07:30:00Z"),
      timezone: "Africa/Tunis",
      ...overrides,
    });

    it("⚠️ SHOWS THE ARITHMETIC, not just the total", () => {
      const html = renderPaymentNote(data());

      // The only question a merchant asks about this document is "why is it less
      // than I expected?", and a bare total cannot answer it.
      expect(html).toContain("Encaissements bruts");
      expect(html).toContain("5 760.000");
      expect(html).toContain("Frais de livraison");
      expect(html).toContain("384.000");
      expect(html).toContain("Net versé");
      expect(html).toContain("5 376.000");
    });

    it("marks an UNPAID settlement so it cannot be filed as paid", () => {
      const html = renderPaymentNote(data({ paidAt: null }));

      // Printable before payment on purpose — the courier takes it to the
      // merchant with the cash — so the unpaid state has to be visible.
      expect(html).toContain("En attente de paiement");
      expect(html).not.toContain("Payé le");
    });

    it("shows the payment date once paid", () => {
      const html = renderPaymentNote(data());
      expect(html).toContain("Payé le");
      expect(html).not.toContain("En attente de paiement");
    });

    it("omits the payment block entirely when neither field is set", () => {
      const html = renderPaymentNote(data({ paymentMethod: null, paymentReference: null }));
      expect(html).not.toContain("Mode de paiement");
      expect(html).not.toContain("Référence du virement");
    });

    it("carries the receipt notice and both signatures", () => {
      const html = renderPaymentNote(data());
      expect(html).toContain("reconnaît avoir reçu le montant net");
      expect(html).toContain("Pour le transporteur");
      expect(html).toContain("Pour l’expéditeur");
    });

    it("renders Arabic right-to-left with Latin digits", () => {
      const html = renderPaymentNote(data({ locale: "ar" }));

      expect(html).toContain('dir="rtl"');
      expect(html).toContain("وصل الدفع");
      expect(html).toContain("5 376.000");
      expect(html).not.toMatch(/[٠-٩]/u);
    });

    it("escapes a merchant name that contains markup", () => {
      const html = renderPaymentNote(data({ merchantName: '<img src=x onerror="alert(1)">' }));

      expect(html).not.toContain('<img src=x onerror="alert(1)">');
      expect(html).toContain("&lt;img");
    });

    it("keeps the amounts LTR inside an RTL document", () => {
      const html = renderPaymentNote(data({ locale: "ar" }));
      // An amount mirrored by an RTL paragraph is an amount read wrong.
      expect(html).toContain('<span class="ltr">5 376.000 TND</span>');
    });
  });
});
