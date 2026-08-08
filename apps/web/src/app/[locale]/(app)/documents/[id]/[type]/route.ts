import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { ApiError, apiFetchText } from "@/lib/api";
import { toLocale } from "@/lib/i18n";

/**
 * Serves a printable docket — bon de livraison, bon d'envoi, bon de retour.
 *
 * A proxy, not a redirect. The API needs a bearer token that lives only in the
 * sealed cookie, so the browser cannot fetch the document itself: sending it
 * there would mean putting an access token in client JavaScript, which is the
 * one thing this app's session design exists to prevent.
 *
 * The document is HTML the API renders (`document.service.ts`) with inline
 * styles and NO scripts, so `style-src 'unsafe-inline'` covers it and nothing
 * executes. It opens in a new tab and the operator prints with Ctrl-P — the
 * markup is already laid out for A4 at 600 dpi.
 */

/** What the API accepts, lower-cased for a readable URL. */
const DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "delivery-note",
  "consignment-note",
  "return-note",
]);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ locale: string; id: string; type: string }> },
): Promise<NextResponse> {
  const { locale: raw, id, type } = await context.params;
  const locale = toLocale(raw);

  // Checked here rather than passed through: an unknown type would otherwise
  // reach the API as a path segment, and a 404 from there reads as "no such
  // shipment" when the real problem is the document name.
  if (!DOCUMENT_TYPES.has(type)) {
    return new NextResponse("Unknown document type", { status: 404 });
  }

  try {
    const html = await apiFetchText(
      `/v1/shipments/${encodeURIComponent(id)}/documents/${type}?locale=${locale}`,
    );
    return new NextResponse(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // A docket is a snapshot of a live shipment. Caching one means printing
        // yesterday's address after a correction — the exact failure the
        // address-correction flow exists to prevent.
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      // Pass the status through: 403 means the role lacks `shipment:label`,
      // 404 means no such shipment. Collapsing them would hide which.
      return new NextResponse(error.message, { status: error.status });
    }
    throw error;
  }
}
