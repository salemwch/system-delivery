import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { ApiError, apiFetchText } from "@/lib/api";
import { toLocale } from "@/lib/i18n";

/**
 * Serves the two operational dockets — bon de distribution, bon de paiement.
 *
 * A proxy, not a redirect, for the same reason as the shipment dockets: the API
 * needs a bearer token that lives only in the sealed cookie, so sending the
 * browser there directly would mean putting an access token in client
 * JavaScript — the one thing this app's session design exists to prevent.
 *
 * Separate from `/documents/[id]/[type]` because these hang off different
 * resources: a distribution note belongs to a ROUTE and a payment note to a
 * SETTLEMENT, neither of which is a shipment. Folding them into that route would
 * mean a path claiming a shipment id that is not one.
 */

/**
 * Docket kind → the API path that renders it.
 *
 * A table rather than string interpolation: the kind arrives from the URL, and
 * building a path from it would let any segment through to the API.
 */
const NOTES: Readonly<Record<string, (id: string) => string>> = {
  distribution: (id) => `/v1/routes/${encodeURIComponent(id)}/distribution-note`,
  payment: (id) => `/v1/finance/settlements/${encodeURIComponent(id)}/payment-note`,
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ locale: string; kind: string; id: string }> },
): Promise<NextResponse> {
  const { locale: raw, kind, id } = await context.params;
  const locale = toLocale(raw);

  const path = NOTES[kind];
  if (path === undefined) {
    // Checked here rather than passed through: an unknown kind would otherwise
    // reach the API as a path segment, and its 404 would read as "no such
    // route" when the real problem is the docket name.
    return new NextResponse("Unknown note type", { status: 404 });
  }

  try {
    const html = await apiFetchText(`${path(id)}?locale=${locale}`);
    return new NextResponse(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // A manifest is a snapshot of a live route, and a receipt of a live
        // settlement. Caching either means printing a figure that has since
        // changed.
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      // Pass the status through: 403 means the role lacks the permission, 404
      // means no such route or settlement, and 422 means the route has no
      // driver. Collapsing them would hide which.
      return new NextResponse(error.message, { status: error.status });
    }
    throw error;
  }
}
