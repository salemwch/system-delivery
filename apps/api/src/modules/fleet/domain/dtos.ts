import { z } from "zod";

/**
 * Validated input contracts for the fleet module (docs/05-api-contracts.md).
 *
 * PII (nationalId, licenceNumber) enters here as PLAINTEXT and is encrypted by the
 * service before it reaches the database — the DTO is the last place the plaintext
 * is legitimately in memory. Strict object schemas; unknown keys rejected.
 */

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is required`);

const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/u, "must be an E.164 phone number, e.g. +21620123456");

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "must be an ISO date, YYYY-MM-DD");

const locale = z.enum(["ar", "fr", "en"]);

/** A non-negative integer amount in minor units, carried as bigint. */
const amountMinor = z
  .union([
    z.number().int().nonnegative(),
    z.string().regex(/^\d+$/u, "must be a whole amount"),
    // Idempotent under a second parse — see the note in shipment/domain/dtos.ts.
    // The controller pipe and the service both apply these schemas, and a
    // type-changing transform that cannot re-accept its own output breaks the
    // endpoint outright.
    z.bigint().nonnegative(),
  ])
  .transform((value) => BigInt(value));

// ── Vehicles ─────────────────────────────────────────────────────────────────

const vehicleType = z.enum(["MOTORCYCLE", "CAR", "VAN", "TRUCK"]);

export const createVehicleSchema = z.strictObject({
  plateNumber: nonEmpty("plateNumber").max(32),
  type: vehicleType,
  make: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  capacityWeightGrams: z.number().int().nonnegative().optional(),
  capacityVolumeCm3: z.number().int().nonnegative().optional(),
  capacityParcels: z.number().int().nonnegative().optional(),
  features: z.array(nonEmpty("feature")).optional(),
  homeHubId: z.uuid().optional(),
  insuranceExpiryAt: isoDate.optional(),
  inspectionExpiryAt: isoDate.optional(),
});
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;

export const updateVehicleSchema = z
  .strictObject({
    make: z.string().trim().min(1).nullable().optional(),
    model: z.string().trim().min(1).nullable().optional(),
    year: z.number().int().min(1900).max(2100).nullable().optional(),
    capacityWeightGrams: z.number().int().nonnegative().optional(),
    capacityVolumeCm3: z.number().int().nonnegative().optional(),
    capacityParcels: z.number().int().nonnegative().optional(),
    features: z.array(nonEmpty("feature")).optional(),
    homeHubId: z.uuid().nullable().optional(),
    insuranceExpiryAt: isoDate.nullable().optional(),
    inspectionExpiryAt: isoDate.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;

export const listVehiclesSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  status: z.enum(["ACTIVE", "MAINTENANCE", "INACTIVE"]).optional(),
});
export type ListVehiclesInput = z.infer<typeof listVehiclesSchema>;

// ── Drivers ───────────────────────────────────────────────────────────────────

const employmentType = z.enum(["EMPLOYEE", "CONTRACTOR"]);

export const createDriverSchema = z.strictObject({
  employeeCode: nonEmpty("employeeCode").max(50),
  fullName: nonEmpty("fullName"),
  phone: e164,
  employmentType,
  /** Plaintext in — encrypted by the service (never stored or logged in the clear). */
  nationalId: z.string().trim().min(1).max(64).optional(),
  licenceNumber: z.string().trim().min(1).max(64).optional(),
  licenceExpiryAt: isoDate.optional(),
  homeHubId: z.uuid().optional(),
  defaultVehicleId: z.uuid().optional(),
  skills: z.array(nonEmpty("skill")).optional(),
  locale: locale.optional(),
  userId: z.uuid().optional(),
  deviceId: z.string().trim().min(1).optional(),
  appVersion: z.string().trim().min(1).optional(),
});
export type CreateDriverInput = z.infer<typeof createDriverSchema>;

export const updateDriverSchema = z
  .strictObject({
    fullName: nonEmpty("fullName").optional(),
    // Phone is the auth identity; changing it requires re-verification (rule 6),
    // but the field itself is editable here.
    phone: e164.optional(),
    nationalId: z.string().trim().min(1).max(64).nullable().optional(),
    licenceNumber: z.string().trim().min(1).max(64).nullable().optional(),
    licenceExpiryAt: isoDate.nullable().optional(),
    homeHubId: z.uuid().nullable().optional(),
    defaultVehicleId: z.uuid().nullable().optional(),
    skills: z.array(nonEmpty("skill")).optional(),
    locale: locale.optional(),
    deviceId: z.string().trim().min(1).nullable().optional(),
    appVersion: z.string().trim().min(1).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>;

export const listDriversSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  status: z.enum(["PENDING", "ACTIVE", "INACTIVE", "SUSPENDED"]).optional(),
});
export type ListDriversInput = z.infer<typeof listDriversSchema>;

export const listAvailableSchema = z.strictObject({
  at: z.coerce.date().optional(),
  skills: z.array(nonEmpty("skill")).optional(),
});
export type ListAvailableInput = z.infer<typeof listAvailableSchema>;

// ── Shifts ────────────────────────────────────────────────────────────────────

export const startShiftSchema = z.strictObject({
  driverId: z.uuid(),
  vehicleId: z.uuid(),
  hubId: z.uuid().optional(),
  startOdometer: z.number().int().nonnegative().optional(),
  openingCashMinor: amountMinor.optional(),
});
export type StartShiftInput = z.infer<typeof startShiftSchema>;

export const endShiftSchema = z.strictObject({
  endOdometer: z.number().int().nonnegative().optional(),
  closingCashMinor: amountMinor.optional(),
});
export type EndShiftInput = z.infer<typeof endShiftSchema>;
