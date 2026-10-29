import { Injectable } from "@nestjs/common";
import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { AuditService, OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  idempotencyKeyReused,
} from "../../../shared/errors/index.js";
import { parseWithZod, requestFingerprint, resolveDeviceTime } from "../../../shared/http/index.js";
import {
  ADDRESS_CORRECTION_STATUSES,
  correctAddressSchema,
  listCorrectionsSchema,
  reviewCorrectionSchema,
} from "../domain/dtos.js";
import type { AddressCorrectionStatus } from "../domain/dtos.js";
import { CORRECTION_REVIEW_DISTANCE_M, DRIVER_CORRECTION_CONFIDENCE } from "../domain/geocoding.js";
import type { Coordinates } from "../domain/geocoding.js";
import { addressCorrections, addresses } from "../domain/schema.js";

/** A correction as the API returns it, coordinates flattened out of PostGIS. */
export interface AddressCorrectionView {
  readonly id: string;
  readonly addressId: string;
  readonly status: AddressCorrectionStatus;
  readonly from: Coordinates | null;
  readonly to: Coordinates;
  readonly distanceMovedM: number | null;
  readonly accuracyM: number | null;
  readonly confidenceBefore: number | null;
  readonly accessNotes: string | null;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly correctedByUserId: string;
  readonly driverId: string | null;
  readonly reviewedByUserId: string | null;
  readonly reviewedAt: Date | null;
  readonly reviewNote: string | null;
  /**
   * What the reviewer needs to recognise the place; never the recipient. NULL
   * when the caller can no longer see the address (a driver replaying a
   * correction after the parcel moved to a colleague).
   */
  readonly address: { readonly rawInput: string; readonly city: string | null } | null;
}

/** The outcome of a submission: the correction, and whether it was a replay. */
export interface CorrectionOutcome {
  readonly correction: AddressCorrectionView;
  readonly replayed: boolean;
}

export interface CorrectionPage {
  readonly items: readonly AddressCorrectionView[];
  readonly nextCursor: string | null;
}

/** The address row a correction is decided against, read under its lock. */
interface LockedAddress {
  readonly id: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly geocodeConfidence: number | null;
  readonly geocodeSource: string;
  readonly locationObservedAt: Date | null;
}

const KEY_CONSTRAINT = "address_corrections_tenant_idempotency_uq";
const DEFAULT_PAGE = 50;

/**
 * Driver geocode corrections (docs/01-mvp-scope.md 2.10, P0; docs/03 command
 * `CorrectAddressGeocode`).
 *
 * Every correction is recorded as a fact in `address_corrections` (0051), then
 * one of three things happens to the pin:
 *
 *   - applied now, when the move is ≤ 2 km or there was no pin;
 *   - held for a dispatcher, when it is > 2 km (the documented guard);
 *   - not applied (SUPERSEDED), when the phone observed it BEFORE the pin the
 *     address already carries. The driver app is offline-first and syncs
 *     late, so arrival order is not observation order, and the older fix must
 *     never put back a pin someone has since corrected.
 *
 * "Newer" is decided by `addresses.location_observed_at` under the address row
 * lock, never by reading the correction log: under a driver session RLS shows
 * only that driver's own corrections, so the log cannot see a colleague's.
 *
 * Who may correct what is RLS (0050): a driver session reaches only addresses
 * on its own shipments, route stops and pickups, so a colleague's address is a
 * 404, decided by PostgreSQL rather than by this class remembering to check.
 */
