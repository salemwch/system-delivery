import { Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, isNull, lt, sql } from "drizzle-orm";

import type { TenantTransaction } from "../../../shared/database/index.js";
import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import { isUniqueViolation } from "../../../shared/database/pg-errors.js";
import {
  BusinessRuleError,
  ConflictError,
  FeatureNotEntitledError,
  NotFoundError,
} from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/zod-parse.js";
import { HubService } from "../../network/index.js";
import { FeatureService, OutboxService } from "../../platform/index.js";
import { ShipmentService, checkTransition, toShipmentStatus } from "../../shipment/index.js";
import type { Shipment, ShipmentEventType } from "../../shipment/index.js";
import {
  addManifestItemSchema,
  dispatchManifestSchema,
  finaliseReceiptSchema,
  listManifestsSchema,
  openManifestSchema,
  receiveScanBatchSchema,
  receiveScanSchema,
  resolveDiscrepancySchema,
  sealManifestSchema,
} from "../domain/dtos.js";
import { formatManifestCode } from "../domain/manifest-code.js";
import {
  canManifestTransition,
  originatesAtHub,
  toManifestStatus,
  toManifestType,
  travelsInTransit,
} from "../domain/manifest-status.js";
import type { ManifestStatus, ManifestType } from "../domain/manifest-status.js";
import { manifestDiscrepancies, manifestItems, manifests } from "../domain/schema.js";
import type { Manifest, ManifestDiscrepancy } from "../domain/schema.js";

const CODE_ALLOCATION_RETRIES = 5;

interface CommandContext {
  readonly actorId: string;
}

export interface ListManifestsParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: string;
  readonly type?: string;
  readonly fromHubId?: string;
  readonly toHubId?: string;
}

export interface ManifestPage {
  readonly items: readonly Manifest[];
  readonly nextCursor: string | null;
}

/** Reconciliation state of one manifest: outstanding = total − scanned. */
export interface ReceiptSummary {
  readonly total: number;
  readonly scanned: number;
  readonly outstanding: number;
}

export interface AppliedScan {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly scanStatus: string;
  /** Device clock, not server clock — see `manifest_items.scanned_at`. */
  readonly scannedAt: Date;
}

export interface ScanResult extends AppliedScan {
  readonly summary: ReceiptSummary;
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
  readonly summary: ReceiptSummary;
}

export interface DiscrepancyView {
  readonly kind: string;
  readonly shipmentId: string | null;
  readonly trackingNumber: string;
  readonly resolutionReason: string | null;
  readonly resolvedAt: Date | null;
}

export interface DiscrepancyReport {
  readonly manifestId: string;
  readonly expectedCount: number;
  readonly scannedCount: number;
  readonly missing: readonly DiscrepancyView[];
  readonly unexpected: readonly DiscrepancyView[];
  readonly discrepancyCount: number;
}

export interface ManifestItemView {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly scanStatus: string;
  readonly scannedAt: Date | null;
  readonly recordedAt: Date | null;
  readonly scannedByUserId: string | null;
}

/** What one receipt scan needs, shared by the online and offline paths. */
interface ScanCommand {
  readonly trackingNumber: string;
  readonly idempotencyKey: string;
  readonly scannedAt: Date;
  readonly userId: string;
}

/**
 * The outcome of one receipt scan.
 *
 * Deliberately a return value rather than an exception. An unrecognised barcode
 * is a routine operational fact, and throwing for it would roll back the very
 * transaction that just recorded the UNEXPECTED discrepancy — losing the only
 * evidence that the parcel was physically present.
 */
type ScanOutcome =
  | { readonly kind: "APPLIED"; readonly scan: AppliedScan }
  | { readonly kind: "UNEXPECTED"; readonly message: string }
  | { readonly kind: "CONFLICT"; readonly message: string };

/** A state change and the fact it publishes, committed together. */
interface TransitionOutcome {
  readonly manifest: Manifest;
  readonly events: readonly OutboxIntent[];
}

