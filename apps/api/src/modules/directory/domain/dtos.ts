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

// ── Addresses ────────────────────────────────────────────────────────────────
//
// Declared BEFORE merchants because `createMerchantSchema` embeds
// `resolveAddressSchema`. A `const` is in its temporal dead zone until it is
// evaluated, so the merchant schema referencing it from further up the file is
// a ReferenceError at import time, not a type error a build would catch.

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

// ── Merchants ────────────────────────────────────────────────────────────────

export const createMerchantSchema = z
  .strictObject({
    name: nonEmpty("name"),
    code: z.string().trim().min(1).optional(),
    contactName: z.string().trim().min(1).optional(),
    contactPhone: e164.optional(),
    contactEmail: z.email().optional(),
    /** An address that already exists. Mutually exclusive with `pickupAddress`. */
    defaultPickupAddressId: z.uuid().optional(),
    /**
     * The shop's address, resolved and stored as part of registration.
     *
     * Here because there is no address API: `addresses` has no controller, and
     * exposing one is a larger decision than onboarding needs. Without this a
     * merchant is registered with nowhere to collect from, and every pickup
     * request for them fails on a missing `pickupAddressId` — which is exactly
     * where the commercial's workflow stopped.
     */
    pickupAddress: resolveAddressSchema.optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    // Both would mean registering an address and then ignoring it. Refuse
    // rather than silently picking one — the caller believes they set
    // something that would never take effect.
    if (value.defaultPickupAddressId !== undefined && value.pickupAddress !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["pickupAddress"],
        message: "provide either defaultPickupAddressId or pickupAddress, not both",
      });
    }
  });
export type CreateMerchantInput = z.infer<typeof createMerchantSchema>;

export const updateMerchantSchema = z
  .strictObject({
    name: nonEmpty("name").optional(),
    code: z.string().trim().min(1).nullable().optional(),
    contactName: z.string().trim().min(1).nullable().optional(),
    contactPhone: e164.nullable().optional(),
    contactEmail: z.email().nullable().optional(),
    /** An address that already exists, or `null` to unset. */
    defaultPickupAddressId: z.uuid().nullable().optional(),
    /**
     * A new address, resolved and stored, replacing whatever was there.
     *
     * The only way to give a pickup address to a merchant registered before
     * `pickupAddress` existed on create — and, with no address API, the only
     * way to change one at all. Without it those merchants can never have a
     * pickup requested: the command needs a `pickupAddressId` and nothing
     * could mint one.
     *
     * The previous address is left in place rather than deleted. `addresses`
     * is retained history, and shipments already reference it.
     */
    pickupAddress: resolveAddressSchema.optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  })
  .superRefine((value, ctx) => {
    // Same rule as create: accepting both would resolve an address and then
    // ignore it, so the caller believes they set something that never applied.
    if (value.defaultPickupAddressId !== undefined && value.pickupAddress !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["pickupAddress"],
        message: "provide either defaultPickupAddressId or pickupAddress, not both",
      });
    }
  });
export type UpdateMerchantInput = z.infer<typeof updateMerchantSchema>;

/**
 * Hands an account to a commercial, or takes it back (`merchant:assign_manager`).
 *
 * Deliberately its own endpoint rather than a field on
 * {@link updateMerchantSchema}: `merchant:update` is held by everyone who edits
 * a merchant's phone number, including commercials themselves, and a commercial
 * who could set this field could quietly help themselves to a colleague's book
 * of business. Ownership moves under its own permission and leaves its own
 * audit record.
 *
 * `null` unassigns — the account becomes house-managed and no commercial sees it.
 */
export const assignAccountManagerSchema = z.strictObject({
  accountManagerId: z.uuid().nullable(),
});

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

export const correctAddressSchema = z.strictObject({
  coordinates: coordinatesSchema,
  accessNotes: z.string().trim().min(1).optional(),
});
export type CorrectAddressInput = z.infer<typeof correctAddressSchema>;