@Injectable()
export class AddressCorrectionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Records a correction and applies it, holds it, or supersedes it.
   *
   * Idempotent on `idempotencyKey` (I29 shape): the same caller sending the
   * same request again gets the recorded outcome with `replayed: true`; the
   * key on any other request is `422 IDEMPOTENCY_KEY_REUSED`, which says
   * nothing about the earlier use.
   */
  async submit(addressId: string, input: unknown): Promise<CorrectionOutcome> {
    const dto = parseWithZod(correctAddressSchema, input);
    const actor = requireActor();
    // Device time, refused when far ahead and clamped when slightly ahead: a
    // phone with a wrong clock must never make its pin "newest" for ever.
    const occurredAt = resolveDeviceTime(dto.occurredAt);
    const requestHash = requestFingerprint({ ...dto, addressId });

    try {
      return await this.database.withTenant(async (tx) => {
        // Looked up before the address, so a retry is answered even when the
        // parcel has since moved to a colleague and the address is out of reach.
        const early = await this.replayOf(tx, dto.idempotencyKey, actor.userId, requestHash);
        if (early !== undefined) {
          return early;
        }

        // The lock serialises corrections of one address, so an identical retry
        // racing the original waits for it here and is then a replay, not a 422.
        const address = await lockAddress(tx, addressId);
        const raced = await this.replayOf(tx, dto.idempotencyKey, actor.userId, requestHash);
        if (raced !== undefined) {
          return raced;
        }
        const to = dto.coordinates;
        const distanceMovedM = await distanceFromPin(tx, address, to);
        const status = decide(address, occurredAt, distanceMovedM);

        const inserted = await tx
          .insert(addressCorrections)
          .values({
            tenantId: TenantContext.requireTenantId(),
            addressId: address.id,
            idempotencyKey: dto.idempotencyKey,
            requestHash,
            correctedByUserId: actor.userId,
            driverId: actor.driverId,
            // Copied in SQL from the row itself, so the evidence is exactly the
            // pin that was there, with no float round trip.
            fromLocation: sql`(SELECT location FROM addresses WHERE id = ${address.id})`,
            toLocation: pointOf(to),
            distanceMovedM,
            accuracyM: dto.accuracyM ?? null,
            confidenceBefore:
              address.geocodeConfidence === null ? null : address.geocodeConfidence.toString(),
            accessNotes: dto.accessNotes ?? null,
            status,
            occurredAt,
          })
          .returning({ id: addressCorrections.id });
        const correctionId = inserted[0]?.id;
        if (correctionId === undefined) {
          throw new Error("Address correction insert returned no row");
        }

        if (status === "APPLIED") {
          await this.applyPin(tx, address, {
            correctionId,
            to,
            distanceMovedM,
            accessNotes: dto.accessNotes ?? null,
            occurredAt,
            driverId: actor.driverId,
            decision: "APPLIED",
          });
        }
        return { correction: await this.viewOf(tx, correctionId), replayed: false };
      });
    } catch (error) {
      // One key racing on two addresses, or a key a colleague already used
      // (their row is invisible to this session): the unique index decides.
      if (isUniqueViolation(error, KEY_CONSTRAINT)) {
        throw idempotencyKeyReused();
      }
      throw error;
    }
  }

  /** The review queue and correction history, oldest first (UUIDv7 keyset). */
  async list(input: unknown): Promise<CorrectionPage> {
    const dto = parseWithZod(listCorrectionsSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE;
    return this.database.withTenant(async (tx) => {
      const filters: SQL[] = [];
      if (dto.status !== undefined) filters.push(eq(addressCorrections.status, dto.status));
      if (dto.addressId !== undefined)
        filters.push(eq(addressCorrections.addressId, dto.addressId));
      if (dto.cursor !== undefined) filters.push(gt(addressCorrections.id, dto.cursor));
      const rows = await selectViews(tx, and(...filters), limit + 1);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last !== undefined ? last.id : null,
      };
    });
  }

  /** How many corrections wait for a dispatcher (sidebar badge). */
  async pendingCount(): Promise<number> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ value: count() })
        .from(addressCorrections)
        .where(eq(addressCorrections.status, "PENDING_REVIEW"));
      return rows[0]?.value ?? 0;
    });
  }

  async getById(id: string): Promise<AddressCorrectionView> {
    return this.database.withTenant((tx) => this.viewOf(tx, id));
  }

  /**
   * Applies a held correction. Re-approving an approved one returns it
   * unchanged. If a newer pin was set while it waited, it is SUPERSEDED
   * instead: approving it would move the pin back in time.
   */
  async approve(id: string, input: unknown): Promise<AddressCorrectionView> {
    const dto = parseWithZod(reviewCorrectionSchema, input);
    const reviewer = requireActor();
    return this.database.withTenant(async (tx) => {
      const row = await lockCorrection(tx, id);
      if (row.status === "APPROVED") {
        return this.viewOf(tx, id);
      }
      assertReviewable(row, reviewer.userId);

      const address = await lockAddress(tx, row.addressId);
      const overtaken =
        address.locationObservedAt !== null && row.occurredAt <= address.locationObservedAt;
      await tx
        .update(addressCorrections)
        .set({
          status: overtaken ? "SUPERSEDED" : "APPROVED",
          reviewedByUserId: reviewer.userId,
          reviewedAt: sql`now()`,
          reviewNote: dto.note ?? null,
        })
        .where(eq(addressCorrections.id, id));

      if (!overtaken) {
        const to = { lat: row.toLat, lng: row.toLng };
        await this.applyPin(tx, address, {
          correctionId: id,
          to,
          // From the pin as it is now, which may not be the one the driver saw.
          distanceMovedM: await distanceFromPin(tx, address, to),
          accessNotes: row.accessNotes,
          occurredAt: row.occurredAt,
          driverId: row.driverId,
          decision: "APPROVED",
        });
      }
      return this.viewOf(tx, id);
    });
  }

  /** Refuses a held correction. The address never changed, so nothing is undone. */
  async reject(id: string, input: unknown): Promise<AddressCorrectionView> {
    const dto = parseWithZod(reviewCorrectionSchema, input);
    const reviewer = requireActor();
    return this.database.withTenant(async (tx) => {
      const row = await lockCorrection(tx, id);
      if (row.status === "REJECTED") {
        return this.viewOf(tx, id);
      }
      assertReviewable(row, reviewer.userId);
      await tx
        .update(addressCorrections)
        .set({
          status: "REJECTED",
          reviewedByUserId: reviewer.userId,
          reviewedAt: sql`now()`,
          reviewNote: dto.note ?? null,
        })
        .where(eq(addressCorrections.id, id));
      await this.audit.record(tx, {
        action: "address.geocode_correction_rejected",
        resourceType: "address",
        resourceId: row.addressId,
        context: { correctionId: id, distanceMovedM: row.distanceMovedM },
      });
      return this.viewOf(tx, id);
    });
  }

  /**
   * Moves the pin, announces it, and audits it, all in the caller's
   * transaction. The "before" is the address as locked now, which for an
   * approval may differ from the pin the driver saw.
   */
  private async applyPin(
    tx: TenantTransaction,
    address: LockedAddress,
    change: {
      readonly correctionId: string;
      readonly to: Coordinates;
      readonly distanceMovedM: number | null;
      readonly accessNotes: string | null;
      readonly occurredAt: Date;
      readonly driverId: string | null;
      readonly decision: "APPLIED" | "APPROVED";
    },
  ): Promise<void> {
    const { distanceMovedM } = change;
    await tx
      .update(addresses)
      .set({
        location: pointOf(change.to),
        geocodeConfidence: DRIVER_CORRECTION_CONFIDENCE.toString(),
        geocodeSource: "driver_corrected",
        locationObservedAt: change.occurredAt,
        ...(change.accessNotes === null ? {} : { accessNotes: change.accessNotes }),
        updatedAt: sql`now()`,
      })
      .where(eq(addresses.id, address.id));

    const before =
      address.latitude === null || address.longitude === null
        ? null
        : { lat: address.latitude, lng: address.longitude };

    // Self-contained (docs/03 payload): consumers invalidate cached matrices
    // and re-score the address without reading this module's tables.
    await this.outbox.publish(tx, {
      eventType: "address.geocode_corrected",
      aggregateType: "address",
      aggregateId: address.id,
      payload: {
        addressId: address.id,
        correctionId: change.correctionId,
        oldLocation: before,
        newLocation: change.to,
        distanceMovedM,
        correctedByDriverId: change.driverId,
        confidenceBefore: address.geocodeConfidence,
        confidenceAfter: DRIVER_CORRECTION_CONFIDENCE,
        decision: change.decision,
        occurredAt: change.occurredAt.toISOString(),
      },
    });

    await this.audit.record(tx, {
      action: "address.geocode_corrected",
      resourceType: "address",
      resourceId: address.id,
      // `pin*`, not `geocode*`: the trail redacts any field whose name contains
      // "code", and these values are not secrets.
      changes: {
        latitude: { from: address.latitude, to: change.to.lat },
        longitude: { from: address.longitude, to: change.to.lng },
        pinSource: { from: address.geocodeSource, to: "driver_corrected" },
        pinConfidence: { from: address.geocodeConfidence, to: DRIVER_CORRECTION_CONFIDENCE },
      },
      // Free-text access notes can carry a phone number or a name; the trail
      // keeps seven years, so it records that they changed, not what they say.
      context: {
        correctionId: change.correctionId,
        decision: change.decision,
        distanceMovedM,
        accessNotesChanged: change.accessNotes !== null,
      },
    });
  }

  /** The recorded outcome for a key this caller already used for this request. */
  private async replayOf(
    tx: TenantTransaction,
    key: string,
    actorId: string,
    requestHash: string,
  ): Promise<CorrectionOutcome | undefined> {
    const prior = await findByKey(tx, key);
    if (prior === undefined) {
      return undefined;
    }
    if (prior.correctedByUserId !== actorId || prior.requestHash !== requestHash) {
      throw idempotencyKeyReused();
    }
    return { correction: await this.viewOf(tx, prior.id), replayed: true };
  }

  private async viewOf(tx: TenantTransaction, id: string): Promise<AddressCorrectionView> {
    const row = (await selectViews(tx, eq(addressCorrections.id, id), 1))[0];
    if (row === undefined) {
      throw new NotFoundError("Address correction");
    }
    return row;
  }
}

