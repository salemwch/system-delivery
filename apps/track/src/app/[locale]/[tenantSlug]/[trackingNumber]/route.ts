import { fetchTracking } from "@/lib/api";
import { supportPhone, timezone } from "@/lib/config";
import { toLocale } from "@/lib/i18n";
import { renderFailurePage, renderTrackingPage } from "@/lib/render";

/**
 * The public tracking page (docs/08-frontend-architecture.md §7).
 *
 * ⚠️ A ROUTE HANDLER, not a React page, and the difference is the entire
 * performance budget. As a server component this route still shipped **136 KB of
 * gzipped JavaScript** — Next's client runtime, sent to hydrate a document with
 * no interactivity whatsoever. Returning a `Response` skips React entirely and
 * ships **zero bytes of JavaScript**, against a budget of <100 KB (docs/08 §9).
 *
 * Next still earns its place: routing, the security headers in `next.config.ts`,
 * and a separate deployable with its own CSP and rate limits (docs/07 §2.2). It
 * simply is not asked to hydrate a page that has nothing to hydrate.
 *
 * ⚠️ THE MOST EXPOSED SURFACE IN THE SYSTEM. Anyone holding the link sees it, so
 * it renders a first name and nothing else identifying — no surname, no phone,
 * no address, no driver, no live map. That restraint is enforced by what the API
 * returns, not by this handler choosing what to display.
 */

/** Never prerendered: a parcel's status changes while someone is looking at it. */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ locale: string; tenantSlug: string; trackingNumber: string }> },
): Promise<Response> {
  const { locale: rawLocale, tenantSlug, trackingNumber } = await context.params;
  const locale = toLocale(rawLocale);
  const token = new URL(request.url).searchParams.get("token") ?? "";

  if (token === "") {
    return html(renderFailurePage(locale, "not-found"), 404);
  }

  const result = await fetchTracking(tenantSlug, trackingNumber, token);
  if (!result.ok) {
    // 404 for a missing parcel, 403 for a bad or expired token — the status codes
    // the API itself used, so a caching layer treats them correctly.
    return html(
      renderFailurePage(locale, result.failure),
      result.failure === "expired" ? 403 : 404,
    );
  }

  return html(
    renderTrackingPage({
      view: result.view,
      locale,
      tenantSlug,
      trackingNumber,
      token,
      timezone: timezone(),
      supportPhone: supportPhone(),
    }),
    200,
  );
}

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // A parcel's status changes underneath the reader. Caching this would show
      // a delivered parcel as still out for delivery — the one thing the page
      // exists to get right. `private` also keeps a shared proxy from storing a
      // page that is specific to one recipient's token.
      "cache-control": "no-store, private",
    },
  });
}
