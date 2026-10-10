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

  // ── 128-bit tag only (audit finding F3) ──────────────────────────────────

  describe("authentication tag length", () => {
    /** Replaces the tag segment of a genuine token. */
    function withTag(token: string, tag: Buffer): string {
      const [version, iv, , ct] = token.split(":");
      return [version, iv, tag.toString("base64"), ct].join(":");
    }

    function genuineTag(token: string): Buffer {
      return Buffer.from(token.split(":")[2] ?? "", "base64");
    }

    it("refuses the GENUINE tag truncated to 4, 8 or 12 bytes", () => {
      // GCM checks a short tag against the PREFIX of the real one, so this is
      // the attack itself: without `authTagLength` Node accepted these, and a
      // forger needed to match only 2^32 possibilities instead of 2^128.
      const token = cipher.encrypt("national-id-0001");
      for (const bytes of [4, 8, 12]) {
        const truncated = withTag(token, genuineTag(token).subarray(0, bytes));
        expect(() => cipher.decrypt(truncated), `${bytes}-byte tag`).toThrow(/tag length/);
      }
    });

    it("refuses a tag longer than 16 bytes", () => {
      const token = cipher.encrypt("x");
      const tooLong = withTag(token, Buffer.concat([genuineTag(token), Buffer.from([0])]));
      expect(() => cipher.decrypt(tooLong)).toThrow(/tag length/);
    });

    it("refuses a modified 16-byte tag", () => {
      const token = cipher.encrypt("x");
      const tag = Buffer.from(genuineTag(token));
      tag[15] = (tag[15] ?? 0) ^ 0x80;
      expect(() => cipher.decrypt(withTag(token, tag))).toThrow();
    });
  });

  describe("malformed tokens", () => {
    it.each([
      ["too few segments", "v1:aaaa:bbbb"],
      ["too many segments", "v1:a:b:c:d"],
      ["unknown version", "v2:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA"],
      ["characters outside base64", "v1:AAAA$AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA"],
      ["an IV of the wrong length", "v1:AAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA"],
    ])("refuses %s", (_label, token) => {
      expect(() => cipher.decrypt(token)).toThrow();
    });

    it("never echoes the plaintext, the key or the token in its errors", () => {
      const token = cipher.encrypt("secret-plaintext");
      const broken = withTagless(token);
      try {
        cipher.decrypt(broken);
        expect.unreachable("a tag-less token must not decrypt");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain("secret-plaintext");
        expect(message).not.toContain(key.toString("base64"));
        expect(message).not.toContain(broken);
      }
    });

    function withTagless(token: string): string {
      const [version, iv, , ct] = token.split(":");
      return [version, iv, "", ct].join(":");
    }
  });

  it("still round-trips an empty string and multi-byte text (format unchanged)", () => {
    for (const plaintext of ["", "سونيا الغربي", "Sonia Gharbi — 24 201 314"]) {
      expect(cipher.decrypt(cipher.encrypt(plaintext))).toBe(plaintext);
    }
  });
});
