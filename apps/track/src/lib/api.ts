import { apiBaseUrl } from "./config";

/**
 * The one call this app makes: `GET /v1/track/:tenantSlug/:trackingNumber`.
 *
 * Runs on the SERVER only. The API base URL is a server-side environment
 * variable rather than a `NEXT_PUBLIC_` one, so the browser never learns the
 * API's address and the tracking token is never handled by client JavaScript —
 * it goes from the URL to the server and no further.
 */

/** One visible step in the parcel's history. */
interface TimelineEntry {
  readonly type: string;
  readonly occurredAt: string;
}

/**
 * Exactly what the public endpoint returns.
 *
 * ⚠️ Note what is ABSENT: no surname, no phone number, no address, no driver
 * identity, no live position. Anyone holding the link sees this page
 * (docs/07 §2.2), so the endpoint returns the minimum a recipient needs to
 * recognise their own parcel and nothing that would harm them if the link were
 * forwarded.
 */
export interface TrackingView {
  readonly courierName: string;
  readonly trackingNumber: string;
  readonly status: string;
  readonly statusLabel: Record<string, string>;
  readonly recipientFirstName: string;
  readonly codAmountMinor: number;
  readonly currency: string;
  readonly currencyExponent: number;
  readonly promisedFrom: string | null;
  readonly promisedTo: string | null;
  readonly timeline: readonly TimelineEntry[];
  readonly createdAt: string;
}

/**
 * Why a lookup failed, when it did.
 *
 * `expired` and `not-found` are told apart deliberately — they need different
 * advice. An expired link means "ask your sender for a new one"; a wrong link
 * means "check the SMS". Collapsing them sends people to the wrong remedy, and
 * neither reveals whether a parcel exists.
 */
export type TrackingFailure = "not-found" | "expired" | "unavailable";

export type TrackingResult =
  | { readonly ok: true; readonly view: TrackingView }
  | { readonly ok: false; readonly failure: TrackingFailure };

/** Bounded so a slow API cannot hold a recipient's page open indefinitely. */
const REQUEST_TIMEOUT_MS = 5_000;

export async function fetchTracking(
  tenantSlug: string,
  trackingNumber: string,
  token: string,
): Promise<TrackingResult> {
  const url =
    `${apiBaseUrl()}/v1/track/` +
    `${encodeURIComponent(tenantSlug)}/${encodeURIComponent(trackingNumber)}` +
    `?token=${encodeURIComponent(token)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // A parcel's status changes while someone is looking at the page. Caching
      // it would show a delivered parcel as still out for delivery, which is the
      // one thing this page exists to get right.
      cache: "no-store",
    });
  } catch {
    return { ok: false, failure: "unavailable" };
  }

  if (response.status === 403) {
    // The API answers 403 for an expired, tampered, or mismatched token — one
    // response for all three, so the page cannot be used to probe which tracking
    // numbers exist.
    return { ok: false, failure: "expired" };
  }
  if (response.status === 404) {
    return { ok: false, failure: "not-found" };
  }
  if (!response.ok) {
    return { ok: false, failure: "unavailable" };
  }

  const parsed: unknown = await response.json();
  if (!isTrackingView(parsed)) {
    // A response that does not match the contract is treated as an outage, not
    // rendered half-empty: a page missing its COD amount is worse than a page
    // that says "try again".
    return { ok: false, failure: "unavailable" };
  }
  return { ok: true, view: parsed };
}

/**
 * Validates the response shape before rendering it.
 *
 * The API is trusted, but it is still a network boundary and this page renders
 * money. A field that silently arrives as `undefined` would print "NaN" beside a
 * currency code on a recipient's phone.
 */
function isTrackingView(value: unknown): value is TrackingView {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v["courierName"] === "string" &&
    typeof v["trackingNumber"] === "string" &&
    typeof v["status"] === "string" &&
    typeof v["recipientFirstName"] === "string" &&
    typeof v["codAmountMinor"] === "number" &&
    typeof v["currency"] === "string" &&
    typeof v["currencyExponent"] === "number" &&
    typeof v["createdAt"] === "string" &&
    Array.isArray(v["timeline"])
  );
}
