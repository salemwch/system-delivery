import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { isProduction, sessionSecret } from "./config";

/**
 * The staff session, held in an ENCRYPTED, httpOnly cookie.
 *
 * Same AES-256-GCM construction as the merchant portal, with two additions:
 *  - `roles` and `permissions` arrays for role-based UI rendering
 *  - Different cookie name and session secret (WEB_SESSION_SECRET)
 *
 * The access token never reaches browser JavaScript.
 */

const COOKIE_NAME = "web_session";
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

/** Whether the current session holds a given permission. */
export function hasPermission(session: Session, permission: string): boolean {
  return session.permissions.includes(permission);
}

