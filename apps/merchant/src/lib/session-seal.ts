import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM sealing of the session cookie: `iv.tag.ciphertext`, base64url.
 *
 * Pure (key passed in, no Next.js imports) so the cryptography is unit-tested
 * on its own. `session.ts` owns the cookie and the key derivation.
 *
 * ⚠️ The authentication tag is pinned to 128 bits, on both sides. Node accepts
 * GCM tags as short as 32 bits unless `authTagLength` is given, so a forged
 * cookie with a truncated tag faced a far weaker check than the 128 bits the
 * design assumes (audit finding F3, Semgrep `gcm-no-tag-length`). Node
 * deprecated short tags without `authTagLength` in v22 and refuses them from
 * v26: https://nodejs.org/api/crypto.html#deciphersetauthtagbuffer-encoding
 */
const ALGORITHM = "aes-256-gcm";
/** 96-bit nonce, the GCM standard (NIST SP 800-38D §8.2). */
const IV_BYTES = 12;
/** 128-bit tag. The only length this cookie format ever produces or accepts. */
const TAG_BYTES = 16;
/** RFC 4648 §5 alphabet, unpadded. Node's decoder would skip anything else silently. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Encrypts `plaintext` to `iv.tag.ciphertext`. */
export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

/**
 * The plaintext of a sealed value, or null.
 *
 * Fails closed on anything that is not exactly what {@link seal} produces: a
 * wrong part count, a character outside base64url, an IV or tag of the wrong
 * length, a tag that does not verify (tampering), or a different key. The
 * caller learns only "no session", never which check failed.
 */
export function open(sealed: string, key: Buffer): string | null {
  const parts = sealed.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [ivPart, tagPart, bodyPart] = parts;
  if (
    ivPart === undefined ||
    tagPart === undefined ||
    bodyPart === undefined ||
    !BASE64URL.test(ivPart) ||
    !BASE64URL.test(tagPart) ||
    !BASE64URL.test(bodyPart)
  ) {
    return null;
  }
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    return null;
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(bodyPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // `final()` throws when the tag does not verify: tampered, or sealed under
    // a rotated secret. Both mean the same to a caller: no session.
    return null;
  }
}
