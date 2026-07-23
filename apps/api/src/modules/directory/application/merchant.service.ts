import { Injectable } from "@nestjs/common";
import { and, desc, eq, lt, sql } from "drizzle-orm";

import { OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import { ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { createMerchantSchema, updateMerchantSchema } from "../domain/dtos.js";
import { merchants } from "../domain/schema.js";
import type { Merchant, NewMerchant } from "../domain/schema.js";

/** A page of merchants plus the cursor to fetch the next one. */
export interface MerchantPage {
  readonly items: Merchant[];
  readonly nextCursor: string | null;
}

export interface ListMerchantsParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: "ACTIVE" | "SUSPENDED";
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Merchants — the businesses that ship through the tenant (directory context,
 * docs/04-context-map.md §3.3).
 *
 * A merchant is never hard-deleted: `status` is its lifecycle, so ledger and
 * settlement history stay intact and a suspended merchant can be reactivated.
 */
@Injectable()
export class MerchantService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
  ) {}

  async create(input: unknown): Promise<Merchant> {
    const dto = parseWithZod(createMerchantSchema, input);

    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        const values: NewMerchant = {
          tenantId,
          name: dto.name,
          ...(dto.code === undefined ? {} : { code: dto.code }),
          ...(dto.contactName === undefined ? {} : { contactName: dto.contactName }),
          ...(dto.contactPhone === undefined ? {} : { contactPhone: dto.contactPhone }),
          ...(dto.contactEmail === undefined ? {} : { contactEmail: dto.contactEmail }),
          ...(dto.defaultPickupAddressId === undefined
            ? {}
            : { defaultPickupAddressId: dto.defaultPickupAddressId }),
          ...(dto.settings === undefined ? {} : { settings: dto.settings }),
        };

        const merchant = requireRow(await tx.insert(merchants).values(values).returning());

        await this.outbox.publish(tx, {
          eventType: "merchant.created",
          aggregateType: "merchant",
          aggregateId: merchant.id,
          payload: { name: merchant.name, code: merchant.code, status: merchant.status },
        });

        return merchant;
      });
    } catch (error) {
      if (isUniqueViolation(error, "merchants_tenant_code_uq")) {
        throw new ConflictError(
          "MERCHANT_CODE_TAKEN",
          `Merchant code "${dto.code}" is already in use.`,
        );
      }
      throw error;
    }
  }

  async getById(id: string): Promise<Merchant> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx.select().from(merchants).where(eq(merchants.id, id)).limit(1);
      return requireFound(rows[0], "Merchant");
    });
  }

  async list(params: ListMerchantsParams = {}): Promise<MerchantPage> {
    const limit = clampLimit(params.limit);
    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(params.status === undefined ? [] : [eq(merchants.status, params.status)]),
        ...(params.cursor === undefined ? [] : [lt(merchants.id, params.cursor)]),
      ];
      const rows = await tx
        .select()
        .from(merchants)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(merchants.id))
        .limit(limit + 1);
      return toPage(rows, limit);
    });
  }

  async update(id: string, input: unknown): Promise<Merchant> {
    const dto = parseWithZod(updateMerchantSchema, input);
    try {
      return await this.database.withTenant(async (tx) => {
        const rows = await tx
          .update(merchants)
          .set({
            ...(dto.name === undefined ? {} : { name: dto.name }),
            ...(dto.code === undefined ? {} : { code: dto.code }),
            ...(dto.contactName === undefined ? {} : { contactName: dto.contactName }),
            ...(dto.contactPhone === undefined ? {} : { contactPhone: dto.contactPhone }),
            ...(dto.contactEmail === undefined ? {} : { contactEmail: dto.contactEmail }),
            ...(dto.defaultPickupAddressId === undefined
              ? {}
              : { defaultPickupAddressId: dto.defaultPickupAddressId }),
            ...(dto.settings === undefined ? {} : { settings: dto.settings }),
            updatedAt: sql`now()`,
          })
          .where(eq(merchants.id, id))
          .returning();
        return requireFound(rows[0], "Merchant");
      });
    } catch (error) {
      if (isUniqueViolation(error, "merchants_tenant_code_uq")) {
        throw new ConflictError("MERCHANT_CODE_TAKEN", "That merchant code is already in use.");
      }
      throw error;
    }
  }

  /** Suspends a merchant — new pickups can no longer be accepted for it. */
  async suspend(id: string, reason: string): Promise<Merchant> {
    return this.setStatus(id, "SUSPENDED", reason);
  }

  /** Reactivates a suspended merchant. */
  async activate(id: string): Promise<Merchant> {
    return this.setStatus(id, "ACTIVE", null);
  }

  private async setStatus(
    id: string,
    status: "ACTIVE" | "SUSPENDED",
    blockReason: string | null,
  ): Promise<Merchant> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .update(merchants)
        .set({ status, blockReason, updatedAt: sql`now()` })
        .where(eq(merchants.id, id))
        .returning();
      return requireFound(rows[0], "Merchant");
    });
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(limit)));
}

function toPage(rows: Merchant[], limit: number): MerchantPage {
  if (rows.length > limit) {
    const items = rows.slice(0, limit);
    return { items, nextCursor: items[items.length - 1]?.id ?? null };
  }
  return { items: rows, nextCursor: null };
}

function requireRow(rows: Merchant[]): Merchant {
  const row = rows[0];
  if (row === undefined) {
    // INSERT ... RETURNING yields exactly one row or throws; this guards the type.
    throw new Error("Merchant insert returned no row");
  }
  return row;
}

function requireFound(row: Merchant | undefined, resource: string): Merchant {
  if (row === undefined) {
    throw new NotFoundError(resource);
  }
  return row;
}
