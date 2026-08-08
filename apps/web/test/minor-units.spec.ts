import { describe, expect, it } from "vitest";

import { toMinorUnits } from "../src/lib/minor-units";

/**
 * The conversion that decides what a merchant is billed.
 *
 * Tested exhaustively because the failure mode is not an exception — it is a
 * price one millime out on a document that has already been printed, signed and
 * filed.
 *
 * TND is exponent 3 (millimes) unless a case says otherwise.
 */
describe("toMinorUnits", () => {
  it("pads a short fraction to the currency's precision", () => {
    // ⚠️ The ×100 trap. 0.5 TND is 500 millimes, not 50 and not 5.
    expect(toMinorUnits("0.5", 3)).toBe("500");
    expect(toMinorUnits("4.5", 3)).toBe("4500");
    expect(toMinorUnits("12.5", 3)).toBe("12500");
  });

  it("keeps a full-precision fraction exactly", () => {
    expect(toMinorUnits("4.500", 3)).toBe("4500");
    expect(toMinorUnits("12.345", 3)).toBe("12345");
    expect(toMinorUnits("0.001", 3)).toBe("1");
  });

  it("handles a whole number with no separator", () => {
    expect(toMinorUnits("19", 3)).toBe("19000");
    expect(toMinorUnits("0", 3)).toBe("0");
  });

  it("accepts a comma, because a French or Arabic keyboard produces one", () => {
    expect(toMinorUnits("4,500", 3)).toBe("4500");
    expect(toMinorUnits("0,5", 3)).toBe("500");
  });

  it("respects the exponent it is given", () => {
    // EUR at 2, and a zero-decimal currency where the fraction is dropped.
    expect(toMinorUnits("4.50", 2)).toBe("450");
    expect(toMinorUnits("4.5", 2)).toBe("450");
    expect(toMinorUnits("4", 0)).toBe("4");
    expect(toMinorUnits("4.9", 0)).toBe("4");
  });

  it("is exact on the values a float implementation gets wrong", () => {
    // ⚠️ THE REASON THIS FUNCTION EXISTS.
    //   Math.round(4.005 * 1000) → 4004   (4.005 * 1000 is 4004.999999999999)
    //   Math.round(1.005 * 100)  → 100    (1.005 * 100 is 100.49999999999999)
    // Both under-charge, silently, forever.
    expect(toMinorUnits("4.005", 3)).toBe("4005");
    expect(toMinorUnits("1.005", 2)).toBe("100"); // 1.00|5 — truncated, not 100.5
    expect(toMinorUnits("8.165", 3)).toBe("8165");
    expect(toMinorUnits("1.135", 3)).toBe("1135");
  });

  it("strips leading zeroes without eating the value", () => {
    // "0.500" concatenates to "0500"; the last digit must survive.
    expect(toMinorUnits("0.500", 3)).toBe("500");
    expect(toMinorUnits("00.100", 3)).toBe("100");
    expect(toMinorUnits("0.000", 3)).toBe("0");
    expect(toMinorUnits("0.0", 3)).toBe("0");
  });

  it("stays exact well past Number.MAX_SAFE_INTEGER", () => {
    // 9 007 199 254 740 993 millimes — the first odd integer a double cannot
    // hold. A float implementation returns 9007199254740992 here.
    expect(toMinorUnits("9007199254740.993", 3)).toBe("9007199254740993");
  });

  it("truncates beyond the currency's precision rather than rounding", () => {
    // The caller's schema rejects this before it arrives; the behaviour is
    // pinned so a future relaxation of that schema cannot silently start
    // rounding money.
    expect(toMinorUnits("1.9999", 3)).toBe("1999");
  });

  it("converts a percentage to basis points at exponent 2", () => {
    // The billing-settings form reuses this: 19% → 1900bp, 19.5% → 1950bp.
    expect(toMinorUnits("19", 2)).toBe("1900");
    expect(toMinorUnits("19.5", 2)).toBe("1950");
    expect(toMinorUnits("7", 2)).toBe("700");
    expect(toMinorUnits("0", 2)).toBe("0");
    expect(toMinorUnits("100", 2)).toBe("10000");
  });
});