// ── Rules ────────────────────────────────────────────────────────────────────

/** What happens to a new correction. Order matters: an older fix is never applied. */
function decide(
  address: LockedAddress,
  occurredAt: Date,
  distanceMovedM: number | null,
): AddressCorrectionStatus {
  if (address.locationObservedAt !== null && occurredAt <= address.locationObservedAt) {
    return "SUPERSEDED";
  }
  if (distanceMovedM !== null && distanceMovedM > CORRECTION_REVIEW_DISTANCE_M) {
    return "PENDING_REVIEW";
  }
  return "APPLIED";
}

function assertReviewable(row: LockedCorrection, reviewerId: string): void {
  if (row.status !== "PENDING_REVIEW") {
    throw new ConflictError(
      "CORRECTION_NOT_PENDING",
      `This correction is ${row.status} and can no longer be reviewed`,
    );
  }
  // Separation of duties: an OWNER holds both address:correct and
  // address:review, and a large move is reviewed precisely because the person
  // who made it might be wrong.
  if (row.correctedByUserId === reviewerId) {
    throw new ForbiddenError("A correction is reviewed by someone other than its author");
  }
}

/** The authenticated caller. A correction always names a person. */
function requireActor(): { readonly userId: string; readonly driverId: string | null } {
  const state = TenantContext.current();
  if (state?.actorId === undefined) {
    throw new UnauthenticatedError();
  }
  return { userId: state.actorId, driverId: state.driverId ?? null };
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** A geography point literal for INSERT/UPDATE — lng first, per PostGIS. */
function pointOf(coordinates: Coordinates): SQL {
  return sql`ST_SetSRID(ST_MakePoint(${coordinates.lng}, ${coordinates.lat}), 4326)::geography`;
}

async function lockAddress(tx: TenantTransaction, id: string): Promise<LockedAddress> {
  const rows = await tx
    .select({
      id: addresses.id,
      latitude: sql<number | null>`ST_Y(${addresses.location}::geometry)`,
      longitude: sql<number | null>`ST_X(${addresses.location}::geometry)`,
      geocodeConfidence: addresses.geocodeConfidence,
      geocodeSource: addresses.geocodeSource,
      locationObservedAt: addresses.locationObservedAt,
    })
    .from(addresses)
    .where(eq(addresses.id, id))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError("Address");
  }
  return {
    ...row,
    geocodeConfidence: row.geocodeConfidence === null ? null : Number(row.geocodeConfidence),
  };
}

