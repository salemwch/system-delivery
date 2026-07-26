import { randomBytes } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { and, eq, isNotNull, notExists, sql } from "drizzle-orm";

import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { OutboxService } from "../../platform/index.js";
import { createSettlementSchema, markSettlementPaidSchema } from "../domain/dtos.js";
import {
  ledgerAccounts,
  ledgerEntries,
  settlementShipments,
  settlements,
} from "../domain/schema.js";
import type { Settlement } from "../domain/schema.js";
import { CurrencyService } from "./currency.service.js";
import { LedgerService } from "./ledger.service.js";
import type { PostingLine } from "./ledger.service.js";

/** Who is performing a settlement command — the actor and their role. */
export interface SettlementContext {
  readonly actorUserId: string;
  readonly role: string;
}

/** Roles permitted to approve a settlement (domain §3.16 rule 4). */
const APPROVER_ROLES: ReadonlySet<string> = new Set<string>(["OWNER", "FINANCE"]);

/**
 * Merchant settlement (docs/02-domain-model.md §3.16, docs/03-event-storming.md
 * §settlement.paid) — the courier paying a merchant the COD collected on its
 * behalf, less delivery fees.
 *
 * MVP scope (operational-timing): a draft settles a merchant's COD COLLECTED in a
 * period — gross summed from the merchant's MERCHANT_PAYABLE collection entries,
 * excluding shipments already in a settlement. The "only REMITTED COD is settleable"
 * rule is satisfied by finance running settlements after remittances; adjustments
 * and negative net are deferred (net = gross − fees, net >= 0).
 *
 * Two controls are load-bearing: **separation of duties** — the approver must not
 * be the drafter, and must hold FINANCE or OWNER — and **at-most-one-settlement-
 * per-shipment**, enforced by the unique index on settlement_shipments. Ledger
 * entries post on PAID, not APPROVED (approval is intent; payment is the fact),
 * as one balanced transaction so fees do not linger in the payable:
 * DEBIT merchant_payable GROSS · CREDIT bank NET · CREDIT platform_revenue FEES.
 */
@Injectable()
export class SettlementService {
  constructor(
    private readonly database: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly currency: CurrencyService,
    private readonly outbox: OutboxService,
  ) {}

