import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Authenticated field-level encryption for PII at rest
 * (docs/07-security-architecture.md §6).
 *
 * AES-256-GCM: confidentiality plus integrity, so a tampered ciphertext fails to
 * decrypt rather than silently returning garbage. Each value gets a fresh random
 * 96-bit IV — reusing an IV under one key is catastrophic for GCM, so we never do.
 *
 * The token format is `v1:<iv>:<tag>:<ciphertext>`, each part base64. The `v1`
 * prefix makes key rotation and algorithm changes a forward-compatible decision
 * rather than an ambiguous blob. This class is pure (key in the constructor) so it
 * is trivially unit-testable; the Nest wiring that reads the key from config lives
 * in `crypto.module.ts`.
 */

const VERSION = "v1";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard.
const KEY_BYTES = 32; // AES-256.
/**
 * 128-bit authentication tag, pinned on both sides.
 *
 * ⚠️ Node accepts GCM tags as short as 32 bits unless `authTagLength` is given,
 * so a forged token with a truncated tag faced a far weaker integrity check
 * than designed (audit finding F3, Semgrep `gcm-no-tag-length`). Node
 * deprecated that in v22 and refuses it from v26:
 * https://nodejs.org/api/crypto.html#deciphersetauthtagbuffer-encoding
 */
const TAG_BYTES = 16;

export class FieldCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`FieldCipher key must be ${KEY_BYTES} bytes, received ${key.length}.`);
    }
    // Copy so an external mutation of the caller's buffer cannot change our key.
    this.key = Buffer.from(key);
  }

  /** Encrypts UTF-8 plaintext to a `v1:<iv>:<tag>:<ct>` token. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv, { authTagLength: TAG_BYTES });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, b64(iv), b64(tag), b64(ciphertext)].join(":");
  }

  /**
   * Decrypts a token produced by {@link encrypt}. Throws on a malformed token, an
   * unknown version, or a failed authentication tag (tampering) — never returns a
   * partial or unverified plaintext.
   */
  decrypt(token: string): string {
    const parts = token.split(":");
    if (parts.length !== 4) {
      throw new Error("FieldCipher: malformed token.");
    }
    const [version, ivB64, tagB64, ctB64] = parts;
    if (version !== VERSION) {
      throw new Error(`FieldCipher: unsupported token version "${version ?? ""}".`);
    }
    const iv = fromB64(ivB64);
    const tag = fromB64(tagB64);
    const ciphertext = fromB64(ctB64);
    if (iv.length !== IV_BYTES) {
      throw new Error("FieldCipher: bad IV length.");
    }
    // Checked before Node sees it, so the refusal is ours and uniform; the
    // option below makes Node enforce the same length as a second guard.
    if (tag.length !== TAG_BYTES) {
      throw new Error("FieldCipher: bad authentication tag length.");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  /** Encrypts `value` when present, passing through `null`/`undefined` unchanged. */
  encryptOptional(value: string | null | undefined): string | null {
    return value === null || value === undefined ? null : this.encrypt(value);
  }

  /** Decrypts `token` when present, passing through `null` unchanged. */
  decryptOptional(token: string | null | undefined): string | null {
    return token === null || token === undefined ? null : this.decrypt(token);
  }

  /**
   * Constant-time equality of two tokens' PLAINTEXTS, without exposing them. Used
   * for the rare "does this ciphertext match this input" check (e.g. a duplicate
   * national-id guard) without a timing side channel.
   */
  plaintextEquals(token: string, candidate: string): boolean {
    const a = Buffer.from(this.decrypt(token), "utf8");
    const b = Buffer.from(candidate, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

function b64(buffer: Buffer): string {
  return buffer.toString("base64");
}

/** RFC 4648 §4, padded: exactly what {@link b64} writes. Empty is valid (empty plaintext). */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function fromB64(value: string | undefined): Buffer {
  if (value === undefined) {
    throw new Error("FieldCipher: missing token segment.");
  }
  // Node's decoder silently skips characters outside the alphabet, so a
  // mangled segment would decode to *something*. Refuse it instead.
  if (!BASE64.test(value)) {
    throw new Error("FieldCipher: malformed token segment.");
  }
  return Buffer.from(value, "base64");
}
