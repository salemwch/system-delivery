import { z } from "zod";

/**
 * Validated input contracts for the directory module (docs/05-api-contracts.md).
 *
 * These are the module's boundary: a service validates the input another module
 * (or, later, a controller) hands it, so a bad shape is rejected here rather than
 * corrupting a row. All object schemas are strict — unknown keys are rejected,
 * never silently stripped (docs/07-security-architecture.md §4.5).
 */

/** E.164: a leading '+' and 7–15 digits. The phone is the recipient's identity. */
const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/u, "must be an E.164 phone number, e.g. +21620123456");

const countryCode = z
  .string()
  .trim()
  .length(2, "must be a 2-letter ISO 3166-1 alpha-2 country code")
  .transform((value) => value.toUpperCase());

const language = z.enum(["ar", "fr", "en"]);

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is required`);

// ── Merchants ────────────────────────────────────────────────────────────────

export const createMerchantSchema = z.strictObject({
  name: nonEmpty("name"),
  code: z.string().trim().min(1).optional(),
  contactName: z.string().trim().min(1).optional(),
  contactPhone: e164.optional(),
  contactEmail: z.email().optional(),
  defaultPickupAddressId: z.uuid().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type CreateMerchantInput = z.infer<typeof createMerchantSchema>;

export const updateMerchantSchema = z
  .strictObject({
    name: nonEmpty("name").optional(),
    code: z.string().trim().min(1).nullable().optional(),
    contactName: z.string().trim().min(1).nullable().optional(),
    contactPhone: e164.nullable().optional(),
    contactEmail: z.email().nullable().optional(),
    defaultPickupAddressId: z.uuid().nullable().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateMerchantInput = z.infer<typeof updateMerchantSchema>;

// ── Recipients ───────────────────────────────────────────────────────────────

export const createRecipientSchema = z.strictObject({
  fullName: nonEmpty("fullName"),
  phone: e164,
  phoneAlt: e164.optional(),
  defaultAddressId: z.uuid().optional(),
  preferredLanguage: language.optional(),
  notes: z.string().trim().min(1).optional(),
});
export type CreateRecipientInput = z.infer<typeof createRecipientSchema>;

export const updateRecipientSchema = z
  .strictObject({
    // Phone is the natural key — correcting it is a merge, not an update, so it
    // is deliberately not editable here.
    fullName: nonEmpty("fullName").optional(),
    phoneAlt: e164.nullable().optional(),
    defaultAddressId: z.uuid().nullable().optional(),
    preferredLanguage: language.nullable().optional(),
    notes: z.string().trim().min(1).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateRecipientInput = z.infer<typeof updateRecipientSchema>;

export const blockRecipientSchema = z.strictObject({
  reason: nonEmpty("reason"),
});
export type BlockRecipientInput = z.infer<typeof blockRecipientSchema>;

// ── Addresses ────────────────────────────────────────────────────────────────

const coordinatesSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const resolveAddressSchema = z.strictObject({
  /** The unparsed original — always required, never overwritten once stored. */
  rawInput: nonEmpty("rawInput"),
  line1: z.string().trim().min(1).optional(),
  line2: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  postalCode: z.string().trim().min(1).optional(),
  countryCode,
  timezone: z.string().trim().min(1).optional(),
  accessNotes: z.string().trim().min(1).optional(),
  /** A human-placed map pin. When present it is authoritative (confidence 1). */
  coordinates: coordinatesSchema.optional(),
});
export type ResolveAddressInput = z.infer<typeof resolveAddressSchema>;

export const correctAddressSchema = z.strictObject({
  coordinates: coordinatesSchema,
  accessNotes: z.string().trim().min(1).optional(),
});
export type CorrectAddressInput = z.infer<typeof correctAddressSchema>;
