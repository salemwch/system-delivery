import { z } from "zod";

/**
 * Validated input contracts for the shipment module (docs/05-api-contracts.md).
 *
 * The module's boundary: a service validates the input a controller (or another
 * module) hands it, so a bad shape is rejected here rather than corrupting the
 * custody ledger. All object schemas are strict — unknown keys are rejected, not
 * silently stripped (docs/07-security-architecture.md §4.5).
 *
 * Duplicating small value schemas (E.164, coordinates) rather than importing the
 * directory module's is deliberate: each module owns its input contract, and the
 * layering forbids reaching into another module's domain internals.
 */

/** E.164: a leading '+' and 7–15 digits. The recipient phone is mandatory (rule 4). */
const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/u, "must be an E.164 phone number, e.g. +21620123456");

const coordinates = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const currency = z
  .string()
  .trim()
  .length(3, "must be a 3-letter ISO 4217 currency code")
  .transform((value) => value.toUpperCase());

/**
 * A non-negative integer amount in minor units, carried as bigint end-to-end.
 *
 * ⚠️ ACCEPTS A BIGINT TOO, and that is not redundancy — it is what makes the
 * schema IDEMPOTENT, which this codebase requires because the same schema is
 * applied twice on every HTTP request:
 *
 *   1. `@Body(zodBody(createShipmentSchema))` in the controller, and
 *   2. `parseWithZod(createShipmentSchema, input)` inside the service, which
 *      takes `unknown` because it is also called from tests, from bulk import,
 *      and from other services.
 *
 * The first parse turns `12500` into `12500n`. Without a bigint branch the
 * second parse sees a bigint, matches neither the number nor the string arm, and
 * fails with INVALID_UNION — so **creating a COD shipment over HTTP always
 * failed**, while every test passed because tests call the service directly and
 * parse exactly once. COD is the P0 feature of this market; it was unreachable
 * through the API.
 *
 * Every other field survives a second parse unchanged; only a type-CHANGING
 * transform does not. JSON cannot carry a bigint, so the extra branch is
 * unreachable from a real client and costs nothing.
 */
