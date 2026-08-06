import { Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gt, lt, sql } from "drizzle-orm";

import type { TenantTransaction } from "../../../shared/database/index.js";
import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import { isUniqueViolation } from "../../../shared/database/pg-errors.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/zod-parse.js";
import { OutboxService } from "../../platform/index.js";
import {
  acceptPickupRequestSchema,
  assignPickupRequestSchema,
  batchScanPickupSchema,
  cancelPickupRequestSchema,
  claimPickupRequestSchema,
  collectPickupRequestSchema,
  completePickupRequestSchema,
  createPickupRequestSchema,
  scanPickupSchema,
} from "../domain/dtos.js";
import type { CreatePickupRequestInput, SelectionMode } from "../domain/dtos.js";
import { formatPickupCode } from "../domain/pickup-code.js";
import { canPickupTransition, toPickupStatus } from "../domain/pickup-status.js";
import type { PickupStatus } from "../domain/pickup-status.js";
import { pickupRequests, pickupShipments } from "../domain/schema.js";
import type { PickupRequest } from "../domain/schema.js";

const CODE_ALLOCATION_RETRIES = 5;

interface CommandContext {
  readonly actorId: string;
}

export interface ListPickupRequestsParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: string;
  readonly merchantId?: string;
  readonly driverId?: string;
}

export interface PickupRequestPage {
  readonly items: readonly PickupRequest[];
  readonly nextCursor: string | null;
}

/** Reconciliation state of one pickup: expected = total − scanned − missing. */
export interface ScanSummary {
  readonly total: number;
  readonly scanned: number;
  readonly missing: number;
}

/** One parcel moved from EXPECTED to SCANNED. */
export interface AppliedScan {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly scanStatus: string;
  /** Device clock, not server clock — see `pickup_shipments.scanned_at`. */
  readonly scannedAt: Date;
}

export interface ScanResult extends AppliedScan {
  readonly summary: ScanSummary;
}

/**
 * The per-item verdict of an offline sync, in the vocabulary the driver app
 * already speaks (docs/05-api-contracts.md driver sync contract): `status` says
 * what happened, `action` says what the device should do about it.
 */
export interface ScanItemResult {
  readonly index: number;
  readonly trackingNumber: string;
  readonly status: "ACCEPTED" | "REJECTED" | "CONFLICT";
  readonly action: "DISCARD_AND_REFRESH" | "RETRY_LATER" | "ESCALATE_TO_DISPATCHER" | null;
  readonly reason: string | null;
  readonly shipmentId: string | null;
}

export interface BatchScanResult {
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly results: readonly ScanItemResult[];
  readonly summary: ScanSummary;
}

/** What one scan needs to be recorded, shared by the online and offline paths. */
interface ScanCommand {
  readonly trackingNumber: string;
  readonly idempotencyKey: string;
  readonly scannedAt: Date;
  readonly driverId: string;
}

export interface PickupShipmentView {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly scanStatus: string;
  readonly scannedAt: Date | null;
  readonly recordedAt: Date | null;
  readonly scannedByDriverId: string | null;
}

export interface PickupManifest {
  readonly shipments: readonly PickupShipmentView[];
  readonly summary: ScanSummary;
}

