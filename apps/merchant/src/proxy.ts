import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";

/**
 * Turns "not signed in" into a redirect, before anything renders.
 *
 * ⚠️ `proxy.ts`, NOT `middleware.ts` — Next 16 renamed the convention.
 *
 * `(portal)/layout.tsx` already redirects on a null session, and that is not
 * enough: Next renders a layout and its page CONCURRENTLY, so the page's first
 * `apiFetch` reaches `readSession()`, gets null, and throws before the
 * layout's `redirect()` lands. The merchant sees a 500 stack trace instead of
 * a login form. Diagnosed in `apps/web`; the same race lives here.
 *
 * ⚠️ PRESENCE, NOT VALIDITY. The cookie is AES-256-GCM sealed and only the
 * server can open it. A forged cookie passes this check and is then rejected
 * by `readSession()`, which stays the authority. This must never be the only
 * thing between a stranger and a merchant's parcels.
 */

const LOCALES = new Set(["ar", "fr", "en"]);
const DEFAULT_LOCALE = "fr";

export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const segments = pathname.split("/").filter((s) => s !== "");
  const first = segments[0];
  const locale = first !== undefined && LOCALES.has(first) ? first : DEFAULT_LOCALE;

  if (segments.length === 0) {
    return NextResponse.redirect(new URL(`/${DEFAULT_LOCALE}`, request.url));
  }

  // The destination of this redirect; sending it here too would loop.
  if (segments[1] === "login") {
    return NextResponse.next();
  }

  if (request.cookies.get(SESSION_COOKIE_NAME) === undefined) {
    return NextResponse.redirect(new URL(`/${locale}/login`, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
