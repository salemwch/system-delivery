import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { FieldCipher } from "../src/shared/crypto/field-cipher.js";

/**
 * Field-level PII encryption (docs/07 §6). Pure, no database — proves the cipher
 * round-trips, uses a fresh IV each time, and REJECTS tampered or wrong-key input
 * rather than returning unverified plaintext.
 */
describe("FieldCipher", () => {
  const key = randomBytes(32);
  const cipher = new FieldCipher(key);

  it("round-trips plaintext", () => {
    const token = cipher.encrypt("01234567X");
    expect(cipher.decrypt(token)).toBe("01234567X");
  });

  it("produces a versioned, non-plaintext token", () => {
    const token = cipher.encrypt("secret-national-id");
    expect(token.startsWith("v1:")).toBe(true);
    expect(token).not.toContain("secret-national-id");
  });

  it("uses a fresh IV so identical plaintext encrypts differently", () => {
    const a = cipher.encrypt("same");
    const b = cipher.encrypt("same");
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe("same");
    expect(cipher.decrypt(b)).toBe("same");
  });

  it("rejects a tampered ciphertext (authentication tag)", () => {
    const token = cipher.encrypt("integrity-matters");
    const parts = token.split(":");
    const ct = Buffer.from(parts[3] ?? "", "base64");
    ct[0] = ct[0] === undefined ? 1 : ct[0] ^ 0x01;
    const tampered = [parts[0], parts[1], parts[2], ct.toString("base64")].join(":");
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it("rejects a token encrypted under a different key", () => {
    const other = new FieldCipher(randomBytes(32));
    const token = cipher.encrypt("cross-key");
    expect(() => other.decrypt(token)).toThrow();
  });

  it("passes null/undefined through the optional helpers", () => {
    expect(cipher.encryptOptional(null)).toBeNull();
    expect(cipher.encryptOptional(undefined)).toBeNull();
    expect(cipher.decryptOptional(null)).toBeNull();
    const token = cipher.encryptOptional("x");
    expect(token).not.toBeNull();
    expect(cipher.decryptOptional(token)).toBe("x");
  });

  it("compares plaintext in constant time without exposing it", () => {
    const token = cipher.encrypt("national-123");
    expect(cipher.plaintextEquals(token, "national-123")).toBe(true);
    expect(cipher.plaintextEquals(token, "national-124")).toBe(false);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => new FieldCipher(randomBytes(16))).toThrow();
  });
});
