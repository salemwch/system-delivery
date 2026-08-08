import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { ApiError, apiFetchText } from "@/lib/api";

/**
 * Streams the état colis CSV through the server.
 *
 * A proxy, not a link to the API: the bearer token lives only in the sealed
 * cookie, so the browser cannot fetch the file itself. Sending it there would
 * mean putting an access token in client JavaScript, which is the one thing this
 * app's session design exists to prevent.
 *
 * ⚠️ `content-disposition: attachment` is re-asserted here as well as on the API.
 * Served inline, a browser may sniff the body and render it — and a merchant name
 * containing markup would then execute in the courier's own session. As a
 * download it is never parsed as a document.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const merchantId = url.searchParams.get("merchantId");

  if (from === null || to === null) {
    // The API demands a period; catching it here gives a readable answer rather
    // than a validation error from a request the operator did not make by hand.
    return new NextResponse("A period is required", { status: 400 });
  }

  const query = new URLSearchParams({ from, to });
  if (merchantId !== null && merchantId !== "") {
    query.set("merchantId", merchantId);
  }

  try {
    const csv = await apiFetchText(`/v1/shipments/parcel-state.csv?${query.toString()}`);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="etat-colis-${from}-${to}.csv"`,
        // A report is a snapshot; caching one means exporting last week's
        // numbers under this week's filename.
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return new NextResponse(error.message, { status: error.status });
    }
    throw error;
  }
}
