"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { fieldErrorsFrom } from "./form-state";
import type { FormState } from "./form-state";
import { toLocale } from "./i18n";
import { toMinorUnits } from "./minor-units";

/**
 * Villes — coverage and tariff.
 *
 * Guarded by `hub:manage` on the API. A tariff is a price list: whoever can
 * change it changes what every merchant is billed from that moment on, which is
 * why the API audits the money fields and this file never touches them silently.
 *
 * Fees are typed as DECIMALS ("7.500") and converted here by string arithmetic.
 * `Number(x) * 1000` is wrong on values like 4.005 and the error is a millime —
 * invisible in a form, permanent on an invoice.
 */

/** `FormData.get` returns `string | File | null`; a File coerces to "[object File]". */
function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

/** An optional field: empty means "not provided", never the empty string. */
function optionalText(formData: FormData, field: string): string | undefined {
  const value = text(formData, field).trim();
  return value === "" ? undefined : value;
}

const decimalAmount = z
  .string()
  .trim()
  .regex(/^\d{1,12}([.,]\d{1,6})?$/u, "invalid");

const citySchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
  governorate: z.string().trim().min(1).max(120),
  postalCode: z.string().trim().max(20).optional(),
  currency: z.string().trim().length(3),
  exponent: z.coerce.number().int().min(0).max(6),
  deliveryFee: decimalAmount,
  returnFee: decimalAmount,
  deliveryDelayDays: z.coerce.number().int().min(0).max(365),
  /** One per line in the textarea — the shape an operator actually types. */
  aliases: z.string().max(2000).optional(),
});

function aliasesOf(raw: string | undefined): string[] {
  return (raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export async function saveCity(
  locale: string,
  cityId: string | null,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = citySchema.safeParse({
    code: text(formData, "code"),
    name: text(formData, "name"),
    nameAr: optionalText(formData, "nameAr"),
    governorate: text(formData, "governorate"),
    postalCode: optionalText(formData, "postalCode"),
    currency: text(formData, "currency"),
    exponent: text(formData, "exponent"),
    deliveryFee: text(formData, "deliveryFee"),
    returnFee: text(formData, "returnFee"),
    deliveryDelayDays: text(formData, "deliveryDelayDays"),
    aliases: optionalText(formData, "aliases"),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  const dto = parsed.data;
  const deliveryFeeMinor = Number(toMinorUnits(dto.deliveryFee, dto.exponent));
  const returnFeeMinor = Number(toMinorUnits(dto.returnFee, dto.exponent));

  // The regex admits 12 integer digits, which at exponent 6 exceeds what a
  // double can hold exactly. Caught here rather than sent: the API takes a JSON
  // number, and a silently rounded tariff is the failure this codebase spends
  // the most effort avoiding.
  if (!Number.isSafeInteger(deliveryFeeMinor) || !Number.isSafeInteger(returnFeeMinor)) {
    return { error: "validation", fieldErrors: { deliveryFee: "invalid" } };
  }

  /** Everything both contracts accept, spelled once. */
  const common = {
    name: dto.name,
    governorate: dto.governorate,
    currency: dto.currency.toUpperCase(),
    deliveryFeeMinor,
    returnFeeMinor,
    deliveryDelayDays: dto.deliveryDelayDays,
    aliases: aliasesOf(dto.aliases),
  };

  try {
    if (cityId === null) {
      // Create omits what was left blank: its schema is strict and has no
      // "clear this field" case to express, because there is nothing to clear.
      await apiFetch("/v1/cities", {
        method: "POST",
        body: {
          ...common,
          code: dto.code,
          ...(dto.nameAr === undefined ? {} : { nameAr: dto.nameAr }),
          ...(dto.postalCode === undefined ? {} : { postalCode: dto.postalCode }),
        },
      });
    } else {
      // Update sends null for a blank: on a form an emptied box means "remove
      // it", and `undefined` would mean "leave the old value alone".
      await apiFetch(`/v1/cities/${cityId}`, {
        method: "PATCH",
        body: { ...common, nameAr: dto.nameAr ?? null, postalCode: dto.postalCode ?? null },
      });
    }
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/settings/cities`);
  return { error: null, fieldErrors: {} };
}

const toggleSchema = z.object({
  cityId: z.uuid(),
  active: z.enum(["true", "false"]).transform((value) => value === "true"),
});

/**
 * Retires a city, or brings it back.
 *
 * Never a delete: past shipments and invoices reference the tariff that applied
 * at the time, and an inactive city simply stops being quoted for new ones.
 */
export async function setCityActive(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = toggleSchema.safeParse({
    cityId: text(formData, "cityId"),
    active: text(formData, "active"),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: {} };
  }

  try {
    await apiFetch(`/v1/cities/${parsed.data.cityId}`, {
      method: "PATCH",
      body: { active: parsed.data.active },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: {} };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/settings/cities`);
  return { error: null, fieldErrors: {} };
}
