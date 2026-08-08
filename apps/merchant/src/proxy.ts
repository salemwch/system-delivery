import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { contentSecurityPolicy, newNonce } from "@/lib/csp";
import { CSP_HEADER, NONCE_HEADER, SESSION_COOKIE_NAME } from "@/lib/session-cookie";

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
  // A fresh nonce per response. `script-src 'self'` with no nonce blocks every
  // inline script Next uses to hydrate React — the page renders and then does
  // nothing. See lib/csp.ts.
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce);

  const { pathname } = request.nextUrl;

  const segments = pathname.split("/").filter((s) => s !== "");
  const first = segments[0];
  const locale = first !== undefined && LOCALES.has(first) ? first : DEFAULT_LOCALE;

  // The CSP goes on the REQUEST too: that is how Next finds the nonce and
  // stamps it on the scripts it generates.
  const headers = new Headers(request.headers);
  headers.set(NONCE_HEADER, nonce);
  headers.set(CSP_HEADER, csp);

  const proceed = (): NextResponse => withCsp(NextResponse.next({ request: { headers } }), csp);
  const goTo = (path: string): NextResponse =>
    withCsp(NextResponse.redirect(new URL(path, request.url)), csp);

  if (segments.length === 0) {
    return goTo(`/${DEFAULT_LOCALE}`);
  }

  // The destination of the redirect below — sending it there too would loop —
  // and the application form, which is unauthenticated BY DESIGN: it is how a
  // shipper who has no account asks for one.
  if (segments[1] === "login" || segments[1] === "register") {
    return proceed();
  }

  if (request.cookies.get(SESSION_COOKIE_NAME) === undefined) {
    return goTo(`/${locale}/login`);
  }

  return proceed();
}

/** Applies the policy to a response. Every path returns one. */
function withCsp(response: NextResponse, csp: string): NextResponse {
  response.headers.set(CSP_HEADER, csp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
