"use server";

import { randomUUID } from "node:crypto";

import { redirect } from "next/navigation";
import { z } from "zod";

import { ApiError, apiFetch, login as apiLogin } from "./api";
import { parseMoney } from "./format";
import { toLocale } from "./i18n";
import { clearSession, writeSession } from "./session";
import type { FormState } from "./form-state";

/**
 * Server actions — every mutation the portal performs.
 *
 * ⚠️ These run on the SERVER. The browser posts a form; the token, the API
 * address and the validation all stay here. That is what keeps a bearer token
 * out of client JavaScript entirely.
 *
 * Next's server actions are POST-only and origin-checked, which covers CSRF for
 * the same reason `sameSite: "lax"` does: a cross-site form cannot invoke them.
 */

const loginSchema = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(200),
});

export async function signIn(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: {} };
  }

  try {
    const session = await apiLogin(parsed.data.email, parsed.data.password);
    await writeSession(session);
  } catch (error) {
    // ⚠️ ONE message for every failure — wrong password, unknown email, locked
    // account. Distinguishing them turns the login form into an oracle for which
    // email addresses exist.
    if (error instanceof ApiError) {
      return { error: "invalid", fieldErrors: {} };
    }
    throw error;
  }

  // Outside the try: `redirect` works by throwing, and catching it here would
  // swallow the navigation and report a login failure after a successful one.
  redirect(`/${toLocale(locale)}`);
}

export async function signOut(locale: string): Promise<void> {
  await clearSession();
  redirect(`/${toLocale(locale)}/login`);
}

/**
 * The create-shipment form.
 *
 * Validated here as well as by the API — not instead of it. The API's schema is
 * the authority; this exists so a merchant sees "phone must start with +216"
 * beside the field rather than a generic failure after a round trip.
 */
const createSchema = z.object({
  recipientName: z.string().trim().min(1, "required").max(200),
  recipientPhone: z
    .string()
    .trim()
    .transform((value) => value.replace(/[\s-]/gu, ""))
    .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/u, "format")),
  addressLine: z.string().trim().min(1, "required").max(500),
  city: z.string().trim().max(120).optional(),
  codAmount: z.string().trim().max(30).optional(),
  weightGrams: z.coerce.number().int().min(0).max(1_000_000).optional(),
  parcelCount: z.coerce.number().int().min(1).max(100).optional(),
  notes: z.string().trim().max(500).optional(),
});

interface CreatedShipment {
  readonly id: string;
}

export async function createShipment(
  locale: string,
  currencyExponent: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = createSchema.safeParse({
    recipientName: formData.get("recipientName"),
    recipientPhone: formData.get("recipientPhone"),
    addressLine: formData.get("addressLine"),
    city: formData.get("city") || undefined,
    codAmount: formData.get("codAmount") || undefined,
    weightGrams: formData.get("weightGrams") || undefined,
    parcelCount: formData.get("parcelCount") || undefined,
    notes: formData.get("notes") || undefined,
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string") {
        fieldErrors[field] = issue.message;
      }
    }
    return { error: "validation", fieldErrors };
  }

  const input = parsed.data;

  // ⚠️ Parsed with the currency's OWN exponent. A merchant types "12,500" or
  // "12.500" for the same TND amount; both are accepted, and the exponent — not
  // a hardcoded 100 — decides the scale.
  let codAmountMinor = 0;
  if (input.codAmount !== undefined && input.codAmount !== "") {
    const amount = parseMoney(input.codAmount, currencyExponent);
    if (amount === null) {
      return { error: "validation", fieldErrors: { codAmount: "format" } };
    }
    codAmountMinor = amount;
  }

  const address = {
    rawInput: [input.addressLine, input.city].filter(Boolean).join(", "),
    countryCode: "TN",
    ...(input.city === undefined ? {} : { city: input.city }),
    ...(input.notes === undefined ? {} : { accessNotes: input.notes }),
  };

  let created: CreatedShipment;
  try {
    created = await apiFetch<CreatedShipment>("/v1/shipments", {
      method: "POST",
      // A key per submission, so a double-tapped button — or a retry over a
      // flaky mobile connection — creates ONE parcel.
      idempotencyKey: randomUUID(),
      body: {
        idempotencyKey: randomUUID(),
        recipientName: input.recipientName,
        recipientPhone: input.recipientPhone,
        // The merchant IS the sender. The API resolves the merchant from the
        // token's scope, so nothing here can create a parcel "for" someone else.
        senderName: input.recipientName,
        senderPhone: input.recipientPhone,
        origin: address,
        destination: address,
        currency: "TND",
        codAmountMinor,
        ...(input.weightGrams === undefined ? {} : { weightGrams: input.weightGrams }),
        ...(input.parcelCount === undefined ? {} : { parcelCount: input.parcelCount }),
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  redirect(`/${toLocale(locale)}/shipments/${created.id}?created=1`);
}

const cancelSchema = z.object({
  shipmentId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});

export async function cancelShipment(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = cancelSchema.safeParse({
    shipmentId: formData.get("shipmentId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: { reason: "required" } };
  }

  try {
    await apiFetch(`/v1/shipments/${parsed.data.shipmentId}/cancel`, {
      method: "POST",
      idempotencyKey: randomUUID(),
      body: { idempotencyKey: randomUUID(), reason: parsed.data.reason },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      // A parcel already picked up cannot be cancelled by a merchant — the API
      // says so, and the message is worth showing verbatim rather than hiding.
      return { error: error.code, fieldErrors: {} };
    }
    throw error;
  }

  redirect(`/${toLocale(locale)}/shipments/${parsed.data.shipmentId}`);
}
