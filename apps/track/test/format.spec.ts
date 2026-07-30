import { describe, expect, it } from "vitest";

import { formatMoney, formatWindow } from "../src/lib/format";
import { LOCALES, MESSAGES, TIMELINE_LABELS, directionOf, toLocale } from "../src/lib/i18n";

/**
 * The tracking page's pure logic.
 *
 * Money is the whole reason this file exists. The page is the last thing a
 * recipient reads before handing over cash, and **TND has three decimal
 * places** — a formatter that assumes two is wrong by a factor of ten on every
 * Tunisian amount, in the direction that starts an argument on a doorstep.
 */
describe("money", () => {
  it("formats TND at THREE decimal places", () => {
    // ⚠️ 12500 minor units is 12,500 TND — twelve and a half dinars. Not 125.00,
    // which is what a hardcoded ×100 produces.
    expect(formatMoney(12_500, 3, "fr")).toBe("12,500");
    expect(formatMoney(12_500, 3, "en")).toBe("12.500");
  });

  it("formats a two-decimal currency correctly too", () => {
    // The exponent comes from the API per currency; EUR is 2.
    expect(formatMoney(12_500, 2, "fr")).toBe("125,00");
  });

  it("handles a zero-decimal currency", () => {
    // Not hypothetical: several currencies have exponent 0.
    expect(formatMoney(1_250, 0, "fr")).toBe("1 250");
  });

  it("pads a fraction that would otherwise lose its leading zeros", () => {
    // 5 minor units of TND is 0,005 — not 0,5. Truncating the padding here
    // multiplies the amount by 100.
    expect(formatMoney(5, 3, "fr")).toBe("0,005");
    expect(formatMoney(50, 3, "fr")).toBe("0,050");
  });

  it("groups thousands so a large amount stays readable", () => {
    expect(formatMoney(1_234_567, 3, "en")).toBe("1,234.567");
  });

  it("uses a comma for the decimal in French and Arabic, a point in English", () => {
    // Reversed, 12,500 reads as twelve thousand five hundred — a hundredfold
    // misreading on a page about money.
    expect(formatMoney(12_500, 3, "fr")).toContain(",");
    expect(formatMoney(12_500, 3, "ar")).toContain(",");
    expect(formatMoney(12_500, 3, "en")).toContain(".");
  });

  it("keeps a negative amount signed", () => {
    expect(formatMoney(-12_500, 3, "fr")).toBe("-12,500");
  });
});

describe("promised window", () => {
  const from = "2026-07-30T13:10:00Z";
  const to = "2026-07-30T13:40:00Z";

  it("renders a range in the courier's own zone", () => {
    // 13:10 UTC is 14:10 in Tunis. Rendered in the SERVER's zone this would show
    // 13:10 to a recipient whose driver arrives at 14:10.
    expect(formatWindow(from, to, "fr", "Africa/Tunis")).toBe("14:10 – 14:40");
  });

  it("returns null when there is no promise, rather than an empty range", () => {
    // A shipment with no SLA template genuinely has no promised date. Printing
    // "—" invites a call asking what it means.
    expect(formatWindow(null, null, "fr", "Africa/Tunis")).toBeNull();
  });

  it("renders a single time when only the end is known", () => {
    expect(formatWindow(null, to, "fr", "Africa/Tunis")).toBe("14:40");
  });

  it("uses Latin digits even in Arabic", () => {
    // A time read back to a call centre must not be in Eastern-Arabic numerals.
    expect(formatWindow(from, to, "ar", "Africa/Tunis")).toMatch(/^\d{2}:\d{2}/u);
  });
});

describe("locale", () => {
  it("falls back to French rather than failing", () => {
    // French is the working language of Tunisian courier administration, and a
    // recipient arriving from an SMS must never see a 404 over a bad path.
    expect(toLocale("de")).toBe("fr");
    expect(toLocale(undefined)).toBe("fr");
    expect(toLocale("ar")).toBe("ar");
  });

  it("marks only Arabic as RTL", () => {
    expect(directionOf("ar")).toBe("rtl");
    expect(directionOf("fr")).toBe("ltr");
    expect(directionOf("en")).toBe("ltr");
  });

  it("has every message in every language", () => {
    // A missing key renders as `undefined` on a recipient's phone. Comparing
    // key sets catches a translation added to one language and forgotten in the
    // other two.
    const reference = Object.keys(MESSAGES.fr).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale]).sort()).toEqual(reference);
    }
  });

  it("has every timeline label in every language", () => {
    const reference = Object.keys(TIMELINE_LABELS.fr).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(TIMELINE_LABELS[locale]).sort()).toEqual(reference);
    }
  });
});
