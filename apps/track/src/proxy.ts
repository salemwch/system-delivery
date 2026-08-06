import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { contentSecurityPolicy, newNonce } from "@/lib/csp";

/**
 * Content-Security-Policy, and nothing else.
 *
 * Unlike the staff console and the merchant portal, this app guards no session
 * — the tracking page is public by design, reached with an unguessable token.
 * There is nothing here to authenticate.
 *
 * It exists solely because a CSP with a nonce cannot be a static header: the
 * nonce must be unique per response. The policy previously lived in
 * `next.config.ts` as `script-src 'self'`, which blocked every inline script
 * Next uses to start React. This page has no client components, so the damage
 * was limited to a broken client router and a console full of violations
 * rather than a dead form — but it was the same misconfiguration.
 */

export default function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce);

  // On the REQUEST as well: that is how Next finds the nonce and stamps it on
  // the scripts it generates.
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