/** Metres from the address's current pin, rounded; NULL when it has none. */
async function distanceFromPin(
  tx: TenantTransaction,
  address: LockedAddress,
  to: Coordinates,
): Promise<number | null> {
  if (address.latitude === null || address.longitude === null) {
    return null;
  }
  const rows = await tx
    .select({
      metres: sql<number>`round(ST_Distance(${addresses.location}, ${pointOf(to)}))::int`,
    })
    .from(addresses)
    .where(eq(addresses.id, address.id));
  return rows[0]?.metres ?? null;
}

async function findByKey(
  tx: TenantTransaction,
  key: string,
): Promise<
  | { readonly id: string; readonly correctedByUserId: string; readonly requestHash: string }
  | undefined
> {
  const rows = await tx
    .select({
      id: addressCorrections.id,
      correctedByUserId: addressCorrections.correctedByUserId,
      requestHash: addressCorrections.requestHash,
    })
    .from(addressCorrections)
    .where(eq(addressCorrections.idempotencyKey, key))
    .limit(1);
  return rows[0];
}

interface LockedCorrection {
  readonly id: string;
  readonly addressId: string;
  readonly status: AddressCorrectionStatus;
  readonly correctedByUserId: string;
  readonly driverId: string | null;
  readonly toLat: number;
  readonly toLng: number;
  readonly distanceMovedM: number | null;
  readonly accessNotes: string | null;
  readonly occurredAt: Date;
}

