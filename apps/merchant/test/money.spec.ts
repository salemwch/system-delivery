import { describe, expect, it } from "vitest";

import { formatMoney, formatWeight, parseMoney } from "../src/lib/format";
import { EVENT_LABELS, LOCALES, MESSAGES, STATUS_LABELS, toLocale } from "../src/lib/i18n";

/**
 * Money, in both directions.
 *
 * ⚠️ This portal is where a merchant reads what they are owed AND types what to
 * collect, so the round trip has to be exact. **TND has three decimal places**:
 * a formatter or parser that assumes two is wrong by a factor of ten, and the
 * error lands on an invoice.
 */
describe("formatting money", () => {
  it("formats TND at THREE decimal places", () => {
    expect(formatMoney(12_500, 3, "fr")).toBe("12,500");
    expect(formatMoney(12_500, 3, "en")).toBe("12.500");
  });

  it("formats a two-decimal currency correctly too", () => {
    expect(formatMoney(12_500, 2, "fr")).toBe("125,00");
  });

  it("pads a fraction that would otherwise lose its leading zeros", () => {
    // 5 millimes is 0,005 TND — not 0,5, which is a hundredfold error.
    expect(formatMoney(5, 3, "fr")).toBe("0,005");
    expect(formatMoney(50, 3, "fr")).toBe("0,050");
  });

  it("groups thousands so a settlement figure stays readable", () => {
    expect(formatMoney(1_234_567, 3, "en")).toBe("1,234.567");
  });
});

describe("parsing what a merchant types", () => {
  it("accepts BOTH decimal marks for the same amount", () => {
    // ⚠️ A Tunisian merchant types "12,500" and an English-speaking one types
    // "12.500" — for the same 12½ dinars. Guessing from the locale would
    // silently mis-read whichever the merchant did not use.
    expect(parseMoney("12,500", 3)).toBe(12_500);
    expect(parseMoney("12.500", 3)).toBe(12_500);
  });

  it("scales a whole number by the exponent", () => {
    // "12" TND is twelve dinars — 12000 millimes, not 12.
    expect(parseMoney("12", 3)).toBe(12_000);
    expect(parseMoney("12", 2)).toBe(1_200);
  });

  it("pads a short fraction rather than misreading it", () => {
    // "12,5" is twelve and a half dinars = 12500, not 125.
    expect(parseMoney("12,5", 3)).toBe(12_500);
    expect(parseMoney("12,50", 3)).toBe(12_500);
  });

  it("tolerates spaces a merchant types by habit", () => {
    expect(parseMoney(" 1 250 ", 0)).toBe(1_250);
  });

  it("REJECTS more precision than the currency has", () => {
    // Rounding here would decide on the merchant's behalf what they meant by
    // 12.5001 TND. A field error asks them instead.
    expect(parseMoney("12.5001", 3)).toBeNull();
  });

  it("rejects anything that is not a plain amount", () => {
    // A parcel worth NaN is a parcel a driver cannot collect against.
    expect(parseMoney("", 3)).toBeNull();
    expect(parseMoney("abc", 3)).toBeNull();
    expect(parseMoney("12,5,0", 3)).toBeNull();
    expect(parseMoney("-5", 3)).toBeNull();
    expect(parseMoney("12.5.0", 3)).toBeNull();
  });

  it("round-trips through format and back", () => {
    // The property that matters: what a merchant sees, retyped, is what they saw.
    for (const minor of [0, 5, 50, 500, 12_500, 1_234_567]) {
      const shown = formatMoney(minor, 3, "en").replace(/,/gu, "");
      expect(parseMoney(shown, 3)).toBe(minor);
    }
  });
});

describe("weight", () => {
  it("uses grams below a kilo and kilos above", () => {
    expect(formatWeight(800, "en")).toBe("800 g");
    expect(formatWeight(2_500, "en")).toBe("2.5 kg");
    expect(formatWeight(3_000, "en")).toBe("3 kg");
  });
});

describe("localisation", () => {
  it("falls back to French rather than failing", () => {
    expect(toLocale("de")).toBe("fr");
    expect(toLocale(undefined)).toBe("fr");
    expect(toLocale("ar")).toBe("ar");
  });

  it("has every message in every language", () => {
    // A missing key renders as `undefined` on a merchant's screen. Comparing key
    // sets catches a string added to one language and forgotten in the others.
    const reference = Object.keys(MESSAGES.fr).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale]).sort()).toEqual(reference);
    }
  });

  it("has every shipment status in every language", () => {
    const reference = Object.keys(STATUS_LABELS.fr).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(STATUS_LABELS[locale]).sort()).toEqual(reference);
    }
  });

  it("has every event label in every language", () => {
    const reference = Object.keys(EVENT_LABELS.fr).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(EVENT_LABELS[locale]).sort()).toEqual(reference);
    }
  });

  it("covers every status the state machine can produce", () => {
    // ⚠️ Derived from the API's own vocabulary. A status added to the shipment
    // state machine and not here renders as a raw enum on a merchant's screen.
    const fromStateMachine = [
      "CREATED",
      "ASSIGNED",
      "PICKED_UP",
      "AT_HUB",
      "IN_TRANSIT",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "ATTEMPT_FAILED",
      "RETURN_PENDING",
      "RETURNED",
      "CANCELLED",
    ];
    for (const status of fromStateMachine) {
      expect(STATUS_LABELS.fr[status]).toBeDefined();
      expect(STATUS_LABELS.ar[status]).toBeDefined();
      expect(STATUS_LABELS.en[status]).toBeDefined();
    }
  });
});
