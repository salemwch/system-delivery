import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";

import { OutboxService } from "../../platform/index.js";
import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { correctAddressSchema, resolveAddressSchema } from "../domain/dtos.js";
import type { ResolveAddressInput } from "../domain/dtos.js";
import {
  AUTO_DISPATCH_CONFIDENCE_FLOOR,
  DRIVER_CORRECTION_CONFIDENCE,
  GEOCODING_PROVIDER,
  MANUAL_PIN_CONFIDENCE,
} from "../domain/geocoding.js";
import type { Coordinates, GeocodingProvider } from "../domain/geocoding.js";
import { addresses } from "../domain/schema.js";

/** The outcome of resolving an address: what to reference, and whether it is dispatchable. */
export interface ResolvedAddress {
  readonly addressId: string;
  readonly confidence: number;
  /** True when confidence is below the floor — blocks auto-dispatch (D2). */
  readonly requiresReview: boolean;
}

/** A read model of an address with its coordinates flattened out of PostGIS. */
export interface AddressView {
  readonly id: string;
  readonly tenantId: string;
  readonly rawInput: string;
  readonly normalisedLine1: string | null;
  readonly normalisedLine2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly geocodeConfidence: number | null;
  readonly geocodeSource: string;
  readonly timezone: string | null;
  readonly accessNotes: string | null;
  readonly verifiedAt: Date | null;
}

interface Located {
  readonly coordinates: Coordinates | null;
  readonly confidence: number;
  readonly source: "manual" | "driver_corrected" | "mapbox" | "google" | "none";
}

/**
 * The address-quality pipeline (docs/04-context-map.md §3.3, docs/06 §4.4).
 *
 * `resolve()` encapsulates normalisation → geocoding → confidence → storage. The
 * geocoding provider is a swappable port; at MVP there is no automatic geocoder
 * wired, so resolution relies on a human-placed map pin (authoritative) and
 * otherwise stores the address with zero confidence — which correctly BLOCKS
 * auto-dispatch and flags it for dispatcher review rather than guessing.
 *
 * Driver corrections are a compounding asset: every "the pin is 80 m off" fix
 * improves every future delivery to that address, so it is captured from MVP and
 * announced as `address.geocode_corrected` for consumers to invalidate caches.
 */
