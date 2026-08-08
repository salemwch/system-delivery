import { z } from "zod";

/**
 * Validated input contracts for the network module (docs/05-api-contracts.md).
 *
 * The module's boundary: strict object schemas, unknown keys rejected. Value
 * schemas (coordinates, IANA timezone) are defined here rather than imported from
 * another module, because the layering forbids reaching into another module's
 * internals and each module owns its input contract.
 */

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is required`);

const coordinates = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/** A valid IANA timezone — mandatory on a hub (§3.4 rule 2). */
function isValidTimeZone(value: string): boolean {
  try {
    // Throws RangeError for an unknown zone; this is the canonical runtime check.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
const timezone = nonEmpty("timezone").refine(isValidTimeZone, "must be a valid IANA timezone");

/** GeoJSON Polygon / MultiPolygon geometry — the wire form of a zone boundary. */
const position = z.array(z.number()).min(2).max(3);
const ring = z.array(position).min(4, "a linear ring needs at least 4 positions (closed)");
const polygonCoords = z.array(ring).min(1);
const multiPolygonCoords = z.array(polygonCoords).min(1);
const boundary = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("Polygon"), coordinates: polygonCoords }),
  z.strictObject({ type: z.literal("MultiPolygon"), coordinates: multiPolygonCoords }),
]);

// ── Hubs ─────────────────────────────────────────────────────────────────────

const hubType = z.enum(["SORTING_CENTER", "DISTRIBUTION_CENTER", "PICKUP_POINT"]);

/** A hub's facility address — a pinned location is required (a hub must be located). */
const hubAddressInput = z.strictObject({
  rawInput: nonEmpty("address.rawInput"),
  line1: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  postalCode: z.string().trim().min(1).optional(),
  countryCode: z.string().trim().length(2),
  coordinates,
});

export const createHubSchema = z.strictObject({
  code: nonEmpty("code").max(50),
  name: nonEmpty("name"),
  type: hubType,
  address: hubAddressInput,
  timezone,
  parentHubId: z.uuid().optional(),
  serviceZoneIds: z.array(z.uuid()).optional(),
  cutoffTimes: z.record(z.string(), z.unknown()).optional(),
});
export type CreateHubInput = z.infer<typeof createHubSchema>;

export const updateHubSchema = z
  .strictObject({
    name: nonEmpty("name").optional(),
    type: hubType.optional(),
    timezone: timezone.optional(),
    parentHubId: z.uuid().nullable().optional(),
    serviceZoneIds: z.array(z.uuid()).optional(),
    cutoffTimes: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateHubInput = z.infer<typeof updateHubSchema>;

export const listHubsSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
export type ListHubsInput = z.infer<typeof listHubsSchema>;

// ── Zones ─────────────────────────────────────────────────────────────────────

export const createZoneSchema = z.strictObject({
  code: nonEmpty("code").max(50),
  name: nonEmpty("name"),
  boundary,
  defaultGeofenceRadiusM: z.number().int().min(1).max(100_000).optional(),
});
export type CreateZoneInput = z.infer<typeof createZoneSchema>;

export const updateZoneSchema = z
  .strictObject({
    name: nonEmpty("name").optional(),
    boundary: boundary.optional(),
    defaultGeofenceRadiusM: z.number().int().min(1).max(100_000).optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateZoneInput = z.infer<typeof updateZoneSchema>;

export const listZonesSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  active: z.boolean().optional(),
});
export type ListZonesInput = z.infer<typeof listZonesSchema>;

// ── Cities (villes) ───────────────────────────────────────────────────────────

/**
 * A tariff in MINOR UNITS, as an integer.
 *
 * Not a decimal string, and deliberately: the caller already knows the currency
 * it is quoting and every other amount on this API crosses the wire in minor
 * units. Accepting "4.500" here would put a second decimal parser in the
 * codebase, and a courier's tariff is exactly the kind of number that must not
 * be reinterpreted by whichever parser it happens to reach.
 */
const feeMinor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** ISO 4217. Upper-cased so `tnd` from a form does not fail the FK. */
const currencyCode = z
  .string()
  .trim()
  .length(3)
  .transform((value) => value.toUpperCase());

/**
 * Alternative spellings. Capped at 20 because `search_keys` is GIN-indexed and
 * an unbounded array would let one row bloat the index for every lookup.
 */
const aliases = z.array(nonEmpty("alias").max(120)).max(20);

export const createCitySchema = z.strictObject({
  code: nonEmpty("code").max(50),
  name: nonEmpty("name").max(120),
  nameAr: nonEmpty("nameAr").max(120).optional(),
  governorate: nonEmpty("governorate").max(120),
  postalCode: nonEmpty("postalCode").max(20).optional(),
  zoneId: z.uuid().optional(),
  currency: currencyCode,
  deliveryFeeMinor: feeMinor,
  returnFeeMinor: feeMinor,
  deliveryDelayDays: z.number().int().min(0).max(365).optional(),
  aliases: aliases.optional(),
});
export type CreateCityInput = z.infer<typeof createCitySchema>;

export const updateCitySchema = z
  .strictObject({
    name: nonEmpty("name").max(120).optional(),
    // Nullable: clearing the Arabic name is a real edit, and `undefined` cannot
    // express it — it means "leave alone".
    nameAr: nonEmpty("nameAr").max(120).nullable().optional(),
    governorate: nonEmpty("governorate").max(120).optional(),
    postalCode: nonEmpty("postalCode").max(20).nullable().optional(),
    zoneId: z.uuid().nullable().optional(),
    currency: currencyCode.optional(),
    deliveryFeeMinor: feeMinor.optional(),
    returnFeeMinor: feeMinor.optional(),
    deliveryDelayDays: z.number().int().min(0).max(365).optional(),
    aliases: aliases.optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateCityInput = z.infer<typeof updateCitySchema>;

export const listCitiesSchema = z.strictObject({
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.uuid().optional(),
  active: z.boolean().optional(),
  governorate: nonEmpty("governorate").optional(),
  zoneId: z.uuid().optional(),
  /** Free-text, matched through the same normalisation as the stored keys. */
  search: nonEmpty("search").max(120).optional(),
});
export type ListCitiesInput = z.infer<typeof listCitiesSchema>;

/**
 * Resolve free-text city names against the coverage list — in BULK.
 *
 * Batched rather than one-name-per-request because the caller that matters is a
 * CSV import checking 500 destinations before it creates 500 shipments. One
 * request answers all of them from a single indexed query; 500 requests would
 * be an N+1 across the network.
 */
export const resolveCitiesSchema = z.strictObject({
  names: z.array(nonEmpty("name").max(120)).min(1).max(500),
});
export type ResolveCitiesInput = z.infer<typeof resolveCitiesSchema>;

// ── Geofences ──────────────────────────────────────────────────────────────────

export const createGeofenceSchema = z.strictObject({
  name: nonEmpty("name"),
  kind: z.enum(["HUB", "STOP", "ZONE", "CUSTOM"]),
  hubId: z.uuid().optional(),
  addressId: z.uuid().optional(),
  zoneId: z.uuid().optional(),
  /** Required for CUSTOM; derived from the target for HUB/STOP/ZONE. */
  centre: coordinates.optional(),
  /** Optional: inherits the zone default (or a kind default) when omitted (H6). */
  radiusM: z.number().int().min(1).max(100_000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateGeofenceInput = z.infer<typeof createGeofenceSchema>;
