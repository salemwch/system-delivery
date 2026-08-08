import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { ApiError, apiFetchText } from "@/lib/api";
import { toLocale } from "@/lib/i18n";

/**
 * Serves the printable facture / avoir.
 *
 * A proxy, not a redirect — the same reason as the delivery dockets. The API
 * needs a bearer token that lives only in the sealed cookie, so sending the
 * browser straight there would mean putting an access token in client
 * JavaScript, which is the one thing this app's session design exists to
 * prevent.
 *
 * The API renders self-contained HTML with inline styles and NO scripts, so
 * `style-src 'unsafe-inline'` covers it and nothing executes. The operator
 * prints with Ctrl-P; the markup is already laid out for A4.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ locale: string; id: string }> },
): Promise<NextResponse> {
  const { locale: raw, id } = await context.params;
  const locale = toLocale(raw);

  try {
    const html = await apiFetchText(
      `/v1/invoices/${encodeURIComponent(id)}/document?locale=${locale}`,
    );
    return new NextResponse(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // A draft changes as it is edited, and an issued invoice may be
        // reprinted after a credit note is raised against it. Neither benefits
        // from a cache, and a stale invoice in a customer's hands is a dispute.
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      // Pass the status through: 403 means the role lacks `invoice:read`, 404
      // means no such invoice — or one outside this caller's RLS scope.
      // Collapsing them would hide which.
      return new NextResponse(error.message, { status: error.status });
    }
    throw error;
  }
}
