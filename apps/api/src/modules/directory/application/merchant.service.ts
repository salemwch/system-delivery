import { Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { AuditService, OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import {
  assignAccountManagerSchema,
  createMerchantSchema,
  updateMerchantSchema,
} from "../domain/dtos.js";
import { merchants } from "../domain/schema.js";
import type { Merchant, NewMerchant } from "../domain/schema.js";
import { AddressService } from "./address.service.js";

/** A page of merchants plus the cursor to fetch the next one. */
export interface MerchantPage {
  readonly items: Merchant[];
  readonly nextCursor: string | null;
}

export interface ListMerchantsParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: "ACTIVE" | "SUSPENDED";
  /**
   * Filters to one commercial's book of business.
   *
   * A convenience for tenant-wide roles ("show me what Salem manages"), never a
   * security control: a commercial's own list is already narrowed by RLS
   * whether or not they pass this.
   */
  readonly accountManagerId?: string;
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
    private readonly audit: AuditService,
    private readonly addresses: AddressService,
  ) {}

  /**
   * Merchant names for a set of ids, as one query.
   *
   * Exists so other modules can label a `merchantId` without reaching into
   * `merchants` themselves — `directory` owns the table, and a module that
   * queried it directly would be a boundary violation the lint rejects.
   *
   * ONE `inArray`, never a lookup per row: a page of 50 pickups must cost one
   * query, not 50. Ids absent from the result are simply missing from the map,
   * which callers render as a fallback rather than treating as an error — a
   * merchant outside the caller's RLS scope is invisible here by design.
   */
  async namesByIds(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (ids.length === 0) {
      return new Map();
    }
    // De-duplicated: a page of pickups is usually a handful of merchants, and
    // the same id repeated 50 times would widen the IN list for nothing.
    const unique = [...new Set(ids)];
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ id: merchants.id, name: merchants.name })
        .from(merchants)
        .where(inArray(merchants.id, unique));
      return new Map(rows.map((row) => [row.id, row.name]));
    });
  }

  /**
   * Registers a merchant.
   *
   * A COMMERCIAL becomes its account manager automatically. The id is read from
   * the ambient context — the same value RLS is already narrowing this
   * transaction by — and never from the DTO. Two consequences, both deliberate:
   * a commercial who signs an *expéditeur* up owns that account from its first
   * row without having to say so, and nobody can write a merchant into someone
   * else's portfolio (or out of their own) by putting an id in the body.
   * Ownership moves through {@link assignAccountManager} alone.
   *
   * For every other role the scope is absent and the account is house-managed
   * until an OWNER assigns it (invariant I25).
   */
  async create(input: unknown): Promise<Merchant> {
    const dto = parseWithZod(createMerchantSchema, input);

    const pickupAddressId = await this.resolvePickupAddress(dto);

    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        const accountManagerId = TenantContext.current()?.accountManagerId;
        const values: NewMerchant = {
          tenantId,
          name: dto.name,
          ...(accountManagerId === undefined ? {} : { accountManagerId }),
          ...(dto.code === undefined ? {} : { code: dto.code }),
          ...(dto.contactName === undefined ? {} : { contactName: dto.contactName }),
          ...(dto.contactPhone === undefined ? {} : { contactPhone: dto.contactPhone }),
          ...(dto.contactEmail === undefined ? {} : { contactEmail: dto.contactEmail }),
          ...(pickupAddressId === undefined ? {} : { defaultPickupAddressId: pickupAddressId }),
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

  /**
   * Turns whichever address form the caller sent into an id.
   *
   * `undefined` — leave the column alone. `null` — unset it. An id — use it.
   * A `pickupAddress` object is resolved into a new `addresses` row and its id
   * returned. The DTO already refused both forms at once, so the branches
   * cannot overlap.
   *
   * ⚠️ Resolved BEFORE the caller's transaction opens, not inside it.
   * `AddressService.resolve` geocodes — a network call to Nominatim or a paid
   * provider — and holding a write transaction across it pins a connection for
   * the length of someone else's HTTP timeout. The cost of separating them is
   * an orphaned address row if the merchant write then fails, which is
   * harmless: `addresses` is retained history and nothing references it.
   */
  private async resolvePickupAddress(dto: {
    readonly defaultPickupAddressId?: string | null | undefined;
    readonly pickupAddress?: unknown;
  }): Promise<string | null | undefined> {
    if (dto.pickupAddress === undefined) {
      return dto.defaultPickupAddressId;
    }
    return (await this.addresses.resolve(dto.pickupAddress)).addressId;
  }

  async getById(id: string): Promise<Merchant> {
    return this.database.withTenant((tx) => this.loadOne(tx, id));
  }

  /**
   * The single-row read, on the CALLER's transaction.
   *
   * Separate from {@link getById} so a command that must read-then-write does
   * both inside one transaction — reading through `getById` would open a second
   * one, and the row could change in between.
   */
  private async loadOne(tx: TenantTransaction, id: string): Promise<Merchant> {
    const rows = await tx.select().from(merchants).where(eq(merchants.id, id)).limit(1);
    return requireFound(rows[0], "Merchant");
  }

  async list(params: ListMerchantsParams = {}): Promise<MerchantPage> {
    const limit = clampLimit(params.limit);
    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(params.status === undefined ? [] : [eq(merchants.status, params.status)]),
        ...(params.accountManagerId === undefined
          ? []
          : [eq(merchants.accountManagerId, params.accountManagerId)]),
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
    const pickupAddressId = await this.resolvePickupAddress(dto);
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
            // `undefined` leaves it alone; `null` unsets it; an id sets it.
            // `pickupAddress` has already become an id by this point.
            ...(pickupAddressId === undefined ? {} : { defaultPickupAddressId: pickupAddressId }),
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

  /**
   * Hands the account to a commercial, or takes it back (`null`).
   *
   * Recorded in the audit trail rather than published to the outbox: nothing
   * downstream reacts to this, but it changes WHO CAN SEE the merchant's
   * shipments, customers and revenue, and §10 makes a change of access
   * mandatory to record. Reading `current` first is what lets the entry state
   * both sides of the move — an entry that says only "assigned to X" cannot
   * answer who lost the account.
   */
  async assignAccountManager(id: string, input: unknown): Promise<Merchant> {
    const dto = parseWithZod(assignAccountManagerSchema, input);

    try {
      return await this.database.withTenant(async (tx) => {
        const current = await this.loadOne(tx, id);
        if (current.accountManagerId === dto.accountManagerId) {
          return current;
        }

        const rows = await tx
          .update(merchants)
          .set({ accountManagerId: dto.accountManagerId, updatedAt: sql`now()` })
          .where(eq(merchants.id, id))
          .returning();
        const updated = requireFound(rows[0], "Merchant");

        await this.audit.record(tx, {
          action: "merchant.account_manager_assigned",
          resourceType: "merchant",
          resourceId: id,
          changes: {
            accountManagerId: {
              from: current.accountManagerId,
              to: dto.accountManagerId,
            },
          },
        });

        return updated;
      });
    } catch (error) {
      // 23514 from `merchants_assert_account_manager_tenant`: the user exists,
      // but in another tenant. Not found is the honest answer AND the safe one —
      // confirming the id would make this endpoint a cross-tenant user oracle.
      if (isCheckViolation(error) || isForeignKeyViolation(error, "merchants_account_manager_id_fkey")) {
        throw new NotFoundError("User");
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