async function lockCorrection(tx: TenantTransaction, id: string): Promise<LockedCorrection> {
  const rows = await tx
    .select({
      id: addressCorrections.id,
      addressId: addressCorrections.addressId,
      status: addressCorrections.status,
      correctedByUserId: addressCorrections.correctedByUserId,
      driverId: addressCorrections.driverId,
      toLat: sql<number>`ST_Y(${addressCorrections.toLocation}::geometry)`,
      toLng: sql<number>`ST_X(${addressCorrections.toLocation}::geometry)`,
      distanceMovedM: addressCorrections.distanceMovedM,
      accessNotes: addressCorrections.accessNotes,
      occurredAt: addressCorrections.occurredAt,
    })
    .from(addressCorrections)
    .where(eq(addressCorrections.id, id))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError("Address correction");
  }
  return { ...row, status: toStatus(row.status) };
}

async function selectViews(
  tx: TenantTransaction,
  where: SQL | undefined,
  limit: number,
): Promise<AddressCorrectionView[]> {
  const rows = await tx
    .select({
      id: addressCorrections.id,
      addressId: addressCorrections.addressId,
      status: addressCorrections.status,
      fromLat: sql<number | null>`ST_Y(${addressCorrections.fromLocation}::geometry)`,
      fromLng: sql<number | null>`ST_X(${addressCorrections.fromLocation}::geometry)`,
      toLat: sql<number>`ST_Y(${addressCorrections.toLocation}::geometry)`,
      toLng: sql<number>`ST_X(${addressCorrections.toLocation}::geometry)`,
      distanceMovedM: addressCorrections.distanceMovedM,
      accuracyM: addressCorrections.accuracyM,
      confidenceBefore: addressCorrections.confidenceBefore,
      accessNotes: addressCorrections.accessNotes,
      occurredAt: addressCorrections.occurredAt,
      recordedAt: addressCorrections.recordedAt,
      correctedByUserId: addressCorrections.correctedByUserId,
      driverId: addressCorrections.driverId,
      reviewedByUserId: addressCorrections.reviewedByUserId,
      reviewedAt: addressCorrections.reviewedAt,
      reviewNote: addressCorrections.reviewNote,
      rawInput: addresses.rawInput,
      city: addresses.city,
    })
    .from(addressCorrections)
    // Under the caller's own addresses policy: what they cannot see stays NULL.
    .leftJoin(addresses, eq(addresses.id, addressCorrections.addressId))
    .where(where)
    .orderBy(asc(addressCorrections.id))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    addressId: row.addressId,
    status: toStatus(row.status),
    from:
      row.fromLat === null || row.fromLng === null ? null : { lat: row.fromLat, lng: row.fromLng },
    to: { lat: row.toLat, lng: row.toLng },
    distanceMovedM: row.distanceMovedM,
    accuracyM: row.accuracyM,
    // numeric arrives as a string from the driver; expose a real number.
    confidenceBefore: row.confidenceBefore === null ? null : Number(row.confidenceBefore),
    accessNotes: row.accessNotes,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    correctedByUserId: row.correctedByUserId,
    driverId: row.driverId,
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
    address: row.rawInput === null ? null : { rawInput: row.rawInput, city: row.city },
  }));
}

const STATUSES: ReadonlySet<string> = new Set<string>(ADDRESS_CORRECTION_STATUSES);

function isStatus(value: string): value is AddressCorrectionStatus {
  return STATUSES.has(value);
}

/** The CHECK constraint guarantees the value; this narrows the type honestly. */
function toStatus(value: string): AddressCorrectionStatus {
  if (!isStatus(value)) {
    throw new Error(`Unknown address correction status: ${value}`);
  }
  return value;
}
