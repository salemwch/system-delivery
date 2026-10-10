import { scryptSync } from "node:crypto";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { isProduction, sessionSecret } from "./config";
import { SESSION_COOKIE_NAME } from "./session-cookie";
import { open, seal } from "./session-seal";

/**
 * The staff session, held in an ENCRYPTED, httpOnly cookie.
 *
 * Same AES-256-GCM construction as the merchant portal, with two additions:
 *  - `roles` and `permissions` arrays for role-based UI rendering
 *  - Different cookie name and session secret (WEB_SESSION_SECRET)
 *
 * The access token never reaches browser JavaScript.
 */

const COOKIE_NAME = SESSION_COOKIE_NAME;
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const KEY_SALT = "delivery-web-session";

export interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly expiresAt: number;
}

function key(): Buffer {
  return scryptSync(sessionSecret(), KEY_SALT, 32);
}

/** The session sealed with AES-256-GCM and a 128-bit tag (see session-seal.ts). */
function sealSession(session: Session): string {
  return seal(JSON.stringify(session), key());
}

function openSession(value: string): Session | null {
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

/**
 * The session, or a redirect to sign in.
 *
 * The `(app)` layout already refuses anonymous access, so a null here means the
 * cookie expired between that render and this page's own read. Redirecting is
 * the honest response — the next useful thing this person can do is sign in —
 * and it keeps every page that needs permissions from restating the guard.
 */
export async function requireSession(locale: string): Promise<Session> {
  const session = await readSession();
  if (session === null) {
    redirect(`/${locale}/login`);
  }
  return session;
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

/** Whether the current session holds a given permission. */
export function hasPermission(session: Session, permission: string): boolean {
  return session.permissions.includes(permission);
}
