import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { refresh } from "@/lib/api";
import { toLocale } from "@/lib/i18n";
import { safeReturnPath } from "@/lib/safe-path";
import { clearSession, readSession, writeSession } from "@/lib/session";

/**
 * The ONE place refresh tokens are rotated.
 *
 * A Route Handler, because it is the only server context besides a Server
 * Action that may call `cookies().set()`. Rotating anywhere else spends a
 * single-use token that cannot then be stored, and the API reads the second
 * presentation of a spent token as theft — it revokes the whole family. See the
 * long note in `lib/api.ts` for the lockout that caused.
 *
 * Reached only by redirect from `currentSession()`, never linked. It refreshes,
 * stores the rotated token, and returns the visitor to where they were.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ locale: string }> },
): Promise<NextResponse> {
  const { locale: raw } = await context.params;
  const locale = toLocale(raw);
  const login = new URL(`/${locale}/login`, request.url);

  const session = await readSession();
  if (session === null) {
    return NextResponse.redirect(login);
  }

  const refreshed = await refresh(session);
  if (refreshed === null) {
    // The token was rejected, revoked, or the API is unreachable. Clear the
    // cookie rather than leaving a dead one behind — otherwise the proxy keeps
    // waving the visitor through to pages that can only bounce them back here.
    await clearSession();
    return NextResponse.redirect(login);
  }

  await writeSession(refreshed);

  // `next` is attacker-controlled; `safeReturnPath` keeps this handler from
  // becoming an open redirect aimed at signed-in staff.
  const next = safeReturnPath(request.nextUrl.searchParams.get("next"), `/${locale}`);
  return NextResponse.redirect(new URL(next, request.url));
}
