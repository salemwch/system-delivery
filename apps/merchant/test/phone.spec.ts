import { describe, expect, it } from "vitest";

import { toE164 } from "../src/lib/phone";

/**
 * The case that motivated this: a commercial typed `24201314` into merchant
 * registration — the way every Tunisian writes their number — and the form
 * refused it against a bare E.164 regex.
 */
describe("toE164", () => {
  it("adds the Tunisian dialling code to a national number", () => {
    expect(toE164("24201314")).toBe("+21624201314");
  });

  it("accepts the separators people actually type", () => {
    expect(toE164("24 201 314")).toBe("+21624201314");
    expect(toE164("24-201-314")).toBe("+21624201314");
    expect(toE164("24.201.314")).toBe("+21624201314");
    expect(toE164("+216 24 201 314")).toBe("+21624201314");
  });

  it("accepts a number already in E.164", () => {
    expect(toE164("+21624201314")).toBe("+21624201314");
  });

  it("understands the 00 international prefix", () => {
    expect(toE164("0021624201314")).toBe("+21624201314");
  });

  it("keeps a foreign number in E.164 as given", () => {
    expect(toE164("+33612345678")).toBe("+33612345678");
  });

  it("refuses a national number of the wrong length rather than guessing", () => {
    // Seven digits is a half-typed Tunisian number; nine is not one at all.
    // Prefixing either would store a plausible-looking wrong number.
    expect(toE164("2420131")).toBeNull();
    expect(toE164("242013145")).toBeNull();
  });

  it("refuses junk", () => {
    expect(toE164("")).toBeNull();
    expect(toE164("   ")).toBeNull();
    expect(toE164("not a phone")).toBeNull();
    expect(toE164("+0123456789")).toBeNull();
  });
});
