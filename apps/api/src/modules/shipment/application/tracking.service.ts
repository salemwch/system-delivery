import { createHmac } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";

import { AppConfigService } from "../../../shared/config/index.js";
import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import type { TenantId } from "../../../shared/database/index.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import { shipmentEvents, shipments } from "../domain/schema.js";

const STATUS_LABELS: Record<string, Record<string, string>> = {
  CREATED: { ar: "تم الإنشاء", fr: "Créé", en: "Created" },
  ASSIGNED: { ar: "تم التعيين", fr: "Assigné", en: "Assigned" },
  PICKED_UP: { ar: "تم الاستلام", fr: "Récupéré", en: "Picked up" },
  AT_HUB: { ar: "في المركز", fr: "Au centre", en: "At hub" },
  IN_TRANSIT: { ar: "في الطريق", fr: "En transit", en: "In transit" },
  OUT_FOR_DELIVERY: { ar: "قيد التوصيل", fr: "En cours de livraison", en: "Out for delivery" },
  DELIVERED: { ar: "تم التوصيل", fr: "Livré", en: "Delivered" },
  ATTEMPT_FAILED: { ar: "محاولة فاشلة", fr: "Tentative échouée", en: "Attempt failed" },
  RETURN_PENDING: { ar: "بانتظار الإرجاع", fr: "Retour en attente", en: "Return pending" },
  RETURNED: { ar: "تم الإرجاع", fr: "Retourné", en: "Returned" },
  CANCELLED: { ar: "ملغي", fr: "Annulé", en: "Cancelled" },
};

const VISIBLE_EVENT_TYPES = new Set([
  "created",
  "picked_up",
  "at_hub",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delivery_failed",
  "return_initiated",
  "returned",
  "cancelled",
]);

interface TimelineEntry {
  readonly type: string;
  readonly occurredAt: string;
}

export interface PublicTrackingView {
  readonly trackingNumber: string;
  readonly status: string;
  readonly statusLabel: Record<string, string>;
  readonly recipientFirstName: string;
  readonly codAmountMinor: number;
  readonly currency: string;
  readonly promisedFrom: string | null;
  readonly promisedTo: string | null;
  readonly timeline: readonly TimelineEntry[];
  readonly createdAt: string;
}

@Injectable()
export class TrackingService {
  private readonly secret: string;
  private readonly ttlDays: number;

  constructor(
    private readonly database: DatabaseService,
    config: AppConfigService,
  ) {
    this.secret = config.get("TRACKING_TOKEN_SECRET");
    this.ttlDays = config.get("TRACKING_TOKEN_TTL_DAYS");
  }

  generateToken(tenantId: string, trackingNumber: string): string {
    const expiresAt = Date.now() + this.ttlDays * 86_400_000;
    const payload = `${tenantId}:${trackingNumber}:${expiresAt}`;
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${Buffer.from(payload).toString("base64url")}.${signature}`;
  }

  verifyToken(token: string): { tenantId: string; trackingNumber: string } | null {
    const dotIndex = token.indexOf(".");
    if (dotIndex === -1) return null;

    const payloadB64 = token.slice(0, dotIndex);
    const signature = token.slice(dotIndex + 1);

    let payload: string;
    try {
      payload = Buffer.from(payloadB64, "base64url").toString("utf8");
    } catch {
      return null;
    }

    const expected = createHmac("sha256", this.secret).update(payload).digest("base64url");
    if (signature !== expected) return null;

    const parts = payload.split(":");
    if (parts.length !== 3) return null;
    const tenantId = parts[0];
    const trackingNumber = parts[1];
    const expiresAt = Number(parts[2]);
    if (tenantId === undefined || trackingNumber === undefined || Number.isNaN(expiresAt))
      return null;
    if (Date.now() > expiresAt) return null;

    return { tenantId, trackingNumber };
  }

  async getPublicTracking(tenantId: TenantId, trackingNumber: string): Promise<PublicTrackingView> {
    return TenantContext.run({ tenantId, actorType: "system" }, () =>
      this.database.withTenant(async (tx) => {
        const rows = await tx
          .select({
            id: shipments.id,
            trackingNumber: shipments.trackingNumber,
            status: shipments.status,
            recipientName: shipments.recipientName,
            codAmountMinor: shipments.codAmountMinor,
            currency: shipments.currency,
            promisedFrom: shipments.promisedFrom,
            promisedTo: shipments.promisedTo,
            createdAt: shipments.createdAt,
          })
          .from(shipments)
          .where(eq(shipments.trackingNumber, trackingNumber))
          .limit(1);

        const shipment = rows[0];
        if (shipment === undefined) {
          throw new NotFoundError("Shipment");
        }

        const events = await tx
          .select({
            eventType: shipmentEvents.eventType,
            occurredAt: shipmentEvents.occurredAt,
          })
          .from(shipmentEvents)
          .where(eq(shipmentEvents.shipmentId, shipment.id))
          .orderBy(asc(shipmentEvents.sequence));

        const timeline: TimelineEntry[] = [];
        for (const event of events) {
          if (VISIBLE_EVENT_TYPES.has(event.eventType)) {
            timeline.push({
              type: event.eventType.toUpperCase(),
              occurredAt: event.occurredAt.toISOString(),
            });
          }
        }

        const firstName = shipment.recipientName.split(/\s+/u)[0] ?? shipment.recipientName;

        return {
          trackingNumber: shipment.trackingNumber,
          status: shipment.status,
          statusLabel: STATUS_LABELS[shipment.status] ?? {},
          recipientFirstName: firstName,
          codAmountMinor: Number(shipment.codAmountMinor),
          currency: shipment.currency,
          promisedFrom: shipment.promisedFrom?.toISOString() ?? null,
          promisedTo: shipment.promisedTo?.toISOString() ?? null,
          timeline,
          createdAt: shipment.createdAt.toISOString(),
        };
      }),
    );
  }
}
