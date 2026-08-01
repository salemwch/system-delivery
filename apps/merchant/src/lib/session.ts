import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { cookies } from "next/headers";

import { isProduction, sessionSecret } from "./config";

/**
 * The merchant's session, held in an ENCRYPTED, httpOnly cookie.
 *
 * ⚠️ THE ACCESS TOKEN NEVER REACHES THE BROWSER'S JAVASCRIPT. Every design here
 * follows from that:
 *
 *  - `httpOnly`, so no script can read it — the difference between an XSS that
 *    defaces a page and one that exfiltrates a session.
 *  - **Encrypted**, not merely signed. A signed cookie is readable by anyone
 *    holding it; this one carries API bearer tokens, and a cookie sitting in a
 *    shared browser profile or a proxy log should not hand them over.
 *  - `sameSite: "lax"`, which blocks the cross-site POST that CSRF depends on
 *    while still allowing a merchant to follow a link into the portal.
 *  - `secure` in production. Omitted locally only because localhost is not HTTPS.
 *
 * AES-256-GCM: the same construction as the API's `FieldCipher`, and authenticated
 * — a tampered cookie fails to decrypt rather than decrypting to something
 * attacker-chosen.
 */

const COOKIE_NAME = "merchant_session";

/** Matches the refresh-token lifetime, so a session outlives its access token. */
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** Fixed salt: the secret is already high-entropy, and a per-cookie salt would have to travel with it. */
const KEY_SALT = "delivery-merchant-session";

export interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  /** Epoch millis. Used to refresh BEFORE a request fails, not after. */
  readonly expiresAt: number;
}

function key(): Buffer {
  return scryptSync(sessionSecret(), KEY_SALT, 32);
}

/** `iv.tag.ciphertext`, all base64url — one opaque string to the browser. */
function seal(session: Session): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

function open(value: string): Session | null {
  const parts = value.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [ivPart, tagPart, bodyPart] = parts;
  if (ivPart === undefined || tagPart === undefined || bodyPart === undefined) {
    return null;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(bodyPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(plain);
    return isSession(parsed) ? parsed : null;
  } catch {
    // Tampered, truncated, or encrypted under a rotated secret. All mean the
    // same thing to a caller: no session.
    return null;
  }
}

function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v["accessToken"] === "string" &&
    typeof v["refreshToken"] === "string" &&
    typeof v["tenantId"] === "string" &&
    typeof v["userId"] === "string" &&
    typeof v["expiresAt"] === "number" &&
    Array.isArray(v["roles"]) &&
    Array.isArray(v["permissions"])
  );
}

export async function readSession(): Promise<Session | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  return raw === undefined ? null : open(raw);
}

export async function writeSession(session: Session): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, seal(session), {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
