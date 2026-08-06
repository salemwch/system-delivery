import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";

/**
 * Turns "not signed in" into a redirect, before anything renders.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AND THE LAYOUT CHECK IS NOT ENOUGH
 *
 * `(app)/layout.tsx` already redirects when there is no session. It is not
 * sufficient, because Next renders a layout and its page CONCURRENTLY: the
 * page's first `apiFetch` reached `readSession()`, got null, and threw
 * `NotAuthenticatedError` before the layout's `redirect()` could take effect.
 * The visitor got a 500 stack trace instead of a login form.
 *
 * Middleware runs BEFORE rendering starts, so there is no race to lose. The
 * layout check stays as defence in depth — this file only inspects a cookie's
 * presence and must never be the only thing standing between a stranger and
 * the data.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ PRESENCE, NOT VALIDITY. The cookie is AES-256-GCM sealed and only the
 * server can open it. Middleware deliberately does not try: a forged or expired
 * cookie passes this check and is then rejected by `readSession()`, which is
 * the authority. Treating this as authentication would be a hole.
 */

const LOCALES = new Set(["ar", "fr", "en"]);
const DEFAULT_LOCALE = "fr";

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const segments = pathname.split("/").filter((s) => s !== "");
  const first = segments[0];
  const locale = first !== undefined && LOCALES.has(first) ? first : DEFAULT_LOCALE;

  // A visitor landing on "/" has not chosen a language yet.
  if (segments.length === 0) {
    return NextResponse.redirect(new URL(`/${DEFAULT_LOCALE}`, request.url));
  }

  // The login page is the destination of this redirect; sending it here too
  // would be a loop.
  if (segments[1] === "login") {
    return NextResponse.next();
  }

  if (request.cookies.get(SESSION_COOKIE_NAME) === undefined) {
    return NextResponse.redirect(new URL(`/${locale}/login`, request.url));
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Everything except Next's own assets and the favicon.
   *
   * `_next/static` and `_next/image` are public by construction, and running
   * this on them would add a cookie read to every asset request. The favicon is
   * excluded because a browser fetches it while unauthenticated and a redirect
   * there produced the stray 307s in the dev log.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