interface OutboxIntent {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Manifests — the custody handover record (docs/02-domain-model.md §3.11,
 * docs/04-context-map.md §3.8).
 *
 * This is what makes `AT_HUB` and `IN_TRANSIT` reachable. Before this module the
 * shipment state machine declared both statuses with no command able to produce
 * them, so the hub-and-spoke path existed only on paper.
 *
 * `custody` is one of the two sanctioned same-layer dependencies on `shipment`
 * (the other is `dispatch`), so it calls {@link ShipmentService} directly rather
 * than through events. Every custody fact is still written by the shipment
 * module — it remains the only writer of `shipment_events`.
 *
 * Two transaction rules hold throughout:
 *
 *  - The manifest's own state change and its outbox row commit **together**. An
 *    event published in a separate transaction can be lost while the state
 *    change survives, which is precisely what the transactional outbox exists to
 *    prevent.
 *  - Per-shipment events are recorded **after**, in a sequential loop on the
 *    shipment module's own transaction boundary, exactly as `RouteService.start()`
 *    does. Each carries a deterministic idempotency key, so a partial failure is
 *    resumed by a retry rather than duplicated.
 */
@Injectable()
export class ManifestService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly shipments: ShipmentService,
    private readonly hubs: HubService,
    private readonly features: FeatureService,
  ) {}

  // ── Commands ───────────────────────────────────────────────────────────────

  async open(input: unknown, ctx: CommandContext): Promise<Manifest> {
    const dto = parseWithZod(openManifestSchema, input);
    const type = toManifestType(dto.type);
    await this.assertEntitled(type);
    validateEndpoints(type, dto);

    // Anchor the code at the hub that physically handles the manifest. Every
    // type has one: LINEHAUL both, DISPATCH/TRANSFER from, RETURN to.
    const anchorHubId = dto.fromHubId ?? dto.toHubId;
    if (anchorHubId === undefined) {
      throw new BusinessRuleError(
        "MANIFEST_ENDPOINTS_INVALID",
        `A ${type} manifest must reference at least one hub`,
      );
    }
    const anchorHub = await this.hubs.getById(anchorHubId);

    for (let attempt = 0; attempt < CODE_ALLOCATION_RETRIES; attempt += 1) {
      try {
        return await this.database.withTenant(async (tx) => {
          const tenantId = TenantContext.requireTenantId();
          const now = new Date();
          const ordinal = await nextOrdinal(tx, anchorHub.code, now);

          const rows = await tx
            .insert(manifests)
            .values({
              tenantId,
              code: formatManifestCode(anchorHub.code, now, ordinal),
              type,
              createdByUserId: ctx.actorId,
              ...(dto.fromHubId === undefined ? {} : { fromHubId: dto.fromHubId }),
              ...(dto.toHubId === undefined ? {} : { toHubId: dto.toHubId }),
              ...(dto.fromDriverId === undefined ? {} : { fromDriverId: dto.fromDriverId }),
              ...(dto.toDriverId === undefined ? {} : { toDriverId: dto.toDriverId }),
              ...(dto.vehicleId === undefined ? {} : { vehicleId: dto.vehicleId }),
            })
            .returning();
          return requireRow(rows);
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error, "manifests_tenant_code_uq")) continue;
        throw error;
      }
    }
    throw new ConflictError(
      "MANIFEST_CODE_COLLISION",
      "Manifest code collision after retries — please retry",
    );
  }

  /**
   * Adds a parcel to an OPEN manifest.
   *
   * Eligibility is checked with the shipment module's OWN exported state machine
   * rather than a local copy of the rules — a transition validated in two places
   * eventually disagrees with itself (context-map §3.5).
   *
   * Takes no actor: loading is only possible while OPEN, and the accountable act
   * is the seal, which records `sealedByUserId`. Attributing each box to whoever
   * happened to scan it onto an open pallet would be noise, not an audit trail.
   */
  async addItem(id: string, input: unknown): Promise<ManifestItemView> {
    const dto = parseWithZod(addManifestItemSchema, input);
    const shipment = await this.shipments.getById(dto.shipmentId);

    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const manifest = await lockManifest(tx, id);
      const type = toManifestType(manifest.type);
      await this.assertEntitled(type);

      if (toManifestStatus(manifest.status) !== "OPEN") {
        // Rule 1: adding to a sealed manifest breaks the custody chain — a new
        // manifest is opened instead. The I14 trigger enforces this as well.
        throw new BusinessRuleError(
          "MANIFEST_NOT_OPEN",
          `Manifest ${manifest.code} is ${manifest.status}; its contents are immutable (invariant I14)`,
        );
      }

      const check = checkTransition(toShipmentStatus(shipment.status), entryEventFor(type));
      if (check.kind !== "allowed") {
        // `requires_override` carries no reason — it is the in-custody
        // cancellation path, which a manifest never takes.
        const why =
          check.kind === "rejected"
            ? check.reason
            : `it is ${shipment.status} and would need an override`;
        throw new BusinessRuleError(
          "SHIPMENT_NOT_ELIGIBLE_FOR_MANIFEST",
          `Shipment ${shipment.trackingNumber} cannot join a ${type} manifest: ${why}`,
        );
      }

      try {
        await tx.insert(manifestItems).values({
          tenantId,
          manifestId: id,
          shipmentId: shipment.id,
          trackingNumber: shipment.trackingNumber,
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error, "manifest_items_manifest_shipment_uq")) {
          throw new ConflictError(
            "SHIPMENT_ALREADY_ON_MANIFEST",
            `Shipment ${shipment.trackingNumber} is already on manifest ${manifest.code}`,
          );
        }
        throw error;
      }

      await tx
        .update(manifests)
        .set({ itemCount: sql`${manifests.itemCount} + 1`, updatedAt: new Date() })
        .where(eq(manifests.id, id));

      return {
        shipmentId: shipment.id,
        trackingNumber: shipment.trackingNumber,
        scanStatus: "EXPECTED",
        scannedAt: null,
        recordedAt: null,
        scannedByUserId: null,
      };
    });
  }

  /**
   * Seals the manifest — contents freeze here (rule 1, invariant I14).
   *
   * Custody does NOT move: the sender stays responsible until receipt (rule 5).
   * A hub-origin seal records `loaded` against each parcel, which the shipment
   * state machine accepts only from `AT_HUB`. A RETURN manifest is sealed by a
   * driver in the field, so it records nothing — `loaded` would be both an
   * illegal transition and a lie about where the parcels are.
   */
  async seal(id: string, input: unknown, ctx: CommandContext): Promise<Manifest> {
    parseWithZod(sealManifestSchema, input);

    const sealed = await this.transition(id, "SEALED", async (tx, manifest) => {
      const items = await selectItemIds(tx, manifest.id);
      if (items.length === 0) {
        // Rule 2: an empty manifest records no handover at all.
        throw new BusinessRuleError(
          "MANIFEST_EMPTY",
          `Manifest ${manifest.code} has no items; sealing requires at least one`,
        );
      }
      const now = new Date();
      const updated = await tx
        .update(manifests)
        .set({
          status: "SEALED" as const,
          itemCount: items.length,
          sealedAt: now,
          sealedByUserId: ctx.actorId,
          updatedAt: now,
        })
        .where(eq(manifests.id, manifest.id))
        .returning()
        .then(requireRow);

      return {
        manifest: updated,
        events: [
          {
            eventType: "manifest.sealed",
            payload: {
              manifestId: updated.id,
              code: updated.code,
              type: updated.type,
              fromHubId: updated.fromHubId,
              toHubId: updated.toHubId,
              toDriverId: updated.toDriverId,
              vehicleId: updated.vehicleId,
              itemCount: updated.itemCount,
              shipmentIds: items.map((i) => i.shipmentId),
              sealedByUserId: ctx.actorId,
              occurredAt: now.toISOString(),
            },
          },
        ],
      };
    });

    if (originatesAtHub(toManifestType(sealed.type))) {
      await this.recordForEachItem(sealed, "loaded", `seal:${sealed.id}`, ctx, {
        manifestId: sealed.id,
        manifestCode: sealed.code,
        manifestType: sealed.type,
        fromHubId: sealed.fromHubId,
        toHubId: sealed.toHubId,
        toDriverId: sealed.toDriverId,
        vehicleId: sealed.vehicleId,
      });
    }

    return sealed;
  }

  /**
   * Sends a sealed manifest on its way — `AT_HUB → IN_TRANSIT` per parcel.
   *
   * Only for handovers that physically travel between custody points. A DISPATCH
   * manifest goes straight from SEALED to RECEIVED: its parcels become
   * OUT_FOR_DELIVERY when the route starts, which `RouteService` owns.
   */
  async dispatch(id: string, input: unknown, ctx: CommandContext): Promise<Manifest> {
    const dto = parseWithZod(dispatchManifestSchema, input);

    const dispatched = await this.transition(id, "IN_TRANSIT", async (tx, manifest) => {
      const type = toManifestType(manifest.type);
      if (!travelsInTransit(type)) {
        throw new BusinessRuleError(
          "MANIFEST_NOT_DISPATCHABLE",
          `A ${type} manifest is not dispatched — its parcels are received directly`,
        );
      }
      const now = new Date();
      const updated = await tx
        .update(manifests)
        .set({
          status: "IN_TRANSIT" as const,
          dispatchedAt: now,
          ...(dto.vehicleId === undefined ? {} : { vehicleId: dto.vehicleId }),
          ...(dto.driverId === undefined ? {} : { fromDriverId: dto.driverId }),
          updatedAt: now,
        })
        .where(eq(manifests.id, manifest.id))
        .returning()
        .then(requireRow);

      return {
        manifest: updated,
        events: [
          {
            eventType: "manifest.dispatched",
            payload: {
              manifestId: updated.id,
              code: updated.code,
              type: updated.type,
              fromHubId: updated.fromHubId,
              toHubId: updated.toHubId,
              vehicleId: updated.vehicleId,
              driverId: updated.fromDriverId,
              itemCount: updated.itemCount,
              occurredAt: now.toISOString(),
            },
          },
        ],
      };
    });

    await this.recordForEachItem(dispatched, "departed", `dispatch:${dispatched.id}`, ctx, {
      manifestId: dispatched.id,
      fromHubId: dispatched.fromHubId,
      toHubId: dispatched.toHubId,
      vehicleId: dispatched.vehicleId,
      driverId: dispatched.fromDriverId,
    });

    return dispatched;
  }

  /** Online single receipt scan. */
  async receiveScan(id: string, input: unknown, ctx: CommandContext): Promise<ScanResult> {
    const dto = parseWithZod(receiveScanSchema, input);

    const { manifest, outcome, summary } = await this.database.withTenant(async (tx) => {
      const locked = await lockReceivable(tx, id);
      const result = await this.applyScan(tx, locked, {
        trackingNumber: dto.trackingNumber,
        idempotencyKey: dto.idempotencyKey,
        scannedAt: dto.scannedAt ?? new Date(),
        userId: ctx.actorId,
      });
      return { manifest: locked, outcome: result, summary: await computeSummary(tx, id) };
    });

    // Thrown only after the transaction has committed, so the UNEXPECTED
    // discrepancy recorded inside it survives to be worked by a human.
    if (outcome.kind === "UNEXPECTED") {
      throw new BusinessRuleError("BARCODE_NOT_ON_MANIFEST", outcome.message);
    }
    if (outcome.kind === "CONFLICT") {
      throw new ConflictError("SCAN_CONFLICT_DIFFERENT_OPERATOR", outcome.message);
    }

    await this.transferCustody(manifest, [outcome.scan], ctx);
    return { ...outcome.scan, summary };
  }

  /**
   * Offline batch receipt sync.
   *
   * Never all-or-nothing: one unrecognised barcode must not discard the rest of
   * the pallet, so each item gets its own verdict and client action.
   */
  async receiveScanBatch(
    id: string,
    input: unknown,
    ctx: CommandContext,
  ): Promise<BatchScanResult> {
    const dto = parseWithZod(receiveScanBatchSchema, input);

    const { manifest, results, applied, summary } = await this.database.withTenant(async (tx) => {
      const locked = await lockReceivable(tx, id);
      const itemResults: ScanItemResult[] = [];
      const accepted: AppliedScan[] = [];

      for (const [index, item] of dto.scans.entries()) {
        const outcome = await this.applyScan(tx, locked, {
          trackingNumber: item.trackingNumber,
          idempotencyKey: item.idempotencyKey,
          scannedAt: item.scannedAt,
          userId: ctx.actorId,
        });
        if (outcome.kind === "APPLIED") {
          accepted.push(outcome.scan);
        }
        itemResults.push(toItemResult(index, item.trackingNumber, outcome));
      }

      return {
        manifest: locked,
        results: itemResults,
        applied: accepted,
        // Computed once, not per item — a 200-scan sync would otherwise fire
        // 200 extra aggregate queries inside one transaction.
        summary: await computeSummary(tx, id),
      };
    });

    await this.transferCustody(manifest, applied, ctx);

    const acceptedCount = results.filter((r) => r.status === "ACCEPTED").length;
    return {
      total: dto.scans.length,
      accepted: acceptedCount,
      rejected: dto.scans.length - acceptedCount,
      results,
      summary,
    };
  }

  /**
   * Closes the receipt and writes the discrepancy record.
   *
   * Every parcel still `EXPECTED` becomes a `MISSING` discrepancy; unexpected
   * barcodes were already recorded when they were scanned. Idempotent — the
   * unique constraint on `(manifest_id, tracking_number)` means re-running this
   * cannot duplicate rows.
   */
  async finaliseReceipt(
    id: string,
    input: unknown,
    ctx: CommandContext,
  ): Promise<DiscrepancyReport> {
    parseWithZod(finaliseReceiptSchema, input);

    let report: DiscrepancyReport | null = null;

    await this.transition(id, "RECEIVED", async (tx, manifest) => {
      const tenantId = TenantContext.requireTenantId();
      const outstanding = await tx
        .select({
          shipmentId: manifestItems.shipmentId,
          trackingNumber: manifestItems.trackingNumber,
        })
        .from(manifestItems)
        .where(
          and(eq(manifestItems.manifestId, manifest.id), eq(manifestItems.scanStatus, "EXPECTED")),
        );

      if (outstanding.length > 0) {
        await tx
          .insert(manifestDiscrepancies)
          .values(
            outstanding.map((row) => ({
              tenantId,
              manifestId: manifest.id,
              kind: "MISSING",
              shipmentId: row.shipmentId,
              trackingNumber: row.trackingNumber,
              raisedByUserId: ctx.actorId,
            })),
          )
          .onConflictDoNothing();
      }

      const built = await buildReport(tx, manifest.id);
      report = built;

      const now = new Date();
      const updated = await tx
        .update(manifests)
        .set({
          status: "RECEIVED" as const,
          discrepancyCount: built.discrepancyCount,
          receivedAt: now,
          receivedByUserId: ctx.actorId,
          updatedAt: now,
        })
        .where(eq(manifests.id, manifest.id))
        .returning()
        .then(requireRow);

      const events: OutboxIntent[] = [
        {
          eventType: "manifest.received",
          payload: {
            manifestId: updated.id,
            code: updated.code,
            type: updated.type,
            receivedAtHubId: updated.toHubId,
            receivedByUserId: ctx.actorId,
            expectedCount: built.expectedCount,
            scannedCount: built.scannedCount,
            missingShipmentIds: built.missing.map((d) => d.shipmentId),
            unexpectedTrackingNumbers: built.unexpected.map((d) => d.trackingNumber),
            discrepancyCount: built.discrepancyCount,
            occurredAt: now.toISOString(),
          },
        },
      ];

      if (built.discrepancyCount > 0) {
        // Hotspot H2 — who is accountable for a missing parcel — is deliberately
        // NOT decided here (docs/03 §4.4: "Policy decision needed before S2").
        // The exception carries the facts and an actor; no blame, no money.
        events.push({
          eventType: "manifest.discrepancy_raised",
          payload: {
            manifestId: updated.id,
            code: updated.code,
            fromHubId: updated.fromHubId,
            toHubId: updated.toHubId,
            missingShipmentIds: built.missing.map((d) => d.shipmentId),
            unexpectedTrackingNumbers: built.unexpected.map((d) => d.trackingNumber),
            discrepancyCount: built.discrepancyCount,
            raisedByUserId: ctx.actorId,
          },
        });
      }

      return { manifest: updated, events };
    });

    if (report === null) {
      throw new Error("finaliseReceipt produced no report");
    }
    return report;
  }

  /** Records the explanation for one discrepancy. Reason + actor + time, together. */
  async resolveDiscrepancy(
    id: string,
    input: unknown,
    ctx: CommandContext,
  ): Promise<ManifestDiscrepancy> {
    const dto = parseWithZod(resolveDiscrepancySchema, input);
    return this.database.withTenant(async (tx) => {
      const manifest = await lockManifest(tx, id);
      const status = toManifestStatus(manifest.status);
      if (status !== "RECEIVED") {
        throw new BusinessRuleError(
          "MANIFEST_NOT_RECEIVED",
          `Discrepancies can only be resolved on a RECEIVED manifest; ${manifest.code} is ${status}`,
        );
      }

      const rows = await tx
        .update(manifestDiscrepancies)
        .set({
          resolutionReason: dto.reason,
          resolvedAt: new Date(),
          resolvedByUserId: ctx.actorId,
        })
        .where(
          and(
            eq(manifestDiscrepancies.manifestId, id),
            eq(manifestDiscrepancies.trackingNumber, dto.trackingNumber),
            isNull(manifestDiscrepancies.resolvedAt),
          ),
        )
        .returning();

      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError("Unresolved discrepancy");
      }
      return row;
    });
  }

  /**
   * Closes the manifest.
   *
   * Rule 4: a RECEIVED manifest with unresolved discrepancies cannot become
   * RECONCILED. Every missing or unexpected parcel must carry a reason and an
   * actor first, so nothing is quietly written off.
   */
  async reconcile(id: string, ctx: CommandContext): Promise<Manifest> {
    return this.transition(id, "RECONCILED", async (tx, manifest) => {
      const unresolved = await countUnresolvedDiscrepancies(tx, manifest.id);
      if (unresolved > 0) {
        throw new BusinessRuleError(
          "MANIFEST_HAS_UNRESOLVED_DISCREPANCIES",
          `Manifest ${manifest.code} has ${unresolved} unresolved discrepancy/discrepancies`,
        );
      }
      const now = new Date();
      const updated = await tx
        .update(manifests)
        .set({ status: "RECONCILED" as const, reconciledAt: now, updatedAt: now })
        .where(eq(manifests.id, manifest.id))
        .returning()
        .then(requireRow);

      return {
        manifest: updated,
        events: [
          {
            eventType: "manifest.reconciled",
            payload: {
              manifestId: updated.id,
              code: updated.code,
              type: updated.type,
              reconciledByUserId: ctx.actorId,
              occurredAt: now.toISOString(),
            },
          },
        ],
      };
    });
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async getById(id: string): Promise<Manifest> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx.select().from(manifests).where(eq(manifests.id, id)).limit(1);
      const row = rows[0];
      if (row === undefined) throw new NotFoundError("Manifest");
      return row;
    });
  }

  async getByCode(code: string): Promise<Manifest> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx.select().from(manifests).where(eq(manifests.code, code)).limit(1);
      const row = rows[0];
      if (row === undefined) throw new NotFoundError("Manifest");
      return row;
    });
  }

  async list(params: ListManifestsParams): Promise<ManifestPage> {
    const dto = parseWithZod(listManifestsSchema, params);
    const limit = dto.limit ?? 50;
    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(dto.status === undefined ? [] : [eq(manifests.status, dto.status)]),
        ...(dto.type === undefined ? [] : [eq(manifests.type, dto.type)]),
        ...(dto.fromHubId === undefined ? [] : [eq(manifests.fromHubId, dto.fromHubId)]),
        ...(dto.toHubId === undefined ? [] : [eq(manifests.toHubId, dto.toHubId)]),
        ...(dto.cursor === undefined ? [] : [lt(manifests.id, dto.cursor)]),
      ];

      const rows = await tx
        .select()
        .from(manifests)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(manifests.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items.at(-1);
      return { items, nextCursor: hasMore && last !== undefined ? last.id : null };
    });
  }

  async getItems(id: string): Promise<readonly ManifestItemView[]> {
    return this.database.withTenant(async (tx) => {
      await requireManifestExists(tx, id);
      return selectItemViews(tx, id);
    });
  }

  async getDiscrepancies(id: string): Promise<DiscrepancyReport> {
    return this.database.withTenant(async (tx) => {
      await requireManifestExists(tx, id);
      return buildReport(tx, id);
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Moves custody of the scanned parcels to the receiving hub.
   *
   * Rule 5 — custody transfers HERE, at receipt, never at seal. Runs after the
   * manifest transaction on the shipment module's own boundary, with a
   * deterministic key per parcel so a retry resumes instead of double-recording.
   *
   * Statuses are bulk-loaded once rather than read per parcel: a full pallet
   * would otherwise be one round trip per box just to decide what to record.
   */
  private async transferCustody(
    manifest: Manifest,
    scans: readonly AppliedScan[],
    ctx: CommandContext,
  ): Promise<void> {
    if (scans.length === 0) {
      return;
    }
    const byId = await this.loadShipments(scans.map((s) => s.shipmentId));

    for (const scan of scans) {
      const shipment = byId.get(scan.shipmentId);
      if (
        shipment === undefined ||
        checkTransition(toShipmentStatus(shipment.status), "arrived_at_hub").kind !== "allowed"
      ) {
        // Already at the hub (a replayed scan), or moved on by another path.
        // Not an error: the parcel is where the operator says it is.
        continue;
      }
      await this.shipments.recordEvent(
        scan.shipmentId,
        {
          eventType: "arrived_at_hub",
          idempotencyKey: `manifest-recv:${manifest.id}:${scan.shipmentId}`,
          occurredAt: scan.scannedAt,
          ...(manifest.toHubId === null ? {} : { hubId: manifest.toHubId }),
          payload: {
            manifestId: manifest.id,
            manifestCode: manifest.code,
            trackingNumber: scan.trackingNumber,
            custodyTo: "HUB",
          },
        },
        { actor: { actorType: "HUB_OPERATOR", actorId: ctx.actorId } },
      );
    }
  }

  /**
   * Records one shipment event per manifest item.
   *
   * Sequential and outside the manifest transaction, mirroring
   * `RouteService.start()`. Items whose shipment cannot legally take the event
   * are skipped rather than failing the whole manifest — the same `continue` the
   * dispatch module uses.
   */
  private async recordForEachItem(
    manifest: Manifest,
    eventType: ShipmentEventType,
    keyPrefix: string,
    ctx: CommandContext,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const items = await this.getItems(manifest.id);
    if (items.length === 0) {
      return;
    }
    const byId = await this.loadShipments(items.map((i) => i.shipmentId));

    for (const item of items) {
      const shipment = byId.get(item.shipmentId);
      if (
        shipment === undefined ||
        checkTransition(toShipmentStatus(shipment.status), eventType).kind !== "allowed"
      ) {
        continue;
      }
      await this.shipments.recordEvent(
        item.shipmentId,
        {
          eventType,
          idempotencyKey: `${keyPrefix}:${item.shipmentId}`,
          ...(manifest.fromHubId === null ? {} : { hubId: manifest.fromHubId }),
          payload: { ...payload, trackingNumber: item.trackingNumber },
        },
        { actor: { actorType: "HUB_OPERATOR", actorId: ctx.actorId } },
      );
    }
  }

  private async loadShipments(ids: readonly string[]): Promise<Map<string, Shipment>> {
    const rows = await this.shipments.findManyByIds(ids);
    return new Map(rows.map((s) => [s.id, s]));
  }

  /**
   * The single receipt-scan path — both endpoints funnel through here so the
   * barcode rules and the discrepancy rules cannot drift apart.
   *
   * A barcode not on this manifest is recorded as an `UNEXPECTED` discrepancy
   * immediately, not at finalisation: the parcel is physically present now, and
   * nothing else would remember it. It cannot become an item row — the sealed
   * manifest's contents are frozen (rule 1, enforced by the I14 trigger).
   */
  private async applyScan(
    tx: TenantTransaction,
    manifest: Manifest,
    cmd: ScanCommand,
  ): Promise<ScanOutcome> {
    const rows = await tx
      .select()
      .from(manifestItems)
      .where(
        and(
          eq(manifestItems.manifestId, manifest.id),
          eq(manifestItems.trackingNumber, cmd.trackingNumber),
        ),
      )
      .limit(1);
    const row = rows[0];

    if (row === undefined) {
      await this.raiseUnexpected(tx, manifest, cmd);
      return {
        kind: "UNEXPECTED",
        message: `Tracking number ${cmd.trackingNumber} is not on manifest ${manifest.code}`,
      };
    }

    if (row.scanStatus === "SCANNED") {
      if (row.scannedByUserId !== cmd.userId) {
        return {
          kind: "CONFLICT",
          message: `Shipment ${cmd.trackingNumber} was already received by a different operator`,
        };
      }
      // Replay of a scan this operator already recorded: report the STORED
      // device time so the audit trail stays honest.
      return {
        kind: "APPLIED",
        scan: {
          shipmentId: row.shipmentId,
          trackingNumber: row.trackingNumber,
          scanStatus: row.scanStatus,
          scannedAt: row.scannedAt ?? cmd.scannedAt,
        },
      };
    }

    await tx
      .update(manifestItems)
      .set({
        scanStatus: "SCANNED",
        scannedAt: cmd.scannedAt,
        recordedAt: new Date(),
        scannedByUserId: cmd.userId,
        idempotencyKey: cmd.idempotencyKey,
      })
      .where(eq(manifestItems.id, row.id));

    return {
      kind: "APPLIED",
      scan: {
        shipmentId: row.shipmentId,
        trackingNumber: row.trackingNumber,
        scanStatus: "SCANNED",
        scannedAt: cmd.scannedAt,
      },
    };
  }

  private async raiseUnexpected(
    tx: TenantTransaction,
    manifest: Manifest,
    cmd: ScanCommand,
  ): Promise<void> {
    const tenantId = TenantContext.requireTenantId();
    const shipment = await this.shipments.findByTrackingNumber(cmd.trackingNumber);
    await tx
      .insert(manifestDiscrepancies)
      .values({
        tenantId,
        manifestId: manifest.id,
        kind: "UNEXPECTED",
        trackingNumber: cmd.trackingNumber,
        raisedByUserId: cmd.userId,
        ...(shipment === null ? {} : { shipmentId: shipment.id }),
      })
      .onConflictDoNothing();
  }

  /**
   * Applies a guarded status change and publishes its facts in ONE transaction.
   *
   * The outbox row must commit with the state change: published separately, an
   * event can be lost while the change survives, which is exactly what the
   * transactional outbox exists to prevent.
   */
  private async transition(
    id: string,
    target: ManifestStatus,
    apply: (tx: TenantTransaction, row: Manifest) => Promise<TransitionOutcome>,
  ): Promise<Manifest> {
    return this.database.withTenant(async (tx) => {
      const row = await lockManifest(tx, id);
      const current = toManifestStatus(row.status);
      if (!canManifestTransition(current, target)) {
        throw new BusinessRuleError(
          "MANIFEST_INVALID_TRANSITION",
          `Cannot transition manifest from ${current} to ${target}`,
        );
      }

      const outcome = await apply(tx, row);
      for (const event of outcome.events) {
        await this.outbox.publish(tx, {
          eventType: event.eventType,
          aggregateType: "manifest",
          aggregateId: outcome.manifest.id,
          payload: event.payload,
        });
      }
      return outcome.manifest;
    });
  }

  private async assertEntitled(type: ManifestType): Promise<void> {
    const tenantId = TenantContext.requireTenantId();
    if (!(await this.features.isEnabled(tenantId, "MULTI_HUB_ENABLED"))) {
      throw new FeatureNotEntitledError("MULTI_HUB_ENABLED");
    }
    if (type === "LINEHAUL" && !(await this.features.isEnabled(tenantId, "LINEHAUL_ENABLED"))) {
      throw new FeatureNotEntitledError("LINEHAUL_ENABLED");
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The shipment event a parcel must legally be able to take to join this kind of
 * manifest — so an ineligible parcel is rejected at add time rather than failing
 * confusingly at seal.
 */
function entryEventFor(type: ManifestType): ShipmentEventType {
  return originatesAtHub(type) ? "loaded" : "arrived_at_hub";
}

interface OpenEndpoints {
  readonly fromHubId?: string | undefined;
  readonly toHubId?: string | undefined;
  readonly fromDriverId?: string | undefined;
  readonly toDriverId?: string | undefined;
}

const ENDPOINT_REQUIREMENTS: Readonly<Record<ManifestType, string>> = {
  LINEHAUL: "fromHubId and toHubId",
  DISPATCH: "fromHubId and toDriverId",
  RETURN: "fromDriverId and toHubId",
  TRANSFER: "fromHubId",
};

function validateEndpoints(type: ManifestType, dto: OpenEndpoints): void {
  const missing: Readonly<Record<ManifestType, boolean>> = {
    LINEHAUL: dto.fromHubId === undefined || dto.toHubId === undefined,
    DISPATCH: dto.fromHubId === undefined || dto.toDriverId === undefined,
    RETURN: dto.fromDriverId === undefined || dto.toHubId === undefined,
    TRANSFER: dto.fromHubId === undefined,
  };
  if (missing[type]) {
    throw new BusinessRuleError(
      "MANIFEST_ENDPOINTS_INVALID",
      `A ${type} manifest requires ${ENDPOINT_REQUIREMENTS[type]}`,
    );
  }
  if (dto.fromHubId !== undefined && dto.fromHubId === dto.toHubId) {
    throw new BusinessRuleError(
      "MANIFEST_ENDPOINTS_INVALID",
      "A manifest cannot move parcels from a hub to itself",
    );
  }
}

/**
 * The next per-hub, per-day ordinal.
 *
 * Counts codes already allocated under this hub's prefix rather than filtering
 * on dates — the prefix IS the (hub, day) partition, and it rides the unique
 * index on `(tenant_id, code)`. It also sidesteps binding a JS `Date` into a raw
 * fragment, which this driver cannot serialise (docs/traps.md).
 */
async function nextOrdinal(tx: TenantTransaction, hubCode: string, date: Date): Promise<number> {
  const prefix = formatManifestCode(hubCode, date, 1).slice(0, -3);
  const rows = await tx
    .select({ value: count() })
    .from(manifests)
    .where(sql`${manifests.code} LIKE ${`${prefix}%`}`);
  return Number(rows[0]?.value ?? 0) + 1;
}

async function lockManifest(tx: TenantTransaction, id: string): Promise<Manifest> {
  const rows = await tx.select().from(manifests).where(eq(manifests.id, id)).limit(1).for("update");
  const row = rows[0];
  if (row === undefined) throw new NotFoundError("Manifest");
  return row;
}

/** Locks a manifest and asserts it is in a state where parcels can be received. */
async function lockReceivable(tx: TenantTransaction, id: string): Promise<Manifest> {
  const manifest = await lockManifest(tx, id);
  const status = toManifestStatus(manifest.status);
  if (status !== "SEALED" && status !== "IN_TRANSIT") {
    throw new BusinessRuleError(
      "MANIFEST_NOT_RECEIVABLE",
      `Manifest ${manifest.code} is ${status}; parcels can only be received from SEALED or IN_TRANSIT`,
    );
  }
  return manifest;
}

async function requireManifestExists(tx: TenantTransaction, id: string): Promise<void> {
  const rows = await tx
    .select({ id: manifests.id })
    .from(manifests)
    .where(eq(manifests.id, id))
    .limit(1);
  if (rows[0] === undefined) throw new NotFoundError("Manifest");
}

async function selectItemIds(
  tx: TenantTransaction,
  manifestId: string,
): Promise<Array<{ shipmentId: string }>> {
  return tx
    .select({ shipmentId: manifestItems.shipmentId })
    .from(manifestItems)
    .where(eq(manifestItems.manifestId, manifestId));
}

async function selectItemViews(
  tx: TenantTransaction,
  manifestId: string,
): Promise<ManifestItemView[]> {
  return tx
    .select({
      shipmentId: manifestItems.shipmentId,
      trackingNumber: manifestItems.trackingNumber,
      scanStatus: manifestItems.scanStatus,
      scannedAt: manifestItems.scannedAt,
      recordedAt: manifestItems.recordedAt,
      scannedByUserId: manifestItems.scannedByUserId,
    })
    .from(manifestItems)
    .where(eq(manifestItems.manifestId, manifestId))
    .orderBy(asc(manifestItems.createdAt));
}

async function countUnresolvedDiscrepancies(
  tx: TenantTransaction,
  manifestId: string,
): Promise<number> {
  const rows = await tx
    .select({ value: count() })
    .from(manifestDiscrepancies)
    .where(
      and(
        eq(manifestDiscrepancies.manifestId, manifestId),
        isNull(manifestDiscrepancies.resolvedAt),
      ),
    );
  return Number(rows[0]?.value ?? 0);
}

/**
 * Receipt counts in ONE aggregate query — counted in Postgres over
 * `manifest_items_manifest_idx`, never by pulling every item row into Node.
 */
async function computeSummary(tx: TenantTransaction, manifestId: string): Promise<ReceiptSummary> {
  const rows: Array<{ scanStatus: string; cnt: number }> = await tx
    .select({ scanStatus: manifestItems.scanStatus, cnt: sql<number>`count(*)::int` })
    .from(manifestItems)
    .where(eq(manifestItems.manifestId, manifestId))
    .groupBy(manifestItems.scanStatus);

  let total = 0;
  let scanned = 0;
  for (const r of rows) {
    total += r.cnt;
    if (r.scanStatus === "SCANNED") scanned = r.cnt;
  }
  return { total, scanned, outstanding: total - scanned };
}

async function buildReport(tx: TenantTransaction, manifestId: string): Promise<DiscrepancyReport> {
  const rows = await tx
    .select({
      kind: manifestDiscrepancies.kind,
      shipmentId: manifestDiscrepancies.shipmentId,
      trackingNumber: manifestDiscrepancies.trackingNumber,
      resolutionReason: manifestDiscrepancies.resolutionReason,
      resolvedAt: manifestDiscrepancies.resolvedAt,
    })
    .from(manifestDiscrepancies)
    .where(eq(manifestDiscrepancies.manifestId, manifestId))
    .orderBy(asc(manifestDiscrepancies.raisedAt));

  const summary = await computeSummary(tx, manifestId);
  return {
    manifestId,
    expectedCount: summary.total,
    scannedCount: summary.scanned,
    missing: rows.filter((r) => r.kind === "MISSING"),
    unexpected: rows.filter((r) => r.kind === "UNEXPECTED"),
    discrepancyCount: rows.length,
  };
}

/**
 * Maps a scan outcome to the verdict the driver app acts on.
 *
 * An unrecognised barcode escalates rather than being discarded: the parcel is
 * physically in the operator's hand and has already been recorded as an
 * UNEXPECTED discrepancy, so a dispatcher decides what it is. A conflict means
 * this device's view is stale and should be refreshed.
 */
function toItemResult(index: number, trackingNumber: string, outcome: ScanOutcome): ScanItemResult {
  switch (outcome.kind) {
    case "APPLIED":
      return {
        index,
        trackingNumber,
        status: "ACCEPTED",
        action: null,
        reason: null,
        shipmentId: outcome.scan.shipmentId,
      };
    case "UNEXPECTED":
      return {
        index,
        trackingNumber,
        status: "REJECTED",
        action: "ESCALATE_TO_DISPATCHER",
        reason: outcome.message,
        shipmentId: null,
      };
    case "CONFLICT":
      return {
        index,
        trackingNumber,
        status: "CONFLICT",
        action: "DISCARD_AND_REFRESH",
        reason: outcome.message,
        shipmentId: null,
      };
  }
}

function requireRow(rows: Manifest[]): Manifest {
  const row = rows[0];
  if (row === undefined) throw new Error("Update returned no row");
  return row;
}
