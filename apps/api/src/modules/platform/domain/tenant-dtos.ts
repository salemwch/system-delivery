import { z } from "zod";

/**
 * Validated input for the tenant's own settings — Général.
 *
 * ⚠️ NEITHER THE SLUG NOR THE CURRENCY IS EDITABLE, and their absence from this
 * schema is the enforcement. The slug appears in every tracking URL a customer
 * has already been sent; changing it breaks every link in the wild. The currency
 * is stamped on every shipment, invoice and ledger entry ever written, and
 * changing it would REINTERPRET historical amounts rather than convert them —
 * 45.000 TND silently becoming 45.000 EUR across a year of accounts.
 */

/** A valid IANA zone. `Intl` is the canonical runtime check. */
function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const locale = z.enum(["ar", "fr", "en"]);

export const updateTenantProfileSchema = z
  .strictObject({
    name: z.string().trim().min(1, "name is required").max(200).optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .refine(isValidTimeZone, "must be a valid IANA timezone")
      .optional(),
    defaultLocale: locale.optional(),
    /**
     * At least one, and deduplicated.
     *
     * An empty list would leave every document with no language to render in,
     * and the default-locale check in the service has nothing to validate
     * against.
     */
    supportedLocales: z
      .array(locale)
      .min(1, "a courier must offer at least one language")
      .transform((values) => [...new Set(values)])
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateTenantProfileInput = z.infer<typeof updateTenantProfileSchema>;