@Injectable()
export class PickupService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
  ) {}

  async request(input: unknown, ctx: CommandContext): Promise<PickupRequest> {
    const dto = parseWithZod(createPickupRequestSchema, input);
    validateWindow(dto);

    // Presence of shipmentIds is the mode selector: the merchant either names the
    // parcels (EXPLICIT) or delegates selection to the system (MERCHANT_READY).
    const explicitIds = dto.shipmentIds;
    const selectionMode: SelectionMode = explicitIds === undefined ? "MERCHANT_READY" : "EXPLICIT";

    for (let attempt = 0; attempt < CODE_ALLOCATION_RETRIES; attempt += 1) {
      try {
        return await this.database.withTenant(async (tx) => {
          await validateMerchantActive(tx, dto.merchantId);

          // EXPLICIT vs MERCHANT_READY differ in how they treat a parcel that is
          // already out with another driver. Named by the merchant → tell them it
          // is unavailable. Chosen by the system → it simply is not available, so
          // skip it; erroring would block every later automatic pickup behind one
          // open request.
          let resolved: ResolvedShipment[];
          if (explicitIds === undefined) {
            resolved = await findMerchantReadyShipments(tx, dto.merchantId);
          } else {
            resolved = await resolveExplicitShipments(tx, explicitIds);
            await validateNotAlreadyLinked(
              tx,
              resolved.map((s) => s.id),
            );
          }

          const tenantId = TenantContext.requireTenantId();
          const ordinal = await nextOrdinal(tx);
          const code = formatPickupCode(new Date(), ordinal);

          const rows = await tx
            .insert(pickupRequests)
            .values({
              tenantId,
              code,
              merchantId: dto.merchantId,
              pickupAddressId: dto.pickupAddressId,
              contactName: dto.contactName,
              contactPhone: dto.contactPhone,
              requestedWindowFrom: dto.requestedWindowFrom,
              requestedWindowTo: dto.requestedWindowTo,
              estimatedParcelCount: resolved.length,
              selectionMode,
              requestedByUserId: ctx.actorId,
              ...(dto.notes === undefined ? {} : { notes: dto.notes }),
            })
            .returning();
          const row = rows[0];
          if (row === undefined) throw new Error("Insert returned no row");

          if (resolved.length > 0) {
            await tx.insert(pickupShipments).values(
              resolved.map((s) => ({
                tenantId,
                pickupRequestId: row.id,
                shipmentId: s.id,
                trackingNumber: s.trackingNumber,
              })),
            );
          }

          await this.outbox.publish(tx, {
            eventType: "pickup.requested",
            aggregateType: "pickup_request",
            aggregateId: row.id,
            payload: {
              pickupRequestId: row.id,
              code: row.code,
              merchantId: row.merchantId,
              pickupAddressId: row.pickupAddressId,
              estimatedParcelCount: row.estimatedParcelCount,
              selectionMode,
              shipmentIds: resolved.map((s) => s.id),
              requestedWindowFrom: row.requestedWindowFrom.toISOString(),
              requestedWindowTo: row.requestedWindowTo.toISOString(),
            },
          });

          return row;
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error, "pickup_requests_tenant_code_uq")) continue;
        throw error;
      }
    }
    throw new ConflictError(
      "PICKUP_CODE_COLLISION",
      "Pickup request code collision after retries — please retry",
    );
  }

  async accept(id: string, input: unknown, ctx: CommandContext): Promise<PickupRequest> {
    parseWithZod(acceptPickupRequestSchema, input);
    return this.transition(id, "ACCEPTED", ctx, (tx, row) =>
      tx
        .update(pickupRequests)
        .set({
          status: "ACCEPTED" as const,
          acceptedAt: new Date(),
          acceptedByUserId: ctx.actorId,
          updatedAt: new Date(),
        })
        .where(eq(pickupRequests.id, row.id))
        .returning()
        .then((rows) => requireRow(rows)),
    );
  }

  /** Dispatch names who will go and collect. Requires `pickup:assign`. */
  async assign(id: string, input: unknown, ctx: CommandContext): Promise<PickupRequest> {
    const dto = parseWithZod(assignPickupRequestSchema, input);
    return this.assignTo(id, dto.driverId, dto.routeStopId, ctx);
  }

  /**
   * The caller takes the run themselves. Requires `pickup:claim`.
   *
   * The collector is `ctx.actorId` — read from the verified token, never from
   * the body — so this command cannot assign work to anyone else. That is the
   * whole reason it exists separately from {@link assign}: a COMMERCIAL must be
   * able to collect their own merchants' parcels without being able to route
   * the fleet, and a permission that could do both would be `pickup:assign`
   * under a friendlier name.
   *
   * Which pickups they can reach is already settled by RLS — a commercial only
   * sees `pickup_requests` for merchants in their portfolio (invariant I25) —
   * so an out-of-portfolio id is a 404 here, not a forbidden.
   *
   * No route stop: a claimed run is an errand, not a planned stop on an
   * optimised route. If it needs to be sequenced, dispatch assigns it.
   */
  async claim(id: string, input: unknown, ctx: CommandContext): Promise<PickupRequest> {
    parseWithZod(claimPickupRequestSchema, input);
    return this.assignTo(id, ctx.actorId, undefined, ctx);
  }

  /**
   * The one implementation of "this pickup now has a collector".
   *
   * Shared so the state-machine check, the outbox event, and the audit trail
   * are identical whichever way the collector was chosen — a second copy would
   * be a second place for `assign` and `claim` to drift apart.
   *
   * `collectorId` is a bare user id by design: `assigned_driver_id` carries no
   * foreign key to `drivers`, because the person who physically collects is not
   * always a driver. A commercial is the case that proves it.
   */
  private async assignTo(
    id: string,
    collectorId: string,
    routeStopId: string | undefined,
    ctx: CommandContext,
  ): Promise<PickupRequest> {
    return this.transition(id, "ASSIGNED", ctx, (tx, row) =>
      tx
        .update(pickupRequests)
        .set({
          status: "ASSIGNED" as const,
          assignedDriverId: collectorId,
          assignedAt: new Date(),
          ...(routeStopId === undefined ? {} : { assignedRouteStopId: routeStopId }),
          updatedAt: new Date(),
        })
        .where(eq(pickupRequests.id, row.id))
        .returning()
        .then((rows) => requireRow(rows)),
    );
  }

  /** Online single scan. The driver is connected, so `scannedAt` may be omitted. */
  async scan(id: string, input: unknown, ctx: CommandContext): Promise<ScanResult> {
    const dto = parseWithZod(scanPickupSchema, input);
    return this.database.withTenant(async (tx) => {
      const pickup = await lockAssignedPickup(tx, id);
      const applied = await this.applyScan(tx, pickup, {
        trackingNumber: dto.trackingNumber,
        idempotencyKey: dto.idempotencyKey,
        scannedAt: dto.scannedAt ?? new Date(),
        driverId: ctx.actorId,
      });
      return { ...applied, summary: await computeScanSummary(tx, pickup.id) };
    });
  }

  /**
   * Offline batch sync — the driver app replaying a queue of scans taken with no
   * connection.
   *
   * Never all-or-nothing: one unknown barcode must not discard 199 good scans, so
   * each item gets its own verdict and its own client action. The summary is
   * computed ONCE at the end rather than per item — a 200-scan sync would
   * otherwise fire 200 extra aggregate queries inside one transaction.
   */
  async scanBatch(id: string, input: unknown, ctx: CommandContext): Promise<BatchScanResult> {
    const dto = parseWithZod(batchScanPickupSchema, input);
    return this.database.withTenant(async (tx) => {
      const pickup = await lockAssignedPickup(tx, id);

      const results: ScanItemResult[] = [];
      let accepted = 0;

      for (const [index, item] of dto.scans.entries()) {
        try {
          const applied = await this.applyScan(tx, pickup, {
            trackingNumber: item.trackingNumber,
            idempotencyKey: item.idempotencyKey,
            scannedAt: item.scannedAt,
            driverId: ctx.actorId,
          });
          results.push({
            index,
            trackingNumber: item.trackingNumber,
            status: "ACCEPTED",
            action: null,
            reason: null,
            shipmentId: applied.shipmentId,
          });
          accepted += 1;
        } catch (error: unknown) {
          results.push(classifyScanError(index, item.trackingNumber, error));
        }
      }

      return {
        total: dto.scans.length,
        accepted,
        rejected: dto.scans.length - accepted,
        results,
        summary: await computeScanSummary(tx, pickup.id),
      };
    });
  }

  async collect(id: string, input: unknown, ctx: CommandContext): Promise<PickupRequest> {
    const dto = parseWithZod(collectPickupRequestSchema, input);
    return this.transition(id, "COLLECTED", ctx, async (tx, row) => {
      const scannedCount = await countByStatus(tx, row.id, "SCANNED");

      if (scannedCount === 0 && dto.outcomeReason === undefined) {
        throw new BusinessRuleError(
          "OUTCOME_REASON_REQUIRED",
          "A zero-parcel pickup requires an outcomeReason",
        );
      }

      await tx
        .update(pickupShipments)
        .set({ scanStatus: "MISSING" })
        .where(
          and(
            eq(pickupShipments.pickupRequestId, row.id),
            eq(pickupShipments.scanStatus, "EXPECTED"),
          ),
        );

      const updated = await tx
        .update(pickupRequests)
        .set({
          status: "COLLECTED" as const,
          actualParcelCount: scannedCount,
          collectedAt: new Date(),
          ...(dto.outcomeReason === undefined ? {} : { outcomeReason: dto.outcomeReason }),
          ...(dto.notes === undefined ? {} : { notes: dto.notes }),
          updatedAt: new Date(),
        })
        .where(eq(pickupRequests.id, row.id))
        .returning()
        .then((rows) => requireRow(rows));

      return updated;
    });
  }

  async complete(id: string, input: unknown, ctx: CommandContext): Promise<PickupRequest> {
    parseWithZod(completePickupRequestSchema, input);
    return this.transition(id, "COMPLETED", ctx, (tx, row) =>
      tx
        .update(pickupRequests)
        .set({
          status: "COMPLETED" as const,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(pickupRequests.id, row.id))
        .returning()
        .then((rows) => requireRow(rows)),
    );
  }

  async cancel(id: string, input: unknown, ctx: CommandContext): Promise<PickupRequest> {
    const dto = parseWithZod(cancelPickupRequestSchema, input);
    return this.transition(id, "CANCELLED", ctx, (tx, row) =>
      tx
        .update(pickupRequests)
        .set({
          status: "CANCELLED" as const,
          cancelledAt: new Date(),
          cancellationReason: dto.reason,
          updatedAt: new Date(),
        })
        .where(eq(pickupRequests.id, row.id))
        .returning()
        .then((rows) => requireRow(rows)),
    );
  }

  async getById(id: string): Promise<PickupRequest> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx.select().from(pickupRequests).where(eq(pickupRequests.id, id)).limit(1);
      const row = rows[0];
      if (row === undefined) throw new NotFoundError("PickupRequest");
      return row;
    });
  }

  async getByCode(code: string): Promise<PickupRequest> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(pickupRequests)
        .where(eq(pickupRequests.code, code))
        .limit(1);
      const row = rows[0];
      if (row === undefined) throw new NotFoundError("PickupRequest");
      return row;
    });
  }

  async list(params: ListPickupRequestsParams): Promise<PickupRequestPage> {
    const limit = params.limit ?? 50;
    return this.database.withTenant(async (tx) => {
      const conditions = [];
      if (params.status !== undefined) {
        conditions.push(eq(pickupRequests.status, params.status));
      }
      if (params.merchantId !== undefined) {
        conditions.push(eq(pickupRequests.merchantId, params.merchantId));
      }
      if (params.driverId !== undefined) {
        conditions.push(eq(pickupRequests.assignedDriverId, params.driverId));
      }
      if (params.cursor !== undefined) {
        conditions.push(lt(pickupRequests.id, params.cursor));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const rows = await tx
        .select()
        .from(pickupRequests)
        .where(where)
        .orderBy(desc(pickupRequests.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const lastItem = items.at(-1);
      const nextCursor = hasMore && lastItem !== undefined ? lastItem.id : null;

      return { items, nextCursor };
    });
  }

  async listByWindow(from: Date, to: Date, status?: string): Promise<readonly PickupRequest[]> {
    return this.database.withTenant(async (tx) => {
      const conditions = [
        lt(pickupRequests.requestedWindowFrom, to),
        gt(pickupRequests.requestedWindowTo, from),
      ];
      if (status !== undefined) {
        conditions.push(eq(pickupRequests.status, status));
      }
      return tx
        .select()
        .from(pickupRequests)
        .where(and(...conditions))
        .orderBy(asc(pickupRequests.requestedWindowFrom));
    });
  }

  /**
   * The pickup manifest: every expected parcel with its scan state, plus the
   * reconciliation counts. Both come from ONE transaction so the driver never
   * sees a summary that disagrees with the list it sits above.
   */
  async getManifest(id: string): Promise<PickupManifest> {
    return this.database.withTenant(async (tx) => {
      const owner = await tx
        .select({ id: pickupRequests.id })
        .from(pickupRequests)
        .where(eq(pickupRequests.id, id))
        .limit(1);
      if (owner[0] === undefined) throw new NotFoundError("PickupRequest");

      const shipments = await tx
        .select({
          shipmentId: pickupShipments.shipmentId,
          trackingNumber: pickupShipments.trackingNumber,
          scanStatus: pickupShipments.scanStatus,
          scannedAt: pickupShipments.scannedAt,
          recordedAt: pickupShipments.recordedAt,
          scannedByDriverId: pickupShipments.scannedByDriverId,
        })
        .from(pickupShipments)
        .where(eq(pickupShipments.pickupRequestId, id))
        .orderBy(asc(pickupShipments.createdAt));

      return { shipments, summary: await computeScanSummary(tx, id) };
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * The single scan path — both endpoints funnel through here so the barcode
   * rules, the conflict rules, and the emitted event cannot drift apart.
   *
   * The row lookup rides `pickup_shipments_tracking_idx`, so validating a barcode
   * stays an index probe no matter how many parcels the pickup holds.
   */
  private async applyScan(
    tx: TenantTransaction,
    pickup: PickupRequest,
    cmd: ScanCommand,
  ): Promise<AppliedScan> {
    const rows = await tx
      .select()
      .from(pickupShipments)
      .where(
        and(
          eq(pickupShipments.pickupRequestId, pickup.id),
          eq(pickupShipments.trackingNumber, cmd.trackingNumber),
        ),
      )
      .limit(1);
    const row = rows[0];

    if (row === undefined) {
      // A barcode nobody expected here: a mis-sorted parcel or a stale offline
      // queue. Never invented on the fly — a dispatcher decides what it belongs to.
      throw new BusinessRuleError(
        "BARCODE_NOT_IN_PICKUP",
        `Tracking number ${cmd.trackingNumber} is not expected in this pickup`,
      );
    }

    if (row.scanStatus === "SCANNED") {
      if (row.scannedByDriverId !== cmd.driverId) {
        throw new ConflictError(
          "SCAN_CONFLICT_DIFFERENT_DRIVER",
          `Shipment ${cmd.trackingNumber} was already scanned by a different driver`,
        );
      }
      // Replay of a scan this driver already recorded (offline retry): report the
      // STORED device time, not the replay time, so the audit trail stays honest.
      // No second event — one physical scan is one custody transfer.
      return {
        shipmentId: row.shipmentId,
        trackingNumber: row.trackingNumber,
        scanStatus: row.scanStatus,
        scannedAt: row.scannedAt ?? cmd.scannedAt,
      };
    }

    await tx
      .update(pickupShipments)
      .set({
        scanStatus: "SCANNED",
        scannedAt: cmd.scannedAt,
        recordedAt: new Date(),
        scannedByDriverId: cmd.driverId,
        idempotencyKey: cmd.idempotencyKey,
      })
      .where(eq(pickupShipments.id, row.id));

    // Self-contained (§2.2): the shipment module transfers custody from this
    // payload alone, without ever reading a pickup table.
    await this.outbox.publish(tx, {
      eventType: "pickup.parcel_scanned",
      aggregateType: "pickup_request",
      aggregateId: pickup.id,
      payload: {
        pickupRequestId: pickup.id,
        shipmentId: row.shipmentId,
        trackingNumber: row.trackingNumber,
        driverId: cmd.driverId,
        scannedAt: cmd.scannedAt.toISOString(),
      },
    });

    return {
      shipmentId: row.shipmentId,
      trackingNumber: row.trackingNumber,
      scanStatus: "SCANNED",
      scannedAt: cmd.scannedAt,
    };
  }

  private async transition(
    id: string,
    target: PickupStatus,
    ctx: CommandContext,
    apply: (tx: TenantTransaction, row: PickupRequest) => Promise<PickupRequest>,
  ): Promise<PickupRequest> {
    return this.database.withTenant(async (tx) => {
      const row = await lockPickup(tx, id);
      const current = toPickupStatus(row.status);
      if (!canPickupTransition(current, target)) {
        throw new BusinessRuleError(
          "PICKUP_INVALID_TRANSITION",
          `Cannot transition pickup request from ${current} to ${target}`,
        );
      }

      const updated = await apply(tx, row);

      const eventType = pickupEventType(target);
      const payload: Record<string, unknown> = {
        pickupRequestId: updated.id,
        code: updated.code,
        merchantId: updated.merchantId,
        status: updated.status,
        // Who caused the transition — consumers get the audit trail without
        // reaching back into the pickup module for it (events are self-contained).
        actorId: ctx.actorId,
      };

      if (target === "ASSIGNED") {
        payload["driverId"] = updated.assignedDriverId;
        payload["routeStopId"] = updated.assignedRouteStopId;
      }
      if (target === "COLLECTED") {
        payload["driverId"] = updated.assignedDriverId;
        payload["actualParcelCount"] = updated.actualParcelCount;
        payload["estimatedParcelCount"] = updated.estimatedParcelCount;
        payload["countVariance"] =
          (updated.estimatedParcelCount ?? 0) - (updated.actualParcelCount ?? 0);
        payload["outcomeReason"] = updated.outcomeReason;

        // One pass over the link rows, partitioned in memory: the collected and
        // missing sets come from the same index scan rather than two round trips.
        const linked = await tx
          .select({
            shipmentId: pickupShipments.shipmentId,
            scanStatus: pickupShipments.scanStatus,
          })
          .from(pickupShipments)
          .where(eq(pickupShipments.pickupRequestId, updated.id));

        payload["shipmentIds"] = linked
          .filter((r) => r.scanStatus === "SCANNED")
          .map((r) => r.shipmentId);
        payload["missingShipmentIds"] = linked
          .filter((r) => r.scanStatus === "MISSING")
          .map((r) => r.shipmentId);
      }
      if (target === "CANCELLED") {
        payload["reason"] = updated.cancellationReason;
      }

      await this.outbox.publish(tx, {
        eventType,
        aggregateType: "pickup_request",
        aggregateId: updated.id,
        payload,
      });

      return updated;
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pickupEventType(status: PickupStatus): string {
  const map: Record<PickupStatus, string> = {
    REQUESTED: "pickup.requested",
    ACCEPTED: "pickup.accepted",
    ASSIGNED: "pickup.assigned",
    COLLECTED: "pickup.collected",
    COMPLETED: "pickup.completed",
    CANCELLED: "pickup.cancelled",
  };
  return map[status];
}

function validateWindow(dto: CreatePickupRequestInput): void {
  if (dto.requestedWindowTo.getTime() <= dto.requestedWindowFrom.getTime()) {
    throw new BusinessRuleError(
      "PICKUP_WINDOW_INVALID",
      "requestedWindowTo must be after requestedWindowFrom",
    );
  }
}

async function validateMerchantActive(tx: TenantTransaction, merchantId: string): Promise<void> {
  const rows = await tx
    .select({ status: sql<string>`status` })
    .from(sql`merchants`)
    .where(sql`id = ${merchantId}`)
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError("Merchant");
  if (row.status !== "ACTIVE") {
    throw new BusinessRuleError(
      "MERCHANT_SUSPENDED",
      "Merchant is suspended — cannot accept pickup requests",
    );
  }
}

interface ResolvedShipment {
  readonly id: string;
  readonly trackingNumber: string;
}

/**
 * A parameterised `IN (…)` list of uuids.
 *
 * One bind per id — never interpolated text. A JS array cannot be bound to
 * `= ANY($1::uuid[])` through this driver (docs/traps.md), so an explicit list of
 * placeholders is the way to keep the query both correct and injection-free.
 */
function uuidList(ids: readonly string[]): ReturnType<typeof sql.join> {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/**
 * EXPLICIT selection: the merchant named these shipments.
 *
 * A cross-module read by raw SQL, not an import — pickup and shipment are both
 * Layer 2 (context-map §2.1). RLS scopes it to the tenant automatically, so a
 * shipment from another tenant reads as "not found", never as someone else's row.
 */
async function resolveExplicitShipments(
  tx: TenantTransaction,
  shipmentIds: readonly string[],
): Promise<ResolvedShipment[]> {
  if (shipmentIds.length === 0) return [];

  const rows: Array<{ id: string; trackingNumber: string; status: string }> = await tx
    .select({
      id: sql<string>`id`,
      trackingNumber: sql<string>`tracking_number`,
      status: sql<string>`status`,
    })
    .from(sql`shipments`)
    .where(sql`id IN (${uuidList(shipmentIds)})`);

  if (rows.length !== shipmentIds.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = shipmentIds.find((id) => !found.has(id));
    throw new NotFoundError(`Shipment ${missing}`);
  }

  const nonCreated = rows.find((r) => r.status !== "CREATED");
  if (nonCreated !== undefined) {
    throw new BusinessRuleError(
      "SHIPMENT_NOT_ELIGIBLE",
      `Shipment ${nonCreated.id} is in status ${nonCreated.status} — only CREATED shipments can be linked to a pickup`,
    );
  }

  return rows.map((r) => ({ id: r.id, trackingNumber: r.trackingNumber }));
}

/**
 * MERCHANT_READY selection: every shipment the merchant has entered that nobody
 * has taken yet.
 *
 * CREATED is the eligibility criterion because that is exactly what it means — a
 * shipment with a tracking number, not yet in anyone's custody. There is no
 * separate READY_FOR_PICKUP status and adding one would ripple through the whole
 * shipment state machine for no gain.
 *
 * The NOT EXISTS filters out parcels already committed to a live pickup, in the
 * same index scan rather than a second round trip. Automatic selection SKIPS
 * those instead of failing: a merchant with one pickup already out must still be
 * able to request another for the parcels they packed since.
 */
async function findMerchantReadyShipments(
  tx: TenantTransaction,
  merchantId: string,
): Promise<ResolvedShipment[]> {
  const rows: Array<{ id: string; trackingNumber: string }> = await tx
    .select({
      id: sql<string>`s.id`,
      trackingNumber: sql<string>`s.tracking_number`,
    })
    .from(sql`shipments s`)
    .where(
      sql`s.merchant_id = ${merchantId}
          AND s.status = 'CREATED'
          AND NOT EXISTS (
            SELECT 1
              FROM pickup_shipments ps
              JOIN pickup_requests pr ON pr.id = ps.pickup_request_id
             WHERE ps.shipment_id = s.id
               AND pr.status NOT IN ('COMPLETED', 'CANCELLED')
          )`,
    );

  return rows.map((r) => ({ id: r.id, trackingNumber: r.trackingNumber }));
}

/**
 * A parcel can be in at most one live pickup: two drivers dispatched for the same
 * box is a custody ambiguity we refuse to create. Closed pickups (COMPLETED /
 * CANCELLED) do not block, so a re-collection after a failed trip is allowed.
 */
async function validateNotAlreadyLinked(
  tx: TenantTransaction,
  shipmentIds: readonly string[],
): Promise<void> {
  if (shipmentIds.length === 0) return;

  const rows: Array<{ shipmentId: string }> = await tx
    .select({ shipmentId: pickupShipments.shipmentId })
    .from(pickupShipments)
    .innerJoin(pickupRequests, eq(pickupShipments.pickupRequestId, pickupRequests.id))
    .where(
      sql`${pickupShipments.shipmentId} IN (${uuidList(shipmentIds)})
          AND ${pickupRequests.status} NOT IN ('COMPLETED', 'CANCELLED')`,
    )
    .limit(1);

  const dupe = rows[0];
  if (dupe !== undefined) {
    throw new BusinessRuleError(
      "SHIPMENT_ALREADY_IN_PICKUP",
      `Shipment ${dupe.shipmentId} is already linked to an active pickup request`,
    );
  }
}

async function nextOrdinal(tx: TenantTransaction): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const rows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(pickupRequests)
    .where(sql`created_at >= ${todayIso}::timestamptz`);
  return (rows[0]?.count ?? 0) + 1;
}

async function lockPickup(tx: TenantTransaction, id: string): Promise<PickupRequest> {
  const rows = await tx
    .select()
    .from(pickupRequests)
    .where(eq(pickupRequests.id, id))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (row === undefined) throw new NotFoundError("PickupRequest");
  return row;
}

/**
 * Locks a pickup and asserts it is out for collection.
 *
 * Scanning is only meaningful once a driver is on the job: before ASSIGNED nobody
 * is holding the parcels, and after COLLECTED the manifest is closed.
 */
async function lockAssignedPickup(tx: TenantTransaction, id: string): Promise<PickupRequest> {
  const pickup = await lockPickup(tx, id);
  const current = toPickupStatus(pickup.status);
  if (current !== "ASSIGNED") {
    throw new BusinessRuleError(
      "PICKUP_NOT_ASSIGNED",
      `Pickup must be in ASSIGNED status to scan parcels — it is ${current}`,
    );
  }
  return pickup;
}

async function countByStatus(
  tx: TenantTransaction,
  pickupRequestId: string,
  scanStatus: string,
): Promise<number> {
  const rows = await tx
    .select({ value: count() })
    .from(pickupShipments)
    .where(
      and(
        eq(pickupShipments.pickupRequestId, pickupRequestId),
        eq(pickupShipments.scanStatus, scanStatus),
      ),
    );
  return Number(rows[0]?.value ?? 0);
}

/**
 * Reconciliation counts in ONE aggregate query — the counting happens in Postgres
 * over `pickup_shipments_pickup_idx`, never by pulling every link row into Node.
 *
 * A pickup with no linked shipments is all zeroes, not null: "nothing was ready"
 * is a real, reportable outcome (domain §3.18 rule 5), not missing data.
 */
async function computeScanSummary(
  tx: TenantTransaction,
  pickupRequestId: string,
): Promise<ScanSummary> {
  const rows: Array<{ scanStatus: string; cnt: number }> = await tx
    .select({
      scanStatus: pickupShipments.scanStatus,
      cnt: sql<number>`count(*)::int`,
    })
    .from(pickupShipments)
    .where(eq(pickupShipments.pickupRequestId, pickupRequestId))
    .groupBy(pickupShipments.scanStatus);

  let total = 0;
  let scanned = 0;
  let missing = 0;
  for (const r of rows) {
    total += r.cnt;
    if (r.scanStatus === "SCANNED") scanned = r.cnt;
    if (r.scanStatus === "MISSING") missing = r.cnt;
  }
  return { total, scanned, missing };
}

function classifyScanError(index: number, trackingNumber: string, error: unknown): ScanItemResult {
  if (error instanceof BusinessRuleError) {
    if (error.code === "BARCODE_NOT_IN_PICKUP") {
      return {
        index,
        trackingNumber,
        status: "REJECTED",
        action: "ESCALATE_TO_DISPATCHER",
        reason: error.message,
        shipmentId: null,
      };
    }
    return {
      index,
      trackingNumber,
      status: "REJECTED",
      action: "DISCARD_AND_REFRESH",
      reason: error.message,
      shipmentId: null,
    };
  }
  if (error instanceof ConflictError) {
    return {
      index,
      trackingNumber,
      status: "CONFLICT",
      action: "DISCARD_AND_REFRESH",
      reason: error.message,
      shipmentId: null,
    };
  }
  throw error;
}

function requireRow(rows: PickupRequest[]): PickupRequest {
  const row = rows[0];
  if (row === undefined) throw new Error("Update returned no row");
  return row;
}
