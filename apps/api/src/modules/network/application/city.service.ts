import { Injectable } from "@nestjs/common";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { AuditService, OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { normaliseCityKey, searchKeysFor } from "../domain/city-key.js";
import {
  createCitySchema,
  listCitiesSchema,
  resolveCitiesSchema,
  updateCitySchema,
} from "../domain/dtos.js";
import { cities } from "../domain/schema.js";
import type { City } from "../domain/schema.js";

export interface CityPage {
  readonly items: readonly City[];
  readonly nextCursor: string | null;
}

/** One entry per requested name, in the order asked, matched or not. */
export interface CityMatch {
  readonly query: string;
  readonly city: City | null;
}

const DEFAULT_PAGE_SIZE = 100;

/**
 * `ARRAY[$1, $2, …]::text[]` — an array built from scalar placeholders.
 *
 * Deliberately not `${jsArray}`. Passing a JavaScript array as one bound
 * parameter leaves its element type to the driver's inference, and an array of
 * unknown type has no `&&` operator against `text[]` — the query fails at plan
 * time with "operator does not exist". Scalars plus an explicit cast decide the
 * type here, where it can be read.
 */
function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * Villes — the coverage list and its tariff.
 *
 * Three responsibilities, and the third is the reason this is a service rather
 * than CRUD over a table:
 *
 *  1. Keep `search_keys` in step with the names. Every write goes through
 *     {@link searchKeysFor}; nothing else may set the column.
 *  2. Refuse a city whose keys collide with an active one. Two rows answering
 *     to `ariana` make {@link resolveMany} arbitrary, and an arbitrary tariff is
 *     a billing dispute.
 *  3. Resolve free text to a tariff, in bulk, from one indexed query.
 */
@Injectable()
export class CityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async create(input: unknown): Promise<City> {
    const dto = parseWithZod(createCitySchema, input);
    const keys = searchKeysFor({
      name: dto.name,
      nameAr: dto.nameAr ?? null,
      aliases: dto.aliases ?? [],
    });

    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        await this.assertKeysFree(tx, keys, null);

        const inserted = await tx
          .insert(cities)
          .values({
            tenantId,
            code: dto.code,
            name: dto.name,
            governorate: dto.governorate,
            currency: dto.currency,
            deliveryFeeMinor: BigInt(dto.deliveryFeeMinor),
            returnFeeMinor: BigInt(dto.returnFeeMinor),
            aliases: [...(dto.aliases ?? [])],
            searchKeys: keys,
            ...(dto.nameAr === undefined ? {} : { nameAr: dto.nameAr }),
            ...(dto.postalCode === undefined ? {} : { postalCode: dto.postalCode }),
            ...(dto.zoneId === undefined ? {} : { zoneId: dto.zoneId }),
            ...(dto.deliveryDelayDays === undefined
              ? {}
              : { deliveryDelayDays: dto.deliveryDelayDays }),
          })
          .returning();

        const city = requireRow(inserted);

        await this.audit.record(tx, {
          action: "city.tariff_changed",
          resourceType: "city",
          resourceId: city.id,
          changes: {
            deliveryFeeMinor: { from: null, to: city.deliveryFeeMinor.toString() },
            returnFeeMinor: { from: null, to: city.returnFeeMinor.toString() },
          },
          context: { code: city.code, name: city.name, currency: city.currency },
        });
        await this.emitUpdated(tx, city);
        return city;
      });
    } catch (error) {
      if (isUniqueViolation(error, "cities_tenant_code_uq")) {
        throw new ConflictError("CITY_CODE_TAKEN", `City code "${dto.code}" is already in use.`);
      }
      throw error;
    }
  }

  async update(id: string, input: unknown): Promise<City> {
    const dto = parseWithZod(updateCitySchema, input);

    return this.database.withTenant(async (tx) => {
      const before = await this.requireById(tx, id);

      // The keys depend on three fields; recompute from the merged state so a
      // change to any one of them cannot leave the other two's keys behind.
      const names = {
        name: dto.name ?? before.name,
        nameAr: dto.nameAr === undefined ? before.nameAr : dto.nameAr,
        aliases: dto.aliases ?? before.aliases,
      };
      const keys = searchKeysFor(names);
      await this.assertKeysFree(tx, keys, id);

      const updated = await tx
        .update(cities)
        .set({
          updatedAt: sql`now()`,
          name: names.name,
          nameAr: names.nameAr,
          aliases: [...names.aliases],
          searchKeys: keys,
          ...(dto.governorate === undefined ? {} : { governorate: dto.governorate }),
          ...(dto.postalCode === undefined ? {} : { postalCode: dto.postalCode }),
          ...(dto.zoneId === undefined ? {} : { zoneId: dto.zoneId }),
          ...(dto.currency === undefined ? {} : { currency: dto.currency }),
          ...(dto.deliveryFeeMinor === undefined
            ? {}
            : { deliveryFeeMinor: BigInt(dto.deliveryFeeMinor) }),
          ...(dto.returnFeeMinor === undefined
            ? {}
            : { returnFeeMinor: BigInt(dto.returnFeeMinor) }),
          ...(dto.deliveryDelayDays === undefined
            ? {}
            : { deliveryDelayDays: dto.deliveryDelayDays }),
          ...(dto.active === undefined ? {} : { active: dto.active }),
        })
        .where(eq(cities.id, id))
        .returning();

      const after = requireRow(updated);

      // Audited only when the MONEY moved. A spelling correction is not a
      // tariff change, and recording it as one would bury the entries a billing
      // dispute actually needs.
      const changes = tariffChanges(before, after);
      if (changes !== null) {
        await this.audit.record(tx, {
          action: "city.tariff_changed",
          resourceType: "city",
          resourceId: after.id,
          changes,
          context: { code: after.code, name: after.name },
        });
      }
      await this.emitUpdated(tx, after);
      return after;
    });
  }

  async getById(id: string): Promise<City> {
    return this.database.withTenant((tx) => this.requireById(tx, id));
  }

  async list(input: unknown = {}): Promise<CityPage> {
    const dto = parseWithZod(listCitiesSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;

    return this.database.withTenant(async (tx) => {
      const searchKey = dto.search === undefined ? null : normaliseCityKey(dto.search);
      const conditions: SQL[] = [
        ...(dto.active === undefined ? [] : [eq(cities.active, dto.active)]),
        ...(dto.governorate === undefined ? [] : [eq(cities.governorate, dto.governorate)]),
        ...(dto.zoneId === undefined ? [] : [eq(cities.zoneId, dto.zoneId)]),
        // Prefix match on the normalised keys: typing "sou" finds Sousse. The
        // GIN index cannot serve a prefix, so this is a filtered scan over one
        // tenant's cities — a few hundred rows at most, and the alternative
        // (a trigram index) is an extension for a screen nobody paginates.
        ...(searchKey === null || searchKey === ""
          ? []
          : [sql`EXISTS (SELECT 1 FROM unnest(${cities.searchKeys}) k WHERE k LIKE ${`${searchKey}%`})`]),
        // Keyset pagination on the id, which is UUIDv7 and therefore ordered.
        ...(dto.cursor === undefined ? [] : [gt(cities.id, dto.cursor)]),
      ];

      const rows = await tx
        .select()
        .from(cities)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(cities.id))
        .limit(limit + 1);

      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  /**
   * Free-text names → their tariffs, one query for the whole batch.
   *
   * Only ACTIVE cities match. A retired city is history: it must keep its rows
   * so past invoices still reference a tariff, but it must not be quoted for a
   * new shipment.
   */
  async resolveMany(input: unknown): Promise<CityMatch[]> {
    const dto = parseWithZod(resolveCitiesSchema, input);

    // Normalise first and de-duplicate: a 500-row CSV that ships to Tunis 400
    // times asks the database for "tunis" once.
    const keyed = dto.names.map((name) => ({ name, key: normaliseCityKey(name) }));
    const distinct = [...new Set(keyed.map((entry) => entry.key))].filter((key) => key !== "");

    if (distinct.length === 0) {
      return keyed.map((entry) => ({ query: entry.name, city: null }));
    }

    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(cities)
        .where(and(eq(cities.active, true), sql`${cities.searchKeys} && ${textArray(distinct)}`))
        // Deterministic when two active cities somehow share a key: the lower
        // code always wins, so the same CSV imported twice prices the same.
        .orderBy(asc(cities.code));

      const byKey = new Map<string, City>();
      for (const row of rows) {
        for (const key of row.searchKeys) {
          if (!byKey.has(key)) {
            byKey.set(key, row);
          }
        }
      }
      return keyed.map((entry) => ({ query: entry.name, city: byKey.get(entry.key) ?? null }));
    });
  }

  /**
   * Refuses keys already claimed by another ACTIVE city.
   *
   * Retired cities are excluded: re-opening coverage under a new code is normal,
   * and blocking it on a row nobody can be quoted against would be an error the
   * operator cannot act on.
   */
  private async assertKeysFree(
    tx: TenantTransaction,
    keys: readonly string[],
    excludeId: string | null,
  ): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const clash = await tx
      .select({ id: cities.id, code: cities.code, name: cities.name })
      .from(cities)
      .where(
        and(
          eq(cities.active, true),
          sql`${cities.searchKeys} && ${textArray(keys)}`,
          ...(excludeId === null ? [] : [sql`${cities.id} <> ${excludeId}`]),
        ),
      )
      .limit(1);

    const row = clash[0];
    if (row !== undefined) {
      throw new ConflictError(
        "CITY_NAME_TAKEN",
        `City "${row.name}" (${row.code}) already answers to one of those names.`,
      );
    }
  }

  private async requireById(tx: TenantTransaction, id: string): Promise<City> {
    const rows = await tx.select().from(cities).where(eq(cities.id, id)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("City");
    }
    return row;
  }

  /**
   * `city.updated` — the tariff is quoted by other contexts, so a change has to
   * reach them. Self-contained: a consumer must never have to read the table
   * back to understand the event.
   */
  private async emitUpdated(tx: TenantTransaction, city: City): Promise<void> {
    await this.outbox.publish(tx, {
      eventType: "city.updated",
      aggregateType: "city",
      aggregateId: city.id,
      payload: {
        cityId: city.id,
        code: city.code,
        name: city.name,
        governorate: city.governorate,
        zoneId: city.zoneId,
        currency: city.currency,
        deliveryFeeMinor: city.deliveryFeeMinor.toString(),
        returnFeeMinor: city.returnFeeMinor.toString(),
        deliveryDelayDays: city.deliveryDelayDays,
        active: city.active,
      },
    });
  }
}

/** The money fields that changed, or `null` when none did. */
function tariffChanges(
  before: City,
  after: City,
): Record<string, { from: string; to: string }> | null {
  const changes: Record<string, { from: string; to: string }> = {};
  if (before.deliveryFeeMinor !== after.deliveryFeeMinor) {
    changes["deliveryFeeMinor"] = {
      from: before.deliveryFeeMinor.toString(),
      to: after.deliveryFeeMinor.toString(),
    };
  }
  if (before.returnFeeMinor !== after.returnFeeMinor) {
    changes["returnFeeMinor"] = {
      from: before.returnFeeMinor.toString(),
      to: after.returnFeeMinor.toString(),
    };
  }
  if (before.currency !== after.currency) {
    changes["currency"] = { from: before.currency, to: after.currency };
  }
  return Object.keys(changes).length === 0 ? null : changes;
}

function requireRow(rows: readonly City[]): City {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("City write returned no row");
  }
  return row;
}
