import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { contentSecurityPolicy, newNonce } from "@/lib/csp";
import {
  CSP_HEADER,
  LOCALE_HEADER,
  NONCE_HEADER,
  PATHNAME_HEADER,
  SESSION_COOKIE_NAME,
} from "@/lib/session-cookie";

/**
 * Turns "not signed in" into a redirect, before anything renders.
 *
 * ⚠️ `proxy.ts`, NOT `middleware.ts`. Next 16 renamed the convention and warns
 * on the old filename; `PROXY_FILENAME` in next/dist/lib/constants is now
 * `'proxy'`. Shipping both files is an error, not a fallback.
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
 * The proxy runs BEFORE rendering starts, so there is no race to lose. The
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

export default function proxy(request: NextRequest): NextResponse {
  // A fresh nonce per response. Built here rather than in next.config.ts
  // because a static CSP cannot carry one — and `script-src 'self'` without a
  // nonce blocks every inline script Next uses to hydrate React. See lib/csp.ts.
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce);

  const { pathname } = request.nextUrl;

  const segments = pathname.split("/").filter((s) => s !== "");
  const first = segments[0];
  const locale = first !== undefined && LOCALES.has(first) ? first : DEFAULT_LOCALE;

  /*
   * Forwarded to the render:
   *  - locale and path, because a Server Component cannot learn its own URL and
   *    `currentSession()` needs both to redirect an expired session somewhere
   *    useful;
   *  - the CSP itself, which is how Next discovers the nonce and stamps it on
   *    the inline scripts it emits. Without this header on the REQUEST, Next
   *    generates unnonced scripts and the browser blocks them even though the
   *    response header names a nonce.
   */
  const headers = new Headers(request.headers);
  headers.set(LOCALE_HEADER, locale);
  headers.set(PATHNAME_HEADER, pathname + request.nextUrl.search);
  headers.set(NONCE_HEADER, nonce);
  headers.set(CSP_HEADER, csp);

  const proceed = (): NextResponse => withCsp(NextResponse.next({ request: { headers } }), csp);
  const goTo = (path: string): NextResponse =>
    withCsp(NextResponse.redirect(new URL(path, request.url)), csp);

  // A visitor landing on "/" has not chosen a language yet.
  if (segments.length === 0) {
    return goTo(`/${DEFAULT_LOCALE}`);
  }

  // The login page is the destination of this redirect; sending it here too
  // would be a loop.
  if (segments[1] === "login") {
    return proceed();
  }

  // The refresh route must run even though the session it carries is expired —
  // renewing it is the entire job. It re-checks the cookie itself and redirects
  // to login when there is nothing to renew.
  if (segments[1] === "session") {
    return proceed();
  }

  if (request.cookies.get(SESSION_COOKIE_NAME) === undefined) {
    return goTo(`/${locale}/login`);
  }

  return proceed();
}

/** Applies the policy to a response. Every path returns one — a page with no CSP is worse than a wrong one. */
function withCsp(response: NextResponse, csp: string): NextResponse {
  response.headers.set(CSP_HEADER, csp);
  return response;
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