  /** Draft a settlement for a merchant + period. Gross is computed from the ledger. */
  async createDraft(input: unknown, ctx: SettlementContext): Promise<Settlement> {
    const dto = parseWithZod(createSettlementSchema, input);
    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();

      const accountRows = await tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.tenantId, tenantId),
            eq(ledgerAccounts.accountType, "MERCHANT_PAYABLE"),
            eq(ledgerAccounts.ownerType, "MERCHANT"),
            eq(ledgerAccounts.ownerId, dto.merchantId),
            eq(ledgerAccounts.currency, dto.currency),
          ),
        )
        .limit(1);
      const accountId = accountRows[0]?.id;

      const rows =
        accountId === undefined
          ? []
          : await tx
              .select({
                shipmentId: ledgerEntries.shipmentId,
                amountMinor: ledgerEntries.amountMinor,
              })
              .from(ledgerEntries)
              .where(
                and(
                  eq(ledgerEntries.tenantId, tenantId),
                  eq(ledgerEntries.accountId, accountId),
                  eq(ledgerEntries.entryType, "COD_COLLECTED"),
                  eq(ledgerEntries.direction, "CREDIT"),
                  isNotNull(ledgerEntries.shipmentId),
                  // Period bounds compared as dates. periodFrom/To are strings, so
                  // there is no Date-binding hazard here.
                  sql`${ledgerEntries.occurredAt}::date >= ${dto.periodFrom}`,
                  sql`${ledgerEntries.occurredAt}::date <= ${dto.periodTo}`,
                  // Exclude shipments already covered by any settlement.
                  notExists(
                    tx
                      .select({ one: sql`1` })
                      .from(settlementShipments)
                      .where(
                        and(
                          eq(settlementShipments.tenantId, tenantId),
                          eq(settlementShipments.shipmentId, ledgerEntries.shipmentId),
                        ),
                      ),
                  ),
                ),
              );

      const settleable = rows.filter(
        (row): row is { shipmentId: string; amountMinor: bigint } => row.shipmentId !== null,
      );
      if (settleable.length === 0) {
        throw new BusinessRuleError(
          "NOTHING_TO_SETTLE",
          "No unsettled COD collections for this merchant in the period.",
        );
      }

      let gross = 0n;
      for (const row of settleable) {
        gross += row.amountMinor;
      }
      const fees = dto.deliveryFeesMinor ?? 0n;
      if (fees > gross) {
        throw new BusinessRuleError(
          "SETTLEMENT_FEES_EXCEED_GROSS",
          "Delivery fees exceed gross COD; a negative net payable is not supported at MVP.",
        );
      }
      const net = gross - fees;
      const code = settlementCode();

      const inserted = await tx
        .insert(settlements)
        .values({
          tenantId,
          merchantId: dto.merchantId,
          code,
          status: "DRAFT",
          periodFrom: dto.periodFrom,
          periodTo: dto.periodTo,
          grossCodAmountMinor: gross,
          deliveryFeesMinor: fees,
          adjustmentsMinor: 0n,
          netPayableMinor: net,
          currency: dto.currency,
          shipmentCount: settleable.length,
          createdByUserId: ctx.actorUserId,
        })
        .returning();
      const settlement = inserted[0];
      if (settlement === undefined) {
        throw new Error("settlements insert returned no row");
      }

      // The unique index on (tenant_id, shipment_id) is the real guard: a race that
      // put a shipment into another settlement first aborts this insert, and the
      // whole draft rolls back — never a double payout.
      await tx.insert(settlementShipments).values(
        settleable.map((row) => ({
          tenantId,
          settlementId: settlement.id,
          shipmentId: row.shipmentId,
          amountMinor: row.amountMinor,
        })),
      );

      return settlement;
    });
  }

  /** Approve a draft. FINANCE/OWNER only, and never the user who drafted it. */
  async approve(id: string, ctx: SettlementContext): Promise<Settlement> {
    return this.database.withTenant(async (tx) => {
      const settlement = await this.loadForUpdate(tx, id);
      if (settlement.status !== "DRAFT") {
        throw new ConflictError(
          "SETTLEMENT_NOT_DRAFT",
          `A settlement can only be approved from DRAFT, not ${settlement.status}.`,
        );
      }
      if (!APPROVER_ROLES.has(ctx.role)) {
        throw new ForbiddenError("Only FINANCE or OWNER may approve a settlement.");
      }
      if (ctx.actorUserId === settlement.createdByUserId) {
        // Separation of duties: the person who drafts cannot also approve.
        throw new ForbiddenError(
          "The settlement approver must not be the user who drafted it (separation of duties).",
        );
      }

      const now = new Date();
      const updated = await tx
        .update(settlements)
        .set({
          status: "APPROVED",
          approvedByUserId: ctx.actorUserId,
          approvedAt: now,
          updatedAt: sql`now()`,
        })
        .where(eq(settlements.id, id))
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError("Settlement");
      }

      await this.outbox.publish(tx, {
        eventType: "settlement.approved",
        aggregateType: "settlement",
        aggregateId: row.id,
        occurredAt: now,
        payload: {
          settlementId: row.id,
          code: row.code,
          merchantId: row.merchantId,
          netPayableMinor: row.netPayableMinor.toString(),
          currency: row.currency,
          approvedByUserId: ctx.actorUserId,
          occurredAt: now.toISOString(),
        },
      });
      return row;
    });
  }

  /** Record a settlement as paid. THIS is where the ledger posts (domain §3.16 rule 5). */
  async markPaid(id: string, input: unknown, ctx: SettlementContext): Promise<Settlement> {
    const dto = parseWithZod(markSettlementPaidSchema, input);
    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const settlement = await this.loadForUpdate(tx, id);
      if (settlement.status !== "APPROVED") {
        throw new ConflictError(
          "SETTLEMENT_NOT_APPROVED",
          `A settlement can only be paid from APPROVED, not ${settlement.status}.`,
        );
      }

      const gross = settlement.grossCodAmountMinor;
      const fees = settlement.deliveryFeesMinor;
      const net = settlement.netPayableMinor;
      // DEBIT merchant_payable GROSS clears the full owed; CREDIT bank NET pays the
      // merchant; CREDIT platform_revenue FEES recognises the courier's fee. gross =
      // net + fees, so it balances. Zero-amount legs are omitted (amounts are > 0).
      const lines: PostingLine[] = [
        {
          account: {
            ownerType: "MERCHANT",
            ownerId: settlement.merchantId,
            accountType: "MERCHANT_PAYABLE",
          },
          direction: "DEBIT",
          amountMinor: gross,
        },
      ];
      if (net > 0n) {
        lines.push({
          account: { ownerType: "TENANT", ownerId: tenantId, accountType: "BANK" },
          direction: "CREDIT",
          amountMinor: net,
        });
      }
      if (fees > 0n) {
        lines.push({
          account: { ownerType: "TENANT", ownerId: tenantId, accountType: "PLATFORM_REVENUE" },
          direction: "CREDIT",
          amountMinor: fees,
        });
      }
      await this.ledger.postTransaction(tx, {
        tenantId,
        entryType: "SETTLEMENT",
        currency: settlement.currency,
        settlementId: settlement.id,
        createdByUserId: ctx.actorUserId,
        description: "Merchant settlement payout",
        lines,
      });

      const now = new Date();
      const updated = await tx
        .update(settlements)
        .set({
          status: "PAID",
          paymentMethod: dto.paymentMethod,
          paidAt: now,
          updatedAt: sql`now()`,
          ...(dto.paymentReference === undefined ? {} : { paymentReference: dto.paymentReference }),
        })
        .where(eq(settlements.id, id))
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError("Settlement");
      }

      const exponent = await this.currency.exponentOf(settlement.currency);
      await this.outbox.publish(tx, {
        eventType: "settlement.paid",
        aggregateType: "settlement",
        aggregateId: row.id,
        occurredAt: now,
        payload: {
          settlementId: row.id,
          code: row.code,
          merchantId: row.merchantId,
          periodFrom: row.periodFrom,
          periodTo: row.periodTo,
          grossCodAmountMinor: gross.toString(),
          deliveryFeesMinor: fees.toString(),
          adjustmentsMinor: "0",
          netPayableMinor: net.toString(),
          currency: row.currency,
          currencyExponent: exponent,
          shipmentCount: row.shipmentCount,
          paymentMethod: dto.paymentMethod,
          paidAt: now.toISOString(),
          ...(dto.paymentReference === undefined ? {} : { paymentReference: dto.paymentReference }),
        },
      });
      return row;
    });
  }

  /** Cancel a settlement before payment, freeing its shipments for a later settlement. */
  async cancel(id: string, _ctx: SettlementContext): Promise<Settlement> {
    return this.database.withTenant(async (tx) => {
      const settlement = await this.loadForUpdate(tx, id);
      if (settlement.status !== "DRAFT" && settlement.status !== "APPROVED") {
        throw new ConflictError(
          "SETTLEMENT_NOT_CANCELLABLE",
          `A settlement can only be cancelled before payment, not from ${settlement.status}.`,
        );
      }
      // Provisional lines are removed so those shipments can be settled again.
      await tx.delete(settlementShipments).where(eq(settlementShipments.settlementId, id));
      const updated = await tx
        .update(settlements)
        .set({ status: "CANCELLED", updatedAt: sql`now()` })
        .where(eq(settlements.id, id))
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError("Settlement");
      }
      return row;
    });
  }

  async getById(id: string): Promise<Settlement> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx.select().from(settlements).where(eq(settlements.id, id)).limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError("Settlement");
      }
      return row;
    });
  }

  private async loadForUpdate(tx: TenantTransaction, id: string): Promise<Settlement> {
    const rows = await tx
      .select()
      .from(settlements)
      .where(eq(settlements.id, id))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Settlement");
    }
    return row;
  }
}

/** A unique-per-tenant settlement code. Random suffix; the unique index is the guard. */
function settlementCode(): string {
  const now = new Date();
  const datePart =
    `${now.getUTCFullYear()}` +
    `${(now.getUTCMonth() + 1).toString().padStart(2, "0")}` +
    `${now.getUTCDate().toString().padStart(2, "0")}`;
  return `ST-${datePart}-${randomBytes(3).toString("hex").toUpperCase()}`;
}
