"use server";

import { z } from "zod";

import { apiBaseUrl, tenantSlug } from "./config";
import { IDLE_APPLICATION } from "./application-state";
import type { ApplicationState } from "./application-state";
import { toE164 } from "./phone";

/**
 * The account application — how a shipper with no login asks for one.
 *
 * ⚠️ THE ONLY UNAUTHENTICATED WRITE THIS PORTAL MAKES. It deliberately does not
 * go through `apiFetch`, which requires a session and would refuse: there is no
 * merchant yet, that being the entire point. A bare `fetch` with the tenant slug
 * in the path is the same shape `courierName` already uses.
 *
 * ⚠️ THE RESULT NEVER VARIES WITH WHAT THE COURIER ALREADY KNOWS. A second
 * application from a number that already has one pending returns success, from
 * the API upwards, because an anonymous form that said "you already applied"
 * would be a way to test whether a phone number is known to this courier. The
 * only failure a caller can observe is a malformed submission or the flood cap.
 */

const REQUEST_TIMEOUT_MS = 10_000;

function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

function optional(formData: FormData, field: string): string | undefined {
  const value = text(formData, field).trim();
  return value === "" ? undefined : value;
}

const applicationSchema = z.object({
  businessName: z.string().trim().min(1, "required").max(200),
  contactName: z.string().trim().min(1, "required").max(200),
  // Normalised, not merely validated. A Tunisian types 24201314 and the API
  // takes E.164 only; refusing the form over a format nobody outside this
  // codebase has heard of would lose the applicant.
  contactPhone: z
    .string()
    .trim()
    .transform(toE164)
    .refine((value) => value !== null, "invalid"),
  contactEmail: z.email().max(254).optional(),
  city: z.string().trim().max(120).optional(),
  addressLine: z.string().trim().max(500).optional(),
  expectedVolume: z.coerce.number().int().min(0).max(1_000_000).optional(),
  message: z.string().trim().max(2000).optional(),
});

export async function submitApplication(
  _previous: ApplicationState,
  formData: FormData,
): Promise<ApplicationState> {
  const parsed = applicationSchema.safeParse({
    businessName: text(formData, "businessName"),
    contactName: text(formData, "contactName"),
    contactPhone: text(formData, "contactPhone"),
    ...spread("contactEmail", optional(formData, "contactEmail")),
    ...spread("city", optional(formData, "city")),
    ...spread("addressLine", optional(formData, "addressLine")),
    ...spread("expectedVolume", optional(formData, "expectedVolume")),
    ...spread("message", optional(formData, "message")),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && fieldErrors[field] === undefined) {
        fieldErrors[field] = issue.message;
      }
    }
    return { ...IDLE_APPLICATION, error: "validation", fieldErrors };
  }

  let response: Response;
  try {
    response = await fetch(
      `${apiBaseUrl()}/v1/merchant-applications/public/${encodeURIComponent(tenantSlug())}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // Never cached: this is a write, and a cached POST would silently drop
        // the second applicant.
        cache: "no-store",
      },
    );
  } catch {
    // A timeout or a DNS failure. Deliberately not the API's message — there
    // isn't one — and deliberately not a stack trace on a public page.
    return { ...IDLE_APPLICATION, error: "network" };
  }

  if (!response.ok) {
    // 429-shaped: the flood cap. Anything else is a bug on our side, and both
    // are reported the same way, because an applicant can act on neither.
    return {
      ...IDLE_APPLICATION,
      error: response.status === 429 ? "rateLimited" : "failed",
    };
  }

  // ⚠️ `sent` for a duplicate too. The API answers 202 whether or not this phone
  // already applied, and this must not undo that by inferring anything.
  return { status: "sent", error: null, fieldErrors: {} };
}

/** Spread-friendly optional field — `exactOptionalPropertyTypes` forbids `undefined`. */
function spread(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}
