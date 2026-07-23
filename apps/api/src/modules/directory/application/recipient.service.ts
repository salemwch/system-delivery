import { Injectable } from "@nestjs/common";
import { and, desc, eq, lt, sql } from "drizzle-orm";

import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import { ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import {
  blockRecipientSchema,
  createRecipientSchema,
  updateRecipientSchema,
} from "../domain/dtos.js";
import { recipients } from "../domain/schema.js";
import type { NewRecipient, Recipient } from "../domain/schema.js";

export interface RecipientPage {
  readonly items: Recipient[];
  readonly nextCursor: string | null;
}

export interface ListRecipientsParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly blocked?: boolean;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Recipients — the reusable address book (docs/02-domain-model.md §3.19).
 *
 * Unique on (tenant, phone): the phone is the identity in MENA. The delivery
 * counters (`totalShipments`, `successfulDeliveries`, …) are projections rebuilt
 * from `shipment_events` and are NEVER mutated here — this service owns only the
 * book, not the delivery history that the shipment module maintains.
 */
@Injectable()
export class RecipientService {
  constructor(private readonly database: DatabaseService) {}

  async create(input: unknown): Promise<Recipient> {
    const dto = parseWithZod(createRecipientSchema, input);
    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        const values: NewRecipient = {
          tenantId,
          fullName: dto.fullName,
          phone: dto.phone,
          ...(dto.phoneAlt === undefined ? {} : { phoneAlt: dto.phoneAlt }),
          ...(dto.defaultAddressId === undefined ? {} : { defaultAddressId: dto.defaultAddressId }),
          ...(dto.preferredLanguage === undefined
            ? {}
            : { preferredLanguage: dto.preferredLanguage }),
          ...(dto.notes === undefined ? {} : { notes: dto.notes }),
        };
        const rows = await tx.insert(recipients).values(values).returning();
        return requireRow(rows);
      });
    } catch (error) {
      if (isUniqueViolation(error, "recipients_tenant_phone_uq")) {
        throw new ConflictError(
          "RECIPIENT_PHONE_TAKEN",
          `A recipient with phone ${dto.phone} already exists — edit or merge it instead.`,
        );
      }
      throw error;
    }
  }

  async getById(id: string): Promise<Recipient> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx.select().from(recipients).where(eq(recipients.id, id)).limit(1);
      return requireFound(rows[0], "Recipient");
    });
  }

  /**
   * Looks a recipient up by phone (its natural key), or `null` if none. The
   * shipment module uses this to decide between reusing and creating the book
   * entry for an incoming shipment.
   */
  async findByPhone(phone: string): Promise<Recipient | null> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx.select().from(recipients).where(eq(recipients.phone, phone)).limit(1);
      return rows[0] ?? null;
    });
  }

  async list(params: ListRecipientsParams = {}): Promise<RecipientPage> {
    const limit = clampLimit(params.limit);
    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(params.blocked === undefined ? [] : [eq(recipients.isBlocked, params.blocked)]),
        ...(params.cursor === undefined ? [] : [lt(recipients.id, params.cursor)]),
      ];
      const rows = await tx
        .select()
        .from(recipients)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(recipients.id))
        .limit(limit + 1);
      return toPage(rows, limit);
    });
  }

  async update(id: string, input: unknown): Promise<Recipient> {
    const dto = parseWithZod(updateRecipientSchema, input);
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .update(recipients)
        .set({
          ...(dto.fullName === undefined ? {} : { fullName: dto.fullName }),
          ...(dto.phoneAlt === undefined ? {} : { phoneAlt: dto.phoneAlt }),
          ...(dto.defaultAddressId === undefined ? {} : { defaultAddressId: dto.defaultAddressId }),
          ...(dto.preferredLanguage === undefined
            ? {}
            : { preferredLanguage: dto.preferredLanguage }),
          ...(dto.notes === undefined ? {} : { notes: dto.notes }),
          updatedAt: sql`now()`,
        })
        .where(eq(recipients.id, id))
        .returning();
      return requireFound(rows[0], "Recipient");
    });
  }

  /** Blocks new shipments to a repeat refuser (domain §3.19 rule 4). */
  async block(id: string, input: unknown): Promise<Recipient> {
    const dto = parseWithZod(blockRecipientSchema, input);
    return this.setBlocked(id, true, dto.reason);
  }

  async unblock(id: string): Promise<Recipient> {
    return this.setBlocked(id, false, null);
  }

  private async setBlocked(
    id: string,
    isBlocked: boolean,
    blockReason: string | null,
  ): Promise<Recipient> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .update(recipients)
        .set({ isBlocked, blockReason, updatedAt: sql`now()` })
        .where(eq(recipients.id, id))
        .returning();
      return requireFound(rows[0], "Recipient");
    });
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(limit)));
}

function toPage(rows: Recipient[], limit: number): RecipientPage {
  if (rows.length > limit) {
    const items = rows.slice(0, limit);
    return { items, nextCursor: items[items.length - 1]?.id ?? null };
  }
  return { items: rows, nextCursor: null };
}

function requireRow(rows: Recipient[]): Recipient {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Recipient insert returned no row");
  }
  return row;
}

function requireFound(row: Recipient | undefined, resource: string): Recipient {
  if (row === undefined) {
    throw new NotFoundError(resource);
  }
  return row;
}
