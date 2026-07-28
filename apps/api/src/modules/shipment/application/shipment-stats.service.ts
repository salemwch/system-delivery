import { Injectable } from "@nestjs/common";
import { eq, sql, and, gte, lt } from "drizzle-orm";

import { DatabaseService } from "../../../shared/database/index.js";
import { roundTo } from "../../../shared/math/index.js";
import { shipments, shipmentEvents } from "../domain/schema.js";

interface StatusCount {
  readonly status: string;
  readonly count: number;
}

export interface DashboardStats {
  readonly totalShipments: number;
  readonly byStatus: readonly StatusCount[];
  readonly todayCreated: number;
  readonly todayDelivered: number;
  readonly todayFailed: number;
  readonly deliveryRate: number;
  readonly avgAttemptsPerDelivery: number;
  readonly codCollectedMinor: string;
  readonly codPendingMinor: string;
  readonly currency: string;
}

export interface MerchantStats {
  readonly merchantId: string;
  readonly totalShipments: number;
  readonly byStatus: readonly StatusCount[];
  readonly deliveryRate: number;
  readonly avgAttemptsPerDelivery: number;
  readonly totalCodMinor: string;
  readonly deliveredCodMinor: string;
  readonly currency: string;
}

export interface DriverStats {
  readonly driverId: string;
  readonly totalDeliveries: number;
  readonly totalFailures: number;
  readonly deliveryRate: number;
  readonly totalAttempts: number;
  readonly avgAttemptsPerDelivery: number;
  readonly onTimeRate: number;
  readonly codCollectedMinor: string;
  readonly currency: string;
}

@Injectable()
export class ShipmentStatsService {
  constructor(private readonly database: DatabaseService) {}

  async dashboard(currency: string): Promise<DashboardStats> {
    return this.database.withTenant(async (tx) => {
      const todayStart = todayUtc();
      const tomorrowStart = tomorrowUtc();

      const statusRows = await tx
        .select({
          status: shipments.status,
          count: sql<number>`count(*)::int`,
        })
        .from(shipments)
        .groupBy(shipments.status);

      let total = 0;
      const byStatus: StatusCount[] = [];
      for (const row of statusRows) {
        total += row.count;
        byStatus.push({ status: row.status, count: row.count });
      }

      const todayRows = await tx
        .select({
          status: shipments.status,
          count: sql<number>`count(*)::int`,
        })
        .from(shipments)
        .where(and(gte(shipments.createdAt, todayStart), lt(shipments.createdAt, tomorrowStart)))
        .groupBy(shipments.status);

      let todayCreated = 0;
      for (const r of todayRows) {
        todayCreated += r.count;
      }

      const todayDeliveredRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(shipmentEvents)
        .where(
          and(
            eq(shipmentEvents.eventType, "delivered"),
            gte(shipmentEvents.occurredAt, todayStart),
            lt(shipmentEvents.occurredAt, tomorrowStart),
          ),
        );
      const todayDelivered = todayDeliveredRows[0]?.count ?? 0;

      const todayFailedRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(shipmentEvents)
        .where(
          and(
            eq(shipmentEvents.eventType, "delivery_failed"),
            gte(shipmentEvents.occurredAt, todayStart),
            lt(shipmentEvents.occurredAt, tomorrowStart),
          ),
        );
      const todayFailed = todayFailedRows[0]?.count ?? 0;

      const deliveredTotal = byStatus.find((s) => s.status === "DELIVERED")?.count ?? 0;
      const terminalCount =
        deliveredTotal +
        (byStatus.find((s) => s.status === "RETURNED")?.count ?? 0) +
        (byStatus.find((s) => s.status === "CANCELLED")?.count ?? 0);
      const deliveryRate = terminalCount > 0 ? deliveredTotal / terminalCount : 0;

      const avgRows = await tx
        .select({ avg: sql<number>`coalesce(avg(attempt_count)::numeric(5,2), 0)` })
        .from(shipments)
        .where(eq(shipments.status, "DELIVERED"));
      const avgAttemptsPerDelivery = Number(avgRows[0]?.avg ?? 0);

      const codRows = await tx
        .select({
          codStatus: shipments.codStatus,
          total: sql<string>`coalesce(sum(cod_amount_minor), 0)::text`,
        })
        .from(shipments)
        .where(eq(shipments.currency, currency))
        .groupBy(shipments.codStatus);

      let codCollected = "0";
      let codPending = "0";
      for (const r of codRows) {
        if (r.codStatus === "COLLECTED") codCollected = r.total;
        if (r.codStatus === "PENDING") codPending = r.total;
      }

      return {
        totalShipments: total,
        byStatus,
        todayCreated,
        todayDelivered,
        todayFailed,
        deliveryRate: roundTo(deliveryRate, 4),
        avgAttemptsPerDelivery,
        codCollectedMinor: codCollected,
        codPendingMinor: codPending,
        currency,
      };
    });
  }

