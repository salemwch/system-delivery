import { describe, expect, it } from "vitest";

import { formatDateTime, formatMoney, formatRate } from "../src/lib/format";

describe("formatMoney", () => {
  it("formats TND (exponent 3)", () => {
    expect(formatMoney(12_500, 3, "en")).toBe("12.500");
    expect(formatMoney(12_500, 3, "fr")).toBe("12,500");
    expect(formatMoney(12_500, 3, "ar")).toBe("12,500");
  });

  it("formats zero", () => {
    expect(formatMoney(0, 3, "en")).toBe("0.000");
  });

  it("formats negative amounts", () => {
    expect(formatMoney(-5_000, 3, "en")).toBe("-5.000");
  });

  it("groups thousands", () => {
    expect(formatMoney(1_234_567, 3, "en")).toBe("1,234.567");
    expect(formatMoney(1_234_567, 3, "fr")).toBe("1 234,567");
  });

  it("handles exponent 0", () => {
    expect(formatMoney(42, 0, "en")).toBe("42");
  });

  it("pads fractional part", () => {
    expect(formatMoney(1, 3, "en")).toBe("0.001");
    expect(formatMoney(10, 3, "en")).toBe("0.010");
    expect(formatMoney(100, 3, "en")).toBe("0.100");
  });

  it("accepts bigint, which is how COD sums arrive", () => {
    expect(formatMoney(12_500n, 3, "en")).toBe("12.500");
    expect(formatMoney(-5_000n, 3, "en")).toBe("-5.000");
    expect(formatMoney(0n, 3, "fr")).toBe("0,000");
  });

  it("stays exact beyond Number.MAX_SAFE_INTEGER", () => {
    // 9_007_199_254_740_993 is MAX_SAFE_INTEGER + 2 — the first odd integer a
    // double cannot represent. A float implementation renders the digit before
    // last as 2; the bigint one must not.
    expect(formatMoney(9_007_199_254_740_993n, 3, "en")).toBe("9,007,199,254,740.993");
  });
});

describe("formatRate", () => {
  it("formats as percentage", () => {
    expect(formatRate(0.95, "en")).toBe("95%");
    expect(formatRate(1, "en")).toBe("100%");
    expect(formatRate(0, "en")).toBe("0%");
  });
});

describe("formatDateTime", () => {
  it("renders in the given timezone", () => {
    const iso = "2026-08-01T12:00:00Z";
    const result = formatDateTime(iso, "en", "Africa/Tunis");
    expect(result).toContain("13");
    expect(result).toContain("00");
  });

  it("renders Arabic locale with latin numerals", () => {
    const iso = "2026-08-01T12:00:00Z";
    const result = formatDateTime(iso, "ar", "Africa/Tunis");
    expect(result).toMatch(/\d/u);
  });
});
