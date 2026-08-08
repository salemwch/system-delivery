import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrencyService } from "../../../shared/money/index.js";
import { RequirePermissions } from "../../identity/index.js";
import { CityService } from "../application/city.service.js";
import type { CityMatch } from "../application/city.service.js";
import { createCitySchema, resolveCitiesSchema, updateCitySchema } from "../domain/dtos.js";
import type { City } from "../domain/schema.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
  governorate: z.string().min(1).optional(),
  zoneId: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  active: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

interface CityResponse {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameAr: string | null;
  readonly governorate: string;
  readonly postalCode: string | null;
  readonly zoneId: string | null;
  readonly currency: string;
  readonly currencyExponent: number;
  /** Minor units as a string — JSON has no bigint and a number would round. */
  readonly deliveryFeeMinor: string;
  readonly returnFeeMinor: string;
  readonly deliveryDelayDays: number;
  readonly aliases: readonly string[];
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

interface ResolveResponse {
  readonly data: readonly { readonly query: string; readonly city: CityResponse | null }[];
  /** The names that matched nothing, so a caller can report them in one go. */
  readonly unmatched: readonly string[];
}

/**
 * Villes — coverage and tariff.
 *
 * Reading is `hub:read` and writing `hub:manage`, the same pair that guards
 * zones. A city is network configuration: whoever may redraw a territory may
 * price it, and no third permission is invented for a screen that sits beside
 * the zone editor.
 */
@Controller("v1/cities")
export class CityController {
  constructor(
    private readonly cities: CityService,
    private readonly currencies: CurrencyService,
  ) {}

  @Post()
  @RequirePermissions("hub:manage")
  async create(
    @Body(zodBody(createCitySchema)) body: z.infer<typeof createCitySchema>,
  ): Promise<CityResponse> {
    return this.render(await this.cities.create(body));
  }

  @Get()
  @RequirePermissions("hub:read")
  async list(@Query() query: unknown): Promise<PageResponse<CityResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.cities.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.governorate === undefined ? {} : { governorate: parsed.governorate }),
      ...(parsed.zoneId === undefined ? {} : { zoneId: parsed.zoneId }),
      ...(parsed.search === undefined ? {} : { search: parsed.search }),
      ...(parsed.active === undefined ? {} : { active: parsed.active }),
    });
    return {
      data: await this.renderAll(page.items),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  /**
   * Free text → tariff, in bulk.
   *
   * A POST despite reading nothing: the caller sends up to 500 names, which do
   * not fit in a query string, and city names are the kind of thing that must
   * not end up in an access log.
   */
  @Post("resolve")
  @RequirePermissions("hub:read")
  async resolve(
    @Body(zodBody(resolveCitiesSchema)) body: z.infer<typeof resolveCitiesSchema>,
  ): Promise<ResolveResponse> {
    const matches = await this.cities.resolveMany(body);
    const matched = matches.filter(hasCity);
    const rendered = new Map<string, CityResponse>();
    for (const response of await this.renderAll(matched.map((match) => match.city))) {
      rendered.set(response.id, response);
    }
    return {
      data: matches.map((match) => ({
        query: match.query,
        city: match.city === null ? null : (rendered.get(match.city.id) ?? null),
      })),
      unmatched: matches.filter((match) => match.city === null).map((match) => match.query),
    };
  }

  @Get(":id")
  @RequirePermissions("hub:read")
  async getById(@Param("id") id: string): Promise<CityResponse> {
    return this.render(await this.cities.getById(id));
  }

  @Patch(":id")
  @RequirePermissions("hub:manage")
  async update(
    @Param("id") id: string,
    @Body(zodBody(updateCitySchema)) body: z.infer<typeof updateCitySchema>,
  ): Promise<CityResponse> {
    return this.render(await this.cities.update(id, body));
  }

  private async render(city: City): Promise<CityResponse> {
    return toResponse(city, await this.currencies.exponentOf(city.currency));
  }

  /**
   * One exponent lookup per DISTINCT currency, not per row.
   *
   * `CurrencyService` caches per process, so this is cheap either way — but a
   * page of 500 cities calling it 500 times is 500 awaits in a hot path for an
   * answer that cannot differ within a currency.
   */
  private async renderAll(rows: readonly City[]): Promise<CityResponse[]> {
    const exponents = new Map<string, number>();
    for (const currency of new Set(rows.map((row) => row.currency))) {
      exponents.set(currency, await this.currencies.exponentOf(currency));
    }
    return rows.map((row) => {
      const exponent = exponents.get(row.currency);
      if (exponent === undefined) {
        // Unreachable: the map is built from these same rows. Thrown rather
        // than defaulted, because a defaulted exponent prints 4500 millimes as
        // "4500 TND" and nobody notices until an invoice goes out.
        throw new Error(`No exponent resolved for currency ${row.currency}`);
      }
      return toResponse(row, exponent);
    });
  }
}

/** Narrows a match to one that found a city, keeping `city` non-null for TS. */
function hasCity(match: CityMatch): match is CityMatch & { readonly city: City } {
  return match.city !== null;
}

function toResponse(city: City, currencyExponent: number): CityResponse {
  return {
    id: city.id,
    code: city.code,
    name: city.name,
    nameAr: city.nameAr,
    governorate: city.governorate,
    postalCode: city.postalCode,
    zoneId: city.zoneId,
    currency: city.currency,
    currencyExponent,
    deliveryFeeMinor: city.deliveryFeeMinor.toString(),
    returnFeeMinor: city.returnFeeMinor.toString(),
    deliveryDelayDays: city.deliveryDelayDays,
    aliases: city.aliases,
    active: city.active,
    createdAt: city.createdAt.toISOString(),
    updatedAt: city.updatedAt.toISOString(),
  };
}
