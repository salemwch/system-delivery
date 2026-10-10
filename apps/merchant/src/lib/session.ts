import { scryptSync } from "node:crypto";

import { cookies } from "next/headers";

import { isProduction, sessionSecret } from "./config";
import { SESSION_COOKIE_NAME } from "./session-cookie";
import { open, seal } from "./session-seal";

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

const COOKIE_NAME = SESSION_COOKIE_NAME;

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

/** `iv.tag.ciphertext`, all base64url, 128-bit tag (see session-seal.ts). */
function sealSession(session: Session): string {
  return seal(JSON.stringify(session), key());
}

function openSession(value: string): Session | null {
  // Tampered, truncated, or encrypted under a rotated secret: all null here.
  const plain = open(value, key());
  if (plain === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(plain);
    return isSession(parsed) ? parsed : null;
  } catch {
    // Authentic but not JSON: only possible if the format ever changed under
    // the same secret. Treated as no session, like every other bad cookie.
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
  return raw === undefined ? null : openSession(raw);
}

export async function writeSession(session: Session): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, sealSession(session), {
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
