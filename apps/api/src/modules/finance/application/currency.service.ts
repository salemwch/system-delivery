import { Injectable } from "@nestjs/common";

import { DatabaseService } from "../../../shared/database/index.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import { currencies } from "../domain/schema.js";
import { formatMinorUnits, parseMinorUnits } from "../domain/money.js";

/**
 * Reads the ISO 4217 minor-unit exponent from the `currencies` table and does the
 * lossless conversion between stored integer minor units and human decimal strings
 * (docs/01-mvp-scope.md §7.1). Every monetary display or input crosses here, so a
 * ×100 assumption cannot leak in — TND (exponent 3) round-trips as 12500 ⇄ "12.500".
 *
 * Currencies are immutable global reference data, so the exponent map is loaded
 * once and cached for the process lifetime. It is read WITHOUT tenant scope — the
 * table carries no `tenant_id` and no RLS (domain §1).
 */
@Injectable()
export class CurrencyService {
  private cache: ReadonlyMap<string, number> | null = null;

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
