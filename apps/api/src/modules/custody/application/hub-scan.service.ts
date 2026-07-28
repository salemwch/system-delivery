import { Injectable } from "@nestjs/common";

import { TenantContext } from "../../../shared/database/index.js";
import { FeatureNotEntitledError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/zod-parse.js";
import { HubService } from "../../network/index.js";
import { FeatureService } from "../../platform/index.js";
import { ShipmentService, checkTransition, toShipmentStatus } from "../../shipment/index.js";
import type { Shipment } from "../../shipment/index.js";
import { hubInboundScanBatchSchema, hubInboundScanSchema } from "../domain/dtos.js";

interface CommandContext {
  readonly actorId: string;
}

export interface InboundScanResult {
  /** Null when the barcode resolved to no shipment at all. */
  readonly shipmentId: string | null;
  readonly trackingNumber: string;
  readonly status: "ACCEPTED" | "REJECTED";
  readonly action: "ESCALATE_TO_DISPATCHER" | null;
  readonly reason: string | null;
  /** The shipment status after the scan — `AT_HUB` on success. */
  readonly shipmentStatus: string;
}

export interface InboundScanItemResult extends InboundScanResult {
  readonly index: number;
}

export interface InboundBatchResult {
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly results: readonly InboundScanItemResult[];
}

/**
 * Hub inbound scanning — a parcel arriving at a hub outside any manifest.
 *
 * `docs/03-event-storming.md` gives `shipment.arrived_at_hub` two triggers:
 * "Scan at hub inbound, **or** manifest receipt". This is the first one, and it
 * is what actually closes `PICKED_UP → AT_HUB`: a driver back from a pickup
 * round is holding parcels that were never on a manifest, and making them build
 * one before they can hand the boxes over would be ceremony, not custody.
 *
 * Everything is recorded through {@link ShipmentService} — it remains the only
 * writer of `shipment_events`. This service owns no tables of its own; it is the
 * hub-side entry point to the custody chain.
 */
@Injectable()
export class HubScanService {
  constructor(
    private readonly shipments: ShipmentService,
    private readonly hubs: HubService,
    private readonly features: FeatureService,
  ) {}

  async scan(hubId: string, input: unknown, ctx: CommandContext): Promise<InboundScanResult> {
    const dto = parseWithZod(hubInboundScanSchema, input);
    await this.assertEntitled();
    const hub = await this.hubs.getById(hubId);

    return this.record(hub.id, hub.code, dto.trackingNumber, dto.scannedAt ?? new Date(), ctx);
  }

  /**
   * Offline batch inbound sync.
   *
   * Per-item verdicts, never all-or-nothing — a driver unloading a van should
   * not lose forty good scans because one label was unreadable.
   */
  async scanBatch(hubId: string, input: unknown, ctx: CommandContext): Promise<InboundBatchResult> {
    const dto = parseWithZod(hubInboundScanBatchSchema, input);
    await this.assertEntitled();
    const hub = await this.hubs.getById(hubId);

    const results: InboundScanItemResult[] = [];
    for (const [index, item] of dto.scans.entries()) {
      const outcome = await this.record(hub.id, hub.code, item.trackingNumber, item.scannedAt, ctx);
      results.push({ ...outcome, index });
    }

    const accepted = results.filter((r) => r.status === "ACCEPTED").length;
    return {
      total: dto.scans.length,
      accepted,
      rejected: dto.scans.length - accepted,
      results,
    };
  }

  /**
   * Records one parcel into hub custody.
   *
   * A barcode that resolves to nothing, or to a parcel that cannot legally move
   * to `AT_HUB`, is REJECTED and escalated rather than throwing: the operator is
   * mid-unload and needs to keep scanning, and a dispatcher resolves the odd box.
   */
  private async record(
    hubId: string,
    hubCode: string,
    trackingNumber: string,
    occurredAt: Date,
    ctx: CommandContext,
  ): Promise<InboundScanResult> {
    const shipment = await this.shipments.findByTrackingNumber(trackingNumber);
    if (shipment === null) {
      return rejected(trackingNumber, `No shipment matches tracking number ${trackingNumber}`);
    }

    const check = checkTransition(toShipmentStatus(shipment.status), "arrived_at_hub");
    if (check.kind !== "allowed") {
      if (shipment.status === "AT_HUB") {
        // Already booked in — a replayed scan, not a problem.
        return accepted(shipment, trackingNumber);
      }
      const why =
        check.kind === "rejected"
          ? check.reason
          : `it is ${shipment.status} and would need an override`;
      return rejected(
        trackingNumber,
        `Shipment ${trackingNumber} cannot be booked into a hub: ${why}`,
        shipment,
      );
    }

    const updated = await this.shipments.recordEvent(
      shipment.id,
      {
        eventType: "arrived_at_hub",
        // Deterministic per (hub, shipment): a re-scan of the same parcel at the
        // same hub is a no-op rather than a second custody record.
        idempotencyKey: `hub-inbound:${hubId}:${shipment.id}`,
        hubId,
        occurredAt,
        payload: { hubId, hubCode, trackingNumber, custodyTo: "HUB" },
      },
      { actor: { actorType: "HUB_OPERATOR", actorId: ctx.actorId } },
    );

    return accepted(updated, trackingNumber);
  }

  private async assertEntitled(): Promise<void> {
    const tenantId = TenantContext.requireTenantId();
    if (!(await this.features.isEnabled(tenantId, "MULTI_HUB_ENABLED"))) {
      throw new FeatureNotEntitledError("MULTI_HUB_ENABLED");
    }
  }
}

function accepted(shipment: Shipment, trackingNumber: string): InboundScanResult {
  return {
    shipmentId: shipment.id,
    trackingNumber,
    status: "ACCEPTED",
    action: null,
    reason: null,
    shipmentStatus: shipment.status,
  };
}

function rejected(
  trackingNumber: string,
  reason: string,
  shipment: Shipment | null = null,
): InboundScanResult {
  return {
    shipmentId: shipment?.id ?? null,
    trackingNumber,
    status: "REJECTED",
    action: "ESCALATE_TO_DISPATCHER",
    reason,
    shipmentStatus: shipment?.status ?? "UNKNOWN",
  };
}