  async merchantStats(merchantId: string, currency: string): Promise<MerchantStats> {
    return this.database.withTenant(async (tx) => {
      const statusRows = await tx
        .select({
          status: shipments.status,
          count: sql<number>`count(*)::int`,
        })
        .from(shipments)
        .where(and(eq(shipments.merchantId, merchantId), eq(shipments.currency, currency)))
        .groupBy(shipments.status);

      let total = 0;
      const byStatus: StatusCount[] = [];
      for (const row of statusRows) {
        total += row.count;
        byStatus.push({ status: row.status, count: row.count });
      }

      const delivered = byStatus.find((s) => s.status === "DELIVERED")?.count ?? 0;
      const terminal =
        delivered +
        (byStatus.find((s) => s.status === "RETURNED")?.count ?? 0) +
        (byStatus.find((s) => s.status === "CANCELLED")?.count ?? 0);
      const deliveryRate = terminal > 0 ? delivered / terminal : 0;

      const avgRows = await tx
        .select({ avg: sql<number>`coalesce(avg(attempt_count)::numeric(5,2), 0)` })
        .from(shipments)
        .where(and(eq(shipments.merchantId, merchantId), eq(shipments.status, "DELIVERED")));
      const avgAttemptsPerDelivery = Number(avgRows[0]?.avg ?? 0);

      const codRows = await tx
        .select({
          total: sql<string>`coalesce(sum(cod_amount_minor), 0)::text`,
          delivered: sql<string>`coalesce(sum(case when status = 'DELIVERED' then cod_amount_minor else 0 end), 0)::text`,
        })
        .from(shipments)
        .where(and(eq(shipments.merchantId, merchantId), eq(shipments.currency, currency)));

      return {
        merchantId,
        totalShipments: total,
        byStatus,
        deliveryRate: roundTo(deliveryRate, 4),
        avgAttemptsPerDelivery,
        totalCodMinor: codRows[0]?.total ?? "0",
        deliveredCodMinor: codRows[0]?.delivered ?? "0",
        currency,
      };
    });
  }

  async driverStats(driverId: string, currency: string): Promise<DriverStats> {
    return this.database.withTenant(async (tx) => {
      const deliveredRows = await tx
        .select({ count: sql<number>`count(distinct shipment_id)::int` })
        .from(shipmentEvents)
        .where(
          and(eq(shipmentEvents.driverId, driverId), eq(shipmentEvents.eventType, "delivered")),
        );
      const totalDeliveries = deliveredRows[0]?.count ?? 0;

      const failedRows = await tx
        .select({ count: sql<number>`count(distinct shipment_id)::int` })
        .from(shipmentEvents)
        .where(
          and(
            eq(shipmentEvents.driverId, driverId),
            eq(shipmentEvents.eventType, "delivery_failed"),
          ),
        );
      const totalFailures = failedRows[0]?.count ?? 0;

      const attemptRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(shipmentEvents)
        .where(
          and(
            eq(shipmentEvents.driverId, driverId),
            eq(shipmentEvents.eventType, "delivery_attempted"),
          ),
        );
      const totalAttempts = attemptRows[0]?.count ?? 0;

      const totalOutcomes = totalDeliveries + totalFailures;
      const deliveryRate = totalOutcomes > 0 ? totalDeliveries / totalOutcomes : 0;
      const avgAttemptsPerDelivery = totalDeliveries > 0 ? totalAttempts / totalDeliveries : 0;

      const onTimeRows = await tx
        .select({
          total: sql<number>`count(*)::int`,
          onTime: sql<number>`count(*) filter (where se.occurred_at <= s.promised_to)::int`,
        })
        .from(sql`shipment_events se join shipments s on se.shipment_id = s.id`)
        .where(
          sql`se.driver_id = ${driverId} and se.event_type = 'delivered' and s.promised_to is not null`,
        );
      const onTimeTotal = onTimeRows[0]?.total ?? 0;
      const onTimeCount = onTimeRows[0]?.onTime ?? 0;
      const onTimeRate = onTimeTotal > 0 ? onTimeCount / onTimeTotal : 0;

      const codRows = await tx
        .select({
          total: sql<string>`coalesce(sum(s.cod_amount_minor), 0)::text`,
        })
        .from(sql`shipment_events se join shipments s on se.shipment_id = s.id`)
        .where(
          sql`se.driver_id = ${driverId} and se.event_type = 'delivered' and s.currency = ${currency}`,
        );

      return {
        driverId,
        totalDeliveries,
        totalFailures,
        deliveryRate: roundTo(deliveryRate, 4),
        totalAttempts,
        avgAttemptsPerDelivery: roundTo(avgAttemptsPerDelivery, 2),
        onTimeRate: roundTo(onTimeRate, 4),
        codCollectedMinor: codRows[0]?.total ?? "0",
        currency,
      };
    });
  }

  async lookupByTrackingNumber(trackingNumber: string): Promise<{
    readonly id: string;
    readonly trackingNumber: string;
    readonly status: string;
    readonly recipientName: string;
    readonly codAmountMinor: string;
    readonly currency: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  } | null> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({
          id: shipments.id,
          trackingNumber: shipments.trackingNumber,
          status: shipments.status,
          recipientName: shipments.recipientName,
          codAmountMinor: shipments.codAmountMinor,
          currency: shipments.currency,
          createdAt: shipments.createdAt,
          updatedAt: shipments.updatedAt,
        })
        .from(shipments)
        .where(eq(shipments.trackingNumber, trackingNumber))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        ...row,
        codAmountMinor: row.codAmountMinor.toString(),
      };
    });
  }
}

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function tomorrowUtc(): Date {
  const today = todayUtc();
  return new Date(today.getTime() + 86_400_000);
}