@Injectable()
export class AddressService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
    @Inject(GEOCODING_PROVIDER) private readonly geocoder: GeocodingProvider,
  ) {}

  async resolve(input: unknown): Promise<ResolvedAddress> {
    const dto = parseWithZod(resolveAddressSchema, input);
    const located = await this.locate(dto);

    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const inserted = await tx
        .insert(addresses)
        .values({
          tenantId,
          rawInput: dto.rawInput,
          ...(dto.line1 === undefined ? {} : { normalisedLine1: dto.line1 }),
          ...(dto.line2 === undefined ? {} : { normalisedLine2: dto.line2 }),
          ...(dto.city === undefined ? {} : { city: dto.city }),
          ...(dto.region === undefined ? {} : { region: dto.region }),
          ...(dto.postalCode === undefined ? {} : { postalCode: dto.postalCode }),
          countryCode: dto.countryCode,
          ...(dto.timezone === undefined ? {} : { timezone: dto.timezone }),
          ...(dto.accessNotes === undefined ? {} : { accessNotes: dto.accessNotes }),
          geocodeSource: located.source,
          geocodeConfidence: located.confidence.toString(),
          ...(located.coordinates === null ? {} : { location: pointOf(located.coordinates) }),
        })
        .returning({ id: addresses.id });

      const id = inserted[0]?.id;
      if (id === undefined) {
        throw new Error("Address insert returned no row");
      }
      return {
        addressId: id,
        confidence: located.confidence,
        requiresReview: located.confidence < AUTO_DISPATCH_CONFIDENCE_FLOOR,
      };
    });
  }

  async getById(id: string): Promise<AddressView> {
    return this.database.withTenant(async (tx) => {
      const rows = await selectViews(tx, eq(addresses.id, id));
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError("Address");
      }
      return row;
    });
  }

  /**
   * Applies a driver's on-the-ground correction: the strongest geocode signal.
   * Overwrites the location, marks the source `driver_corrected`, and announces
   * `address.geocode_corrected` so route matrices and caches are invalidated.
   */
  async applyDriverCorrection(id: string, input: unknown): Promise<AddressView> {
    const dto = parseWithZod(correctAddressSchema, input);
    return this.database.withTenant(async (tx) => {
      const updated = await tx
        .update(addresses)
        .set({
          location: pointOf(dto.coordinates),
          geocodeConfidence: DRIVER_CORRECTION_CONFIDENCE.toString(),
          geocodeSource: "driver_corrected",
          ...(dto.accessNotes === undefined ? {} : { accessNotes: dto.accessNotes }),
          updatedAt: sql`now()`,
        })
        .where(eq(addresses.id, id))
        .returning({ id: addresses.id });

      if (updated[0] === undefined) {
        throw new NotFoundError("Address");
      }

      await this.outbox.publish(tx, {
        eventType: "address.geocode_corrected",
        aggregateType: "address",
        aggregateId: id,
        payload: {
          latitude: dto.coordinates.lat,
          longitude: dto.coordinates.lng,
          source: "driver_corrected",
        },
      });

      const rows = await selectViews(tx, eq(addresses.id, id));
      const row = rows[0];
      if (row === undefined) {
        // Just updated in this transaction — unreachable, guards the type.
        throw new NotFoundError("Address");
      }
      return row;
    });
  }

  /** Determines coordinates + confidence + source for an input. */
  private async locate(dto: ResolveAddressInput): Promise<Located> {
    // A human-placed pin is authoritative — no geocoder can beat it.
    if (dto.coordinates !== undefined) {
      return { coordinates: dto.coordinates, confidence: MANUAL_PIN_CONFIDENCE, source: "manual" };
    }
    const result = await this.geocoder.geocode({
      rawInput: dto.rawInput,
      countryCode: dto.countryCode,
      ...(dto.line1 === undefined ? {} : { line1: dto.line1 }),
      ...(dto.line2 === undefined ? {} : { line2: dto.line2 }),
      ...(dto.city === undefined ? {} : { city: dto.city }),
      ...(dto.region === undefined ? {} : { region: dto.region }),
      ...(dto.postalCode === undefined ? {} : { postalCode: dto.postalCode }),
    });
    if (result === null) {
      // No confident match — store it, but zero confidence blocks auto-dispatch.
      return { coordinates: null, confidence: 0, source: "none" };
    }
    return { coordinates: result.location, confidence: result.confidence, source: result.source };
  }
}

/** A geography point literal for INSERT/UPDATE — lng first, per PostGIS. */
function pointOf(coordinates: Coordinates) {
  return sql`ST_SetSRID(ST_MakePoint(${coordinates.lng}, ${coordinates.lat}), 4326)::geography`;
}

type ViewRow = Omit<AddressView, "geocodeConfidence"> & { geocodeConfidence: string | null };

async function selectViews(
  tx: Parameters<Parameters<DatabaseService["withTenant"]>[0]>[0],
  where: ReturnType<typeof eq>,
): Promise<AddressView[]> {
  const rows: ViewRow[] = await tx
    .select({
      id: addresses.id,
      tenantId: addresses.tenantId,
      rawInput: addresses.rawInput,
      normalisedLine1: addresses.normalisedLine1,
      normalisedLine2: addresses.normalisedLine2,
      city: addresses.city,
      region: addresses.region,
      postalCode: addresses.postalCode,
      countryCode: addresses.countryCode,
      latitude: sql<number | null>`ST_Y(${addresses.location}::geometry)`,
      longitude: sql<number | null>`ST_X(${addresses.location}::geometry)`,
      geocodeConfidence: addresses.geocodeConfidence,
      geocodeSource: addresses.geocodeSource,
      timezone: addresses.timezone,
      accessNotes: addresses.accessNotes,
      verifiedAt: addresses.verifiedAt,
    })
    .from(addresses)
    .where(where)
    .limit(1);

  return rows.map((row) => ({
    ...row,
    // numeric arrives as a string from the driver; expose a real number.
    geocodeConfidence: row.geocodeConfidence === null ? null : Number(row.geocodeConfidence),
  }));
}
