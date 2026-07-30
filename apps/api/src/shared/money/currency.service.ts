import { Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/index.js";
import { NotFoundError } from "../errors/index.js";
import { currencies } from "./currency.schema.js";
import { formatMinorUnits, parseMinorUnits } from "./money.js";

/**
 * Reads the ISO 4217 minor-unit exponent from the `currencies` table and does the
 * lossless conversion between stored integer minor units and human decimal strings
 * (docs/01-mvp-scope.md §7.1). Every monetary display or input crosses here, so a
 * ×100 assumption cannot leak in — TND (exponent 3) round-trips as 12500 ⇄ "12.500".
 *
 * Currencies are immutable global reference data, so the exponent map is loaded
 * ONCE and cached for the process lifetime: formatting a page of 50 shipments'
 * COD amounts costs one query on the first call and zero thereafter. It is read
 * WITHOUT tenant scope — the table carries no `tenant_id` and no RLS (domain §1).
 *
 * ⚠️ Shared, not finance-owned. `shipment` prints COD on a delivery note and may
 * not depend on `finance`; a per-module copy of this would be a second cache and a
 * second chance to hardcode a scale.
 */
@Injectable()
export class CurrencyService {
  private cache: ReadonlyMap<string, number> | null = null;
  /**
   * The in-flight load, so N concurrent first-callers issue ONE query rather than
   * N. Without it a cold process serving a burst of requests stampedes the
   * database with identical reference-data reads.
   */
  private loading: Promise<ReadonlyMap<string, number>> | null = null;

  constructor(private readonly database: DatabaseService) {}

  /** The minor-unit exponent, e.g. 3 for TND, 2 for EUR. */
  async exponentOf(code: string): Promise<number> {
    const exponent = (await this.exponents()).get(code);
    if (exponent === undefined) {
      throw new NotFoundError(`Currency ${code}`);
    }
    return exponent;
  }

  /** Stored integer → decimal string, e.g. (12500n, "TND") → "12.500". */
  async toDecimal(amountMinor: bigint, code: string): Promise<string> {
    return formatMinorUnits(amountMinor, await this.exponentOf(code));
  }

  /** Decimal string → stored integer, e.g. ("12.5", "TND") → 12500n. */
  async toMinor(value: string, code: string): Promise<bigint> {
    return parseMinorUnits(value, await this.exponentOf(code));
  }

  private async exponents(): Promise<ReadonlyMap<string, number>> {
    if (this.cache !== null) {
      return this.cache;
    }
    // Coalesced: the first caller starts the load and every concurrent caller
    // awaits the same promise. Cleared on failure so a transient database error
    // does not poison the process with a rejected promise forever.
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<ReadonlyMap<string, number>> {
    const rows = await this.database.withoutTenantScope((tx) =>
      tx.select({ code: currencies.code, exponent: currencies.exponent }).from(currencies),
    );
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.code, row.exponent);
    }
    this.cache = map;
    return map;
  }
}
