import { describe, expect, it } from "vitest";

import {
  NUMBER_PREFIX,
  computeInvoiceTotals,
  formatDocumentNumber,
} from "../src/modules/finance/domain/invoice-totals.js";

/**
 * The arithmetic that decides what a customer is charged.
 *
 * Tested exhaustively and without a database, because the failure mode is not
 * an exception — it is a wrong number that nobody notices until an audit.
 *
 * All amounts are TND millimes: three decimals, so 12_500 is 12.500 TND.
 */
describe("computeInvoiceTotals", () => {
  const line = (quantity: number, unitPriceMinor: bigint) => ({
    description: "Livraison",
    quantity,
    unitPriceMinor,
  });

  it("multiplies quantity by unit price on each line", () => {
    const totals = computeInvoiceTotals([line(40, 4_500n)], 0, 0n);
    expect(totals.lines[0]?.lineTotalMinor).toBe(180_000n);
    expect(totals.subtotalMinor).toBe(180_000n);
  });

  it("numbers lines from 1, because the number is printed", () => {
    const totals = computeInvoiceTotals([line(1, 1n), line(1, 1n)], 0, 0n);
    expect(totals.lines.map((l) => l.position)).toEqual([1, 2]);
  });

  it("applies VAT at the given basis-point rate", () => {
    // 100.000 TND at 19% = 19.000 TND.
    const totals = computeInvoiceTotals([line(1, 100_000n)], 1900, 0n);
    expect(totals.vatAmountMinor).toBe(19_000n);
    expect(totals.totalMinor).toBe(119_000n);
  });

  it("calculates VAT on the SUBTOTAL, not per line", () => {
    // ⚠️ The bug this guards: rounding each line and summing drifts by up to
    // one minor unit per line. Three lines of 3 millimes at 19% —
    //   per line:  round(0.57) = 1, three times = 3
    //   on total:  round(9 × 0.19) = round(1.71) = 2
    // The second is right, and the difference grows with the line count.
    const totals = computeInvoiceTotals([line(1, 3n), line(1, 3n), line(1, 3n)], 1900, 0n);
    expect(totals.subtotalMinor).toBe(9n);
    expect(totals.vatAmountMinor).toBe(2n);
  });

  it("rounds VAT half away from zero, never truncating", () => {
    // BigInt division truncates: 19n/10n is 1. Truncating here would
    // under-charge on every invoice with a fractional VAT — systematically, in
    // the customer's favour, forever.
    // 10 millimes at 19% = 1.9 → 2.
    expect(computeInvoiceTotals([line(1, 10n)], 1900, 0n).vatAmountMinor).toBe(2n);
    // 5 millimes at 19% = 0.95 → 1.
    expect(computeInvoiceTotals([line(1, 5n)], 1900, 0n).vatAmountMinor).toBe(1n);
    // Exactly one half rounds up: 50 at 1% = 0.5 → 1.
    expect(computeInvoiceTotals([line(1, 50n)], 100, 0n).vatAmountMinor).toBe(1n);
  });

  it("adds the stamp duty AFTER tax and never taxes it", () => {
    // ⚠️ The timbre fiscal is a fixed duty, not part of the taxable base.
    // Including it would overcharge every invoice by rate × duty.
    const totals = computeInvoiceTotals([line(1, 100_000n)], 1900, 1_000n);
    expect(totals.vatAmountMinor).toBe(19_000n); // 19% of 100.000, NOT of 101.000
    expect(totals.totalMinor).toBe(120_000n); // 100.000 + 19.000 + 1.000
  });

  it("handles an exempt tenant at 0%", () => {
    const totals = computeInvoiceTotals([line(2, 50_000n)], 0, 1_000n);
    expect(totals.vatAmountMinor).toBe(0n);
    expect(totals.totalMinor).toBe(101_000n);
  });

  it("produces a zero invoice for no lines rather than throwing", () => {
    // A draft starts empty. Refusing to total it would mean the UI could not
    // show a running figure while the user adds lines.
    const totals = computeInvoiceTotals([], 1900, 1_000n);
    expect(totals.subtotalMinor).toBe(0n);
    expect(totals.vatAmountMinor).toBe(0n);
    expect(totals.totalMinor).toBe(1_000n);
  });

  it("stays exact on amounts that would lose precision as floats", () => {
    // 9 007 199 254 740 993 is Number.MAX_SAFE_INTEGER + 2 — the first odd
    // integer a double cannot hold. A float implementation is silently wrong
    // here; bigint is not.
    const totals = computeInvoiceTotals([line(1, 9_007_199_254_740_993n)], 0, 0n);
    expect(totals.subtotalMinor).toBe(9_007_199_254_740_993n);
    expect(totals.totalMinor).toBe(9_007_199_254_740_993n);
  });

  it("always satisfies total = subtotal + vat + stamp", () => {
    // The same invariant the database CHECK enforces. If these two ever
    // disagree, every insert fails — better to find it here.
    for (const rate of [0, 1, 700, 1900, 10_000]) {
      for (const price of [1n, 7n, 12_500n, 999_999n]) {
        const totals = computeInvoiceTotals([line(3, price)], rate, 1_000n);
        expect(totals.totalMinor).toBe(
          totals.subtotalMinor + totals.vatAmountMinor + totals.stampDutyMinor,
        );
      }
    }
  });
});

describe("formatDocumentNumber", () => {
  it("pads to five digits so numbers sort lexically", () => {
    expect(formatDocumentNumber("FA", 2026, 1)).toBe("FA-2026-00001");
    expect(formatDocumentNumber("FA", 2026, 42)).toBe("FA-2026-00042");
    expect(formatDocumentNumber("AV", 2026, 12_345)).toBe("AV-2026-12345");
  });

  it("does not truncate beyond the padding width", () => {
    // Better a wider number than a duplicate one.
    expect(formatDocumentNumber("FA", 2026, 123_456)).toBe("FA-2026-123456");
  });

  it("uses the Tunisian abbreviations", () => {
    expect(NUMBER_PREFIX.INVOICE).toBe("FA");
    expect(NUMBER_PREFIX.CREDIT_NOTE).toBe("AV");
  });
});
