"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { fieldErrorsFrom } from "./form-state";
import type { CredentialState, FormState } from "./form-state";
import { toLocale } from "./i18n";

/**
 * The write surface a commercial needs: sign an *expéditeur* up, give them
 * their portal login, and (for an OWNER) move the account between commercials.
 *
 * Every action here is a Next.js server action, so the bearer token stays on
 * the server and the browser posts to a route it cannot forge a token for. None
 * of them checks a permission: the API is the boundary, and duplicating the
 * check here would only produce a second place for it to drift. The UI hides
 * what a role cannot do; the server refuses it.
 */

const createMerchantSchema = z.object({
  name: z.string().trim().min(1, "required").max(200),
  code: z.string().trim().max(50).optional(),
  contactName: z.string().trim().max(200).optional(),
  contactPhone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/u, "e164")
    .optional(),
  contactEmail: z.email("format").optional(),
  /**
   * The shop's address. Optional in the form, but a merchant registered
   * without one cannot have a pickup requested for them — the API requires a
   * `pickupAddressId` and there is no address endpoint to add one afterwards.
   */
  addressLine: z.string().trim().max(500).optional(),
  city: z.string().trim().max(200).optional(),
});

interface CreatedMerchant {
  readonly id: string;
}

/** Reads a form field, treating "" as absent so optional inputs stay optional. */
function optional(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export async function createMerchant(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = createMerchantSchema.safeParse({
    name: formData.get("name"),
    code: optional(formData, "code"),
    contactName: optional(formData, "contactName"),
    contactPhone: optional(formData, "contactPhone"),
    contactEmail: optional(formData, "contactEmail"),
    addressLine: optional(formData, "addressLine"),
    city: optional(formData, "city"),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  const { addressLine, city, ...merchant } = parsed.data;

  let created: CreatedMerchant;
  try {
    created = await apiFetch<CreatedMerchant>("/v1/merchants", {
      method: "POST",
      // One key per submission, so a double-tapped button on a phone in a shop
      // registers ONE merchant.
      idempotencyKey: randomUUID(),
      body: {
        ...merchant,
        // The API resolves and geocodes this into an `addresses` row and points
        // `defaultPickupAddressId` at it. Omitted entirely when blank — sending
        // an empty rawInput would store a useless address rather than none.
        ...(addressLine === undefined
          ? {}
          : {
              pickupAddress: {
                rawInput: [addressLine, city].filter(Boolean).join(", "),
                countryCode: "TN",
                ...(city === undefined ? {} : { city }),
              },
            }),
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  // A commercial who created it is already its account manager — set from their
  // verified role claim by the API, never sent from here.
  redirect(`/${toLocale(locale)}/merchants/${created.id}?created=1`);
}

const portalLoginSchema = z.object({
  merchantId: z.uuid(),
  email: z.email("format").max(254),
  fullName: z.string().trim().min(1, "required").max(200),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/u, "e164")
    .optional(),
});

interface CreatedLogin {
  readonly user: { readonly email: string };
  readonly temporaryPassword: string | null;
}

/**
 * Mints the merchant's portal login and returns the password ONCE.
 *
 * The password is returned in the action's result and nowhere else — not
 * persisted, not re-fetchable, not in the URL. The commercial reads it out to
 * the *expéditeur* standing in front of them, and if it is lost the only way
 * back in is a reset by an OWNER.
 */
export async function createPortalLogin(
  _previous: CredentialState,
  formData: FormData,
): Promise<CredentialState> {
  const parsed = portalLoginSchema.safeParse({
    merchantId: formData.get("merchantId"),
    email: formData.get("email"),
    fullName: formData.get("fullName"),
    phone: optional(formData, "phone"),
  });
  if (!parsed.success) {
    return {
      error: "validation",
      fieldErrors: fieldErrorsFrom(parsed.error),
      credential: null,
    };
  }

  try {
    const created = await apiFetch<CreatedLogin>("/v1/users/merchant-login", {
      method: "POST",
      idempotencyKey: randomUUID(),
      body: parsed.data,
    });
    if (created.temporaryPassword === null) {
      // Unreachable: this endpoint never accepts a caller-chosen password, so
      // the server always generates one. Handled rather than asserted — a null
      // here would otherwise render as the word "null" next to an email address.
      return { error: "no_password", fieldErrors: {}, credential: null };
    }
    return {
      error: null,
      fieldErrors: {},
      credential: { email: created.user.email, password: created.temporaryPassword },
    };
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors, credential: null };
    }
    throw error;
  }
}

const assignManagerSchema = z.object({
  merchantId: z.uuid(),
  /** "" is the unassign case — the account goes back to house-managed. */
  accountManagerId: z.union([z.uuid(), z.literal("")]),
});

export async function assignAccountManager(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = assignManagerSchema.safeParse({
    merchantId: formData.get("merchantId"),
    accountManagerId: formData.get("accountManagerId") ?? "",
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch(`/v1/merchants/${encodeURIComponent(parsed.data.merchantId)}/account-manager`, {
      method: "PUT",
      body: {
        accountManagerId:
          parsed.data.accountManagerId === "" ? null : parsed.data.accountManagerId,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  // The page is server-rendered and uncached per request, but the assignment
  // also changes which merchants appear in the LIST — revalidate both.
  const prefix = `/${toLocale(locale)}/merchants`;
  revalidatePath(prefix);
  revalidatePath(`${prefix}/${parsed.data.merchantId}`);
  return { error: null, fieldErrors: {} };
}
