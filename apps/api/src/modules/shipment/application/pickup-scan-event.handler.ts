import { Injectable } from "@nestjs/common";

import { TenantContext, asTenantId } from "../../../shared/database/index.js";
import { BusinessRuleError } from "../../../shared/errors/index.js";
import type { ConsumedEvent, EventHandler } from "../../platform/index.js";
import { toShipmentStatus } from "../domain/shipment-status.js";
import type { EventActor } from "../domain/shipment-status.js";
import { ShipmentService } from "./shipment.service.js";

/** The consumer group this handler owns — stable, durable state in Valkey. */
const CONSUMER_GROUP = "pickup-scan";

/** The one event that moves a parcel into a driver's hands (event-storming §P2). */
const HANDLED_EVENTS: ReadonlySet<string> = new Set<string>(["pickup.parcel_scanned"]);

/**
 * Turns a scanned pickup barcode into real custody on the shipment.
 *
 * The pickup context owns "which parcels were physically handed over"; the
 * shipment context owns "who holds this parcel now". Pickup and shipment are both
 * Layer 2 and may not import each other (docs/04-context-map.md §2.1), so the
 * scan crosses the boundary as `pickup.parcel_scanned` and lands here — inside
 * the shipment module, which is allowed to write the custody ledger.
 *
 * Custody is not optional bookkeeping: a scan whose payload we cannot understand
 * THROWS rather than being skipped, so it retries and then dead-letters for a
 * human. Losing a custody transfer would leave a parcel that physically moved
 * looking untouched — the exact gap the count-based design had.
 *
 * The scan may arrive for a shipment that was never route-assigned (the merchant
 * created it, a driver turned up and took it). The physical scan IS the
 * assignment, so this records `assigned` before `picked_up` rather than rejecting
 * a legitimate CREATED → PICKED_UP move. Both commands are idempotent on their
 * own key, so a redelivery after a partial failure completes the pair instead of
 * duplicating it.
 */
@Injectable()
export class PickupScanEventHandler implements EventHandler {
  readonly consumerGroup = CONSUMER_GROUP;

  constructor(private readonly shipments: ShipmentService) {}

  handles(eventType: string): boolean {
    return HANDLED_EVENTS.has(eventType);
  }

  async handle(event: ConsumedEvent): Promise<void> {
    if (event.eventType !== "pickup.parcel_scanned") {
      return;
    }

    const shipmentId = uuidOf(event.payload["shipmentId"]);
    const driverId = uuidOf(event.payload["driverId"]);
    const pickupRequestId = uuidOf(event.payload["pickupRequestId"]);
    if (shipmentId === null || driverId === null || pickupRequestId === null) {
      throw new BusinessRuleError(
        "PICKUP_SCAN_EVENT_MALFORMED",
        `pickup.parcel_scanned ${event.eventId} is missing shipmentId/driverId/pickupRequestId`,
      );
    }

    const trackingNumber = strOf(event.payload["trackingNumber"]);
    // Device clock — hours old when the scan was queued offline. That is normal
    // and is what the custody ledger must record (domain §3.4 rule 5), not the
    // moment the sync happened to reach us.
    const occurredAt = dateOf(event.payload["scannedAt"]) ?? event.occurredAt;
    const actor: EventActor = { actorType: "DRIVER", actorId: driverId };

    // Consumers run outside any request, so tenant context is re-established from
    // the envelope before anything touches an RLS-protected table.
    await TenantContext.run(
      { tenantId: asTenantId(event.tenantId), actorType: "system" },
      async () => {
        const shipment = await this.shipments.getById(shipmentId);
        const status = toShipmentStatus(shipment.status);

        if (status !== "CREATED" && status !== "ASSIGNED") {
          // Already in custody, or past it, or dead (CANCELLED/RETURNED). Retrying
          // could never succeed, and dead-lettering it would bury a real-world
          // discrepancy in operator noise — the pickup's own reconciliation view
          // already shows the parcel as scanned against a shipment that moved on.
          return;
        }

        if (status === "CREATED") {
          await this.shipments.recordEvent(
            shipmentId,
            {
              eventType: "assigned",
              idempotencyKey: `pickup-scan:${event.eventId}#assigned`,
              driverId,
              occurredAt,
              payload: {
                pickupRequestId,
                assignedBy: "PICKUP_SCAN",
                ...(trackingNumber === null ? {} : { trackingNumber }),
              },
            },
            { actor },
          );
        }

        await this.shipments.recordPickup(
          shipmentId,
          {
            idempotencyKey: `pickup-scan:${event.eventId}`,
            driverId,
            occurredAt,
            ...(trackingNumber === null ? {} : { scannedBarcode: trackingNumber }),
            metadata: { pickupRequestId },
          },
          { actor },
        );
      },
    );
  }
}

function strOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A UUID-shaped string, or null. Keeps a malformed id from reaching a uuid column. */
function uuidOf(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : null;
}

/** An ISO-8601 instant from the envelope, or null when absent/unparseable. */
function dateOf(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
