import { z } from "zod";

import type { Shipment } from "./schema.js";

/**
 * The shipment row as JSON, and back (invariant I29).
 *
 * An idempotent replay must return the RECORDED outcome of the original
 * command (draft-ietf-httpapi-idempotency-key-header §2.6), not whatever the
 * shipment looks like now. The outcome is stored as JSONB, and JSON has no
 * bigint and no Date. This codec is the one place that crosses that boundary,
 * in both directions, with Zod codecs (https://zod.dev/codecs):
 *   - bigint money and sequences travel as decimal strings, never as JSON
 *     numbers, which lose precision past 2^53;
 *   - instants travel as ISO-8601 with offset.
 *
 * ⚠️ Drift is a compile error, not a runtime surprise. `_SnapshotIsShipment`
 * below fails to type-check the moment a column is added to, removed from, or
 * re-typed in `shipments` without this schema following.
 */
const instant = z.codec(z.iso.datetime({ offset: true }), z.date(), {
  decode: (iso) => new Date(iso),
  encode: (date) => date.toISOString(),
});

const integerString = z.codec(z.string().regex(/^-?\d+$/), z.bigint(), {
  decode: (digits) => BigInt(digits),
  encode: (value) => value.toString(),
});

const shipmentSnapshot = z.strictObject({
  id: z.string(),
  tenantId: z.string(),
  trackingNumber: z.string(),
  merchantId: z.string().nullable(),
  externalReference: z.string().nullable(),
  recipientId: z.string().nullable(),
  status: z.string(),
  serviceLevel: z.string(),
  senderName: z.string(),
  senderPhone: z.string(),
  originAddressId: z.string(),
  recipientName: z.string(),
  recipientPhone: z.string(),
  recipientPhoneAlt: z.string().nullable(),
  destinationAddressId: z.string(),
  promisedFrom: instant.nullable(),
  promisedTo: instant.nullable(),
  etaAt: instant.nullable(),
  weightGrams: z.number().int(),
  volumeCm3: z.number().int().nullable(),
  parcelCount: z.number().int(),
  declaredValueMinor: integerString.nullable(),
  currency: z.string(),
  codAmountMinor: integerString,
  codStatus: z.string(),
  attemptCount: z.number().int(),
  maxAttempts: z.number().int(),
  nextAttemptAt: instant.nullable(),
  priority: z.number().int(),
  requiredSkills: z.array(z.string()),
  currentCustodyType: z.string().nullable(),
  currentCustodyId: z.string().nullable(),
  lastDriverId: z.string().nullable(),
  customFields: z.unknown(),
  lastSequence: integerString,
  createdAt: instant,
  updatedAt: instant,
});

/** The JSON-safe form stored in `shipment_command_keys.result`. */
export type ShipmentSnapshotJson = z.input<typeof shipmentSnapshot>;

// Compile-time proof that decoding yields exactly a `Shipment`, field for field.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type _SnapshotIsShipment = Assert<Equals<z.output<typeof shipmentSnapshot>, Shipment>>;

/** Shipment → JSON for storage. */
export function encodeShipment(shipment: Shipment): ShipmentSnapshotJson {
  return shipmentSnapshot.encode(shipment);
}

/** Stored JSON → Shipment. Throws on anything that is not a recorded snapshot. */
export function decodeShipment(stored: unknown): Shipment {
  return shipmentSnapshot.parse(stored);
}