const amountMinor = z
  .union([
    z.number().int().nonnegative(),
    z.string().regex(/^\d+$/u, "must be a whole amount"),
    z.bigint().nonnegative(),
  ])
  .transform((value) => BigInt(value));

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is required`);
const idempotencyKey = nonEmpty("idempotencyKey").max(200);
const serviceLevel = z.enum(["EXPRESS", "STANDARD", "SCHEDULED"]);
const language = z.enum(["ar", "fr", "en"]);

/** An address to resolve through the directory address-quality pipeline. */
const addressInput = z.strictObject({
  rawInput: nonEmpty("rawInput"),
  line1: z.string().trim().min(1).optional(),
  line2: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  postalCode: z.string().trim().min(1).optional(),
  countryCode: z.string().trim().length(2),
  timezone: z.string().trim().min(1).optional(),
  accessNotes: z.string().trim().min(1).optional(),
  /** A human-placed map pin — authoritative when present (confidence 1). */
  coordinates: coordinates.optional(),
});

// ── Create ───────────────────────────────────────────────────────────────────

export const createShipmentSchema = z.strictObject({
  idempotencyKey,
  merchantId: z.uuid().optional(),
  externalReference: z.string().trim().min(1).max(200).optional(),
  serviceLevel: serviceLevel.optional(),

  senderName: nonEmpty("senderName"),
  senderPhone: e164,
  origin: addressInput,

  recipientName: nonEmpty("recipientName"),
  recipientPhone: e164,
  recipientPhoneAlt: e164.optional(),
  recipientLanguage: language.optional(),
  destination: addressInput,

  promisedFrom: z.coerce.date().optional(),
  promisedTo: z.coerce.date().optional(),

  weightGrams: z.number().int().nonnegative().optional(),
  volumeCm3: z.number().int().nonnegative().optional(),
  parcelCount: z.number().int().min(1).optional(),
  declaredValueMinor: amountMinor.optional(),
  currency,
  codAmountMinor: amountMinor.optional(),

  maxAttempts: z.number().int().min(1).max(10).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  requiredSkills: z.array(nonEmpty("skill")).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),

  source: z.enum(["CSV", "MANUAL", "API"]).optional(),
  occurredAt: z.coerce.date().optional(),
});
export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;

// ── Driver-owned lifecycle commands ──────────────────────────────────────────

export const recordPickupSchema = z.strictObject({
  idempotencyKey,
  driverId: z.uuid(),
  legId: z.uuid().optional(),
  routeId: z.uuid().optional(),
  routeStopId: z.uuid().optional(),
  scannedBarcode: z.string().trim().min(1).optional(),
  location: coordinates.optional(),
  locationAccuracyM: z.number().nonnegative().optional(),
  occurredAt: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type RecordPickupInput = z.infer<typeof recordPickupSchema>;

const podSchema = z.strictObject({
  podType: z.enum(["signature", "photo", "otp", "id_check", "contactless"]),
  signatureObjectKey: z.string().trim().min(1).optional(),
  photoObjectKeys: z.array(z.string().trim().min(1)).optional(),
  contentHash: z.string().trim().min(1).optional(),
  recipientName: nonEmpty("pod.recipientName"),
  recipientRelationship: z.string().trim().min(1).optional(),
  otpVerified: z.boolean().optional(),
  deviceMetadata: z.record(z.string(), z.unknown()).optional(),
});

export const confirmDeliverySchema = z.strictObject({
  idempotencyKey,
  driverId: z.uuid(),
  legId: z.uuid().optional(),
  routeId: z.uuid().optional(),
  routeStopId: z.uuid().optional(),
  location: coordinates.optional(),
  locationAccuracyM: z.number().nonnegative().optional(),
  occurredAt: z.coerce.date().optional(),
  dwellTimeSeconds: z.number().int().nonnegative().optional(),
  pod: podSchema,
  /** Must be true when the shipment carries COD; validated against the amount. */
  codCollected: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ConfirmDeliveryInput = z.infer<typeof confirmDeliverySchema>;

export const recordFailedAttemptSchema = z.strictObject({
  idempotencyKey,
  driverId: z.uuid(),
  legId: z.uuid().optional(),
  routeId: z.uuid().optional(),
  routeStopId: z.uuid().optional(),
  reasonCode: nonEmpty("reasonCode"),
  reasonNotes: z.string().trim().min(1).optional(),
  location: coordinates.optional(),
  locationAccuracyM: z.number().nonnegative().optional(),
  dwellTimeSeconds: z.number().int().nonnegative().optional(),
  occurredAt: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type RecordFailedAttemptInput = z.infer<typeof recordFailedAttemptSchema>;

export const initiateReturnSchema = z.strictObject({
  idempotencyKey,
  reason: nonEmpty("reason"),
  returnToAddressId: z.uuid().optional(),
  returnHubId: z.uuid().optional(),
  occurredAt: z.coerce.date().optional(),
});
export type InitiateReturnInput = z.infer<typeof initiateReturnSchema>;

/**
 * Closes the RTO lifecycle: the parcel is physically back with the merchant.
 *
 * `receivedByName` is who signed for it at the merchant's end. Optional, because
 * a return handed back at a hub counter often has no signature — but recorded
 * when it exists, since a merchant disputing that a parcel came back is the one
 * moment this record is read.
 */
export const completeReturnSchema = z.strictObject({
  idempotencyKey,
  receivedByName: z.string().trim().min(1).max(200).optional(),
  driverId: z.uuid().optional(),
  occurredAt: z.coerce.date().optional(),
});

export const cancelShipmentSchema = z.strictObject({
  idempotencyKey,
  reason: nonEmpty("reason"),
  occurredAt: z.coerce.date().optional(),
});
export type CancelShipmentInput = z.infer<typeof cancelShipmentSchema>;

// ── Cross-context recorder ───────────────────────────────────────────────────

/**
 * Events produced by the dispatch and hub contexts once those modules exist
 * (docs/03-event-storming.md §4.1). Until then this validated recorder is the
 * seam they will call: the state machine, sequence, idempotency, and projection
 * are enforced identically regardless of which context appends the event.
 */
export const recordEventSchema = z.strictObject({
  eventType: z.enum([
    "assigned",
    "arrived_at_hub",
    "loaded",
    "departed",
    "out_for_delivery",
    "arrived_at_stop",
    "returned",
  ]),
  idempotencyKey,
  legId: z.uuid().optional(),
  hubId: z.uuid().optional(),
  driverId: z.uuid().optional(),
  routeId: z.uuid().optional(),
  routeStopId: z.uuid().optional(),
  reasonCode: z.string().trim().min(1).optional(),
  location: coordinates.optional(),
  locationAccuracyM: z.number().nonnegative().optional(),
  occurredAt: z.coerce.date().optional(),
  /** Merged into the published event payload; the base envelope is added by the service. */
  payload: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type RecordEventInput = z.infer<typeof recordEventSchema>;

// ── Amendments (modification colis) ──────────────────────────────────────────

/**
 * A requested change to a parcel already in the system.
 *
 * Every field optional and at least one required: an amendment names only what
 * should change, so a request that touches the phone leaves the address exactly
 * as it was rather than resubmitting it and risking a typo in a field nobody
 * meant to edit.
 */
export const requestAmendmentSchema = z
  .strictObject({
    recipientName: nonEmpty("recipientName").max(200).optional(),
    recipientPhone: e164.optional(),
    recipientPhoneAlt: e164.optional(),
    /** Free text; geocoded only if the amendment is approved. */
    destinationRawInput: nonEmpty("destinationRawInput").max(500).optional(),
    destinationCity: nonEmpty("destinationCity").max(120).optional(),
    codAmountMinor: amountMinor.optional(),
    /** Why. Shown to whoever decides — it is what separates yes from no. */
    reason: nonEmpty("reason").max(1000).optional(),
  })
  .refine(
    (value) =>
      value.recipientName !== undefined ||
      value.recipientPhone !== undefined ||
      value.recipientPhoneAlt !== undefined ||
      value.destinationRawInput !== undefined ||
      value.codAmountMinor !== undefined,
    { message: "an amendment must request at least one change" },
  )
  .refine((value) => value.destinationCity === undefined || value.destinationRawInput !== undefined, {
    message: "destinationCity needs destinationRawInput",
    path: ["destinationCity"],
  });
export type RequestAmendmentInput = z.infer<typeof requestAmendmentSchema>;

export const rejectAmendmentSchema = z.strictObject({
  reason: nonEmpty("reason").max(1000),
});
export type RejectAmendmentInput = z.infer<typeof rejectAmendmentSchema>;

export const listAmendmentsSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  status: z.enum(["PENDING", "APPLIED", "REJECTED"]).optional(),
  shipmentId: z.uuid().optional(),
});
export type ListAmendmentsInput = z.infer<typeof listAmendmentsSchema>;

/**
 * État Colis (Entreprise) — the per-merchant status report.
 *
 * The period is REQUIRED. A report over "everything ever" is a full table scan
 * whose answer nobody wants, and defaulting it silently would make the slowest
 * query in the system the easiest one to run by accident.
 */
export const parcelStateQuerySchema = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    /** Narrow to one account. Absent = every merchant. */
    merchantId: z.uuid().optional(),
  })
  .refine((value) => value.from <= value.to, {
    message: "from must not be after to",
    path: ["to"],
  });
export type ParcelStateQueryInput = z.infer<typeof parcelStateQuerySchema>;

// ── Queries ──────────────────────────────────────────────────────────────────

export const listShipmentsSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  status: z
    .enum([
      "CREATED",
      "ASSIGNED",
      "PICKED_UP",
      "AT_HUB",
      "IN_TRANSIT",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "ATTEMPT_FAILED",
      "RETURN_PENDING",
      "RETURNED",
      "CANCELLED",
    ])
    .optional(),
  merchantId: z.uuid().optional(),
});
export type ListShipmentsInput = z.infer<typeof listShipmentsSchema>;
