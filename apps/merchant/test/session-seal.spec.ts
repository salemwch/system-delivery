import { createCipheriv, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { open, seal } from "../src/lib/session-seal";

/**
 * The session cookie's AES-256-GCM sealing (audit finding F3).
 *
 * The cookie carries API bearer tokens. A forged cookie must face the full
 * 128-bit tag, and anything that is not exactly what `seal` produces must open
 * to null, never to partially trusted plaintext.
 */
describe("session seal", () => {
  const key = randomBytes(32);
  const payload = JSON.stringify({ accessToken: "a", refreshToken: "r", userId: "u" });

  function parts(sealed: string): [string, string, string] {
    const [iv, tag, body] = sealed.split(".");
    return [iv ?? "", tag ?? "", body ?? ""];
  }

  function withTag(sealed: string, tag: Buffer): string {
    const [iv, , body] = parts(sealed);
    return [iv, tag.toString("base64url"), body].join(".");
  }

  it("round-trips, with a fresh IV every time", () => {
    const one = seal(payload, key);
    const two = seal(payload, key);
    expect(one).not.toBe(two);
    expect(open(one, key)).toBe(payload);
    expect(open(two, key)).toBe(payload);
  });

  it("round-trips an empty and a multi-byte plaintext", () => {
    // GCM of "" is an empty ciphertext segment; it must still open (the
    // 9318622 RC review found it did not).
    for (const text of ["", "سونيا الغربي — 24 201 314"]) {
      expect(open(seal(text, key), key)).toBe(text);
    }
  });

  it("opens values sealed by the code before the 128-bit pin (compatibility)", () => {
    // The pre-fix seal, verbatim: no `authTagLength`, so Node's default 16-byte
    // tag. Every cookie issued before the fix has exactly this shape.
    function legacySeal(plaintext: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        body.toString("base64url"),
      ].join(".");
    }
    for (const text of ["", payload]) {
      expect(open(legacySeal(text), key)).toBe(text);
    }
  });

  it("seals with a 16-byte tag and a 12-byte IV", () => {
    const [iv, tag] = parts(seal(payload, key));
    expect(Buffer.from(iv, "base64url")).toHaveLength(12);
    expect(Buffer.from(tag, "base64url")).toHaveLength(16);
  });

  it("refuses the GENUINE tag truncated to 4, 8 or 12 bytes", () => {
    // GCM verifies a short tag against the prefix of the real one. Without
    // `authTagLength` Node accepted these: a 2^32 forgery instead of 2^128.
    const sealed = seal(payload, key);
    const genuine = Buffer.from(parts(sealed)[1], "base64url");
    for (const bytes of [4, 8, 12]) {
      expect(open(withTag(sealed, genuine.subarray(0, bytes)), key), `${bytes} bytes`).toBeNull();
    }
  });

  it("refuses a tag of the wrong length or a modified tag", () => {
    const sealed = seal(payload, key);
    const genuine = Buffer.from(parts(sealed)[1], "base64url");
    expect(open(withTag(sealed, Buffer.concat([genuine, Buffer.from([0])])), key)).toBeNull();
    const flipped = Buffer.from(genuine);
    flipped[0] = (flipped[0] ?? 0) ^ 0x01;
    expect(open(withTag(sealed, flipped), key)).toBeNull();
  });

  it("refuses a modified ciphertext", () => {
    const [iv, tag, body] = parts(seal(payload, key));
    const bytes = Buffer.from(body, "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    expect(open([iv, tag, bytes.toString("base64url")].join("."), key)).toBeNull();
  });

  it("refuses a value sealed under another key", () => {
    expect(open(seal(payload, randomBytes(32)), key)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["too few parts", "a.b"],
    ["too many parts", "a.b.c.d"],
    ["characters outside base64url", "AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AA+A"],
    ["padding (not base64url)", "AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==.AAAA"],
    ["an IV of the wrong length", "AAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA"],
  ])("refuses a malformed value: %s", (_label, sealed) => {
    expect(open(sealed, key)).toBeNull();
  });
});
