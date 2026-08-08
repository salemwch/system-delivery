import { Injectable } from "@nestjs/common";
import { and, gte, isNotNull, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { MerchantService } from "../../directory/index.js";
import { DatabaseService } from "../../../shared/database/index.js";
import { CurrencyService, formatMinorUnits } from "../../../shared/money/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { roundTo } from "../../../shared/math/index.js";
import { parcelStateQuerySchema } from "../domain/dtos.js";
import { toCsv } from "../domain/parcel-state-csv.js";
import { shipments } from "../domain/schema.js";
import { SHIPMENT_STATUSES } from "../domain/shipment-status.js";

/**
 * One merchant's parcels over the period, broken down by status.
 *
 * Not exported: reachable through {@link ParcelStateReport}, which is what every
 * caller actually holds.
 */
interface ParcelStateRow {
  readonly merchantId: string;
  readonly merchantName: string;
  readonly total: number;
  /** Count per status; every status present, zero included. */
  readonly byStatus: Readonly<Record<string, number>>;
  readonly deliveryRate: number;
  /** Minor units as strings — bigints that a JSON number would round. */
  readonly codCollectedMinor: string;
  readonly codPendingMinor: string;
  readonly currency: string;
  readonly currencyExponent: number;
}

export interface ParcelStateReport {
  readonly from: string;
  readonly to: string;
  readonly rows: readonly ParcelStateRow[];
}

/**
 * État Colis (Entreprise) — every merchant's parcels, by status, over a period.
 *
 * The report a courier reads at the end of a month: who is shipping, how much of
 * it arrived, and how much cash is still in the field against each account. The
 * per-merchant stats endpoint answers this for ONE merchant; this answers it for
 * all of them at once, which is the question actually asked.
 *
 * ⚠️ ONE QUERY, PIVOTED IN TYPESCRIPT. The obvious shape — a query per merchant,
 * or a query per status — is eleven round trips per merchant on a courier with
 * two hundred accounts. Grouped once and pivoted here, it is a single scan.
 */
@Injectable()
export class ParcelStateService {
  constructor(
    private readonly database: DatabaseService,
    private readonly merchants: MerchantService,
    private readonly currencies: CurrencyService,
  ) {}

  async report(input: unknown): Promise<ParcelStateReport> {
    const dto = parseWithZod(parcelStateQuerySchema, input);

    const rows = await this.database.withTenant(async (tx) => {
      const conditions: SQL[] = [
        // A parcel with no merchant belongs to the courier itself — a walk-in,
        // or a test. It has no row in a per-merchant report.
        isNotNull(shipments.merchantId),
        gte(shipments.createdAt, new Date(`${dto.from}T00:00:00.000Z`)),
        // ⚠️ Inclusive of the whole final day. `<= 2026-08-31` against a
        // timestamp excludes everything after midnight, which silently drops a
        // day's parcels from every month-end report.
        lte(shipments.createdAt, new Date(`${dto.to}T23:59:59.999Z`)),
        ...(dto.merchantId === undefined
          ? []
          : [sql`${shipments.merchantId} = ${dto.merchantId}`]),
      ];

      return tx
        .select({
          merchantId: shipments.merchantId,
          status: shipments.status,
          currency: shipments.currency,
          count: sql<number>`count(*)::int`,
          // COD is summed per status so "collected" and "pending" fall out of
          // the same scan rather than needing two more.
          codMinor: sql<string>`coalesce(sum(${shipments.codAmountMinor}), 0)::text`,
          codStatus: shipments.codStatus,
        })
        .from(shipments)
        .where(and(...conditions))
        .groupBy(shipments.merchantId, shipments.status, shipments.currency, shipments.codStatus);
    });

    // Merchant names in ONE call, not one per row.
    const merchantIds = [
      ...new Set(rows.map((row) => row.merchantId).filter((id): id is string => id !== null)),
    ];
    // `namesByIds` already exists on MerchantService and resolves the whole set
    // in one query — a private wrapper here would be a second way to do it.
    const names = await this.merchants.namesByIds(merchantIds);

    const accumulator = new Map<string, Mutable>();

    for (const row of rows) {
      if (row.merchantId === null) {
        continue;
      }
      const entry = accumulator.get(row.merchantId) ?? blank(row.currency);
      accumulator.set(row.merchantId, entry);

      entry.total += row.count;
      entry.byStatus[row.status] = (entry.byStatus[row.status] ?? 0) + row.count;

      // COLLECTED is cash the driver has taken; PENDING is cash still owed on a
      // parcel yet to be delivered. Anything else — cancelled, not applicable —
      // is neither, and counting it in either column would misstate the field.
      if (row.codStatus === "COLLECTED") {
        entry.codCollectedMinor += BigInt(row.codMinor);
      } else if (row.codStatus === "PENDING") {
        entry.codPendingMinor += BigInt(row.codMinor);
      }
    }

    const exponents = new Map<string, number>();
    for (const currency of new Set([...accumulator.values()].map((entry) => entry.currency))) {
      exponents.set(currency, await this.currencies.exponentOf(currency));
    }

    const report = [...accumulator.entries()]
      .map(([merchantId, entry]) => ({
        merchantId,
        merchantName: names.get(merchantId) ?? merchantId,
        total: entry.total,
        // Every status present, zero included: a report whose columns move
        // between months cannot be compared, and a CSV whose header changes
        // shape breaks whatever the courier pastes it into.
        byStatus: Object.fromEntries(
          SHIPMENT_STATUSES.map((status) => [status, entry.byStatus[status] ?? 0]),
        ),
        deliveryRate:
          entry.total === 0
            ? 0
            : roundTo((entry.byStatus["DELIVERED"] ?? 0) / entry.total, 4),
        codCollectedMinor: entry.codCollectedMinor.toString(),
        codPendingMinor: entry.codPendingMinor.toString(),
        currency: entry.currency,
        currencyExponent: exponents.get(entry.currency) ?? 0,
      }))
      // Busiest first: the merchant with three hundred parcels is the one the
      // courier wants to see, and alphabetical order buries them.
      .sort((a, b) => b.total - a.total || a.merchantName.localeCompare(b.merchantName));

    return { from: dto.from, to: dto.to, rows: report };
  }

  /**
   * The same report as a CSV.
   *
   * Built from the same {@link report} rather than its own query, so the file a
   * courier archives can never disagree with the screen it was exported from.
   */
  async csv(input: unknown): Promise<string> {
    const { from, to, rows } = await this.report(input);

    const headers = [
      "merchant_id",
      "merchant",
      "period_from",
      "period_to",
      "total",
      ...SHIPMENT_STATUSES.map((status) => status.toLowerCase()),
      "delivery_rate",
      "cod_collected",
      "cod_pending",
      "currency",
    ];

    const body = rows.map((row) => [
      row.merchantId,
      row.merchantName,
      from,
      to,
      row.total,
      ...SHIPMENT_STATUSES.map((status) => row.byStatus[status] ?? 0),
      row.deliveryRate,
      // Formatted as a decimal, not minor units: this file is opened in a
      // spreadsheet by a human, and 45000 in a money column is a bug report.
      formatMinorUnits(BigInt(row.codCollectedMinor), row.currencyExponent),
      formatMinorUnits(BigInt(row.codPendingMinor), row.currencyExponent),
      row.currency,
    ]);

    return toCsv(headers, body);
  }

}

/** The accumulator shape. Mutable by design — it is folded over, then frozen. */
interface Mutable {
  total: number;
  byStatus: Record<string, number>;
  codCollectedMinor: bigint;
  codPendingMinor: bigint;
  readonly currency: string;
}

function blank(currency: string): Mutable {
  return {
    total: 0,
    byStatus: {},
    codCollectedMinor: 0n,
    codPendingMinor: 0n,
    currency,
  };
}
