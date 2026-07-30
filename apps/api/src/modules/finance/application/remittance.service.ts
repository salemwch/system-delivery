import { randomBytes } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { and, eq, ne, sql } from "drizzle-orm";

import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { OutboxService } from "../../platform/index.js";
import {
  confirmRemittanceSchema,
  disputeRemittanceSchema,
  submitRemittanceSchema,
} from "../domain/dtos.js";
import { codRemittances } from "../domain/schema.js";
import type { CodRemittance } from "../domain/schema.js";
import { CurrencyService } from "../../../shared/money/index.js";
import { LedgerService } from "./ledger.service.js";

/** Who is performing a remittance command — recorded for audit and events. */
export interface RemittanceContext {
  readonly actorUserId: string;
}

/**
 * The COD remittance workflow (docs/02-domain-model.md §3.13,
 * docs/03-event-storming.md §cod.cash_remitted) — the driver → hub cash handoff.
 *
 * It records three amounts separately — `expected` (system-computed from the
 * driver's DRIVER_CASH ledger balance, never entered), `declared` (what the driver
 * says), `counted` (what the hub actually counted) — so a driver's arithmetic
 * error, a hub miscount, and theft stay distinguishable (domain rule 1).
 *
 * On confirmation the ledger posts DEBIT hub_cash / CREDIT driver_cash by the
 * COUNTED amount, ATOMICALLY with the status change in one transaction. Because
 * the producer (this service) and the ledger are the SAME module, the ledger post
 * is a direct call, not an async consumer of `cod.cash_remitted` — that event is
 * still emitted, for the OTHER consumers (fraud review, driver receipt). A residual
 * driver_cash balance after a short remittance is the open shortfall, resolved
 * separately; nothing is auto-written-off and no driver is auto-suspended.
 */
@Injectable()
export class RemittanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly currency: CurrencyService,
    private readonly outbox: OutboxService,
  ) {}

  /** Driver declares a handover. `expected` is read from the ledger, not the driver. */
  async submit(input: unknown, _ctx: RemittanceContext): Promise<CodRemittance> {
    const dto = parseWithZod(submitRemittanceSchema, input);
    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const expected = await this.ledger.balanceOf(tx, tenantId, dto.currency, {
        ownerType: "DRIVER",
        ownerId: dto.driverId,
        accountType: "DRIVER_CASH",
      });
      const now = new Date();
      const code = remittanceCode();
      const inserted = await tx
        .insert(codRemittances)
        .values({
          tenantId,
          code,
          driverId: dto.driverId,
          hubId: dto.hubId,
          status: "SUBMITTED",
          expectedAmountMinor: expected,
          declaredAmountMinor: dto.declaredAmountMinor,
          currency: dto.currency,
          submittedAt: now,
          ...(dto.shipmentIds === undefined ? {} : { shipmentIds: dto.shipmentIds }),
          ...(dto.notes === undefined ? {} : { notes: dto.notes }),
        })
        .returning();
      const remittance = inserted[0];
      if (remittance === undefined) {
        throw new Error("cod_remittances insert returned no row");
      }

      const shipmentIds = dto.shipmentIds ?? [];
      await this.outbox.publish(tx, {
        eventType: "cod.remittance_submitted",
        aggregateType: "cod_remittance",
        aggregateId: remittance.id,
        occurredAt: now,
        payload: {
          remittanceId: remittance.id,
          code,
          driverId: dto.driverId,
          hubId: dto.hubId,
          expectedAmountMinor: expected.toString(),
          declaredAmountMinor: dto.declaredAmountMinor.toString(),
          currency: dto.currency,
          shipmentIds,
          shipmentCount: shipmentIds.length,
          occurredAt: now.toISOString(),
        },
      });
      return remittance;
    });
  }

  /**
   * Hub operator counts the cash and confirms. Posts the ledger by the counted
   * amount, records the variance, and emits `cod.cash_remitted` (+
   * `cod.variance_detected` when the counted amount differs from expected).
   */
  async confirm(id: string, input: unknown, ctx: RemittanceContext): Promise<CodRemittance> {
    const dto = parseWithZod(confirmRemittanceSchema, input);
    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const remittance = await this.loadForUpdate(tx, id);
      if (remittance.status !== "SUBMITTED") {
        throw new ConflictError(
          "REMITTANCE_NOT_SUBMITTED",
          `A remittance can only be confirmed from SUBMITTED, not ${remittance.status}.`,
        );
      }

      const counted = dto.countedAmountMinor;
      const variance = counted - remittance.expectedAmountMinor;
      if (variance !== 0n && dto.varianceReason === undefined) {
        // Rule 3: unexplained variance cannot be confirmed.
        throw new BusinessRuleError(
          "VARIANCE_REASON_REQUIRED",
          "A non-zero variance requires a reason before the remittance can be confirmed.",
        );
      }

      const now = new Date();
      // The actual cash that moved: DEBIT hub_cash / CREDIT driver_cash by counted.
      if (counted > 0n) {
        await this.ledger.postTransaction(tx, {
          tenantId,
          entryType: "COD_REMITTED",
          currency: remittance.currency,
          remittanceId: remittance.id,
          occurredAt: now,
          createdByUserId: ctx.actorUserId,
          description: "COD remittance to hub",
          lines: [
            {
              account: { ownerType: "HUB", ownerId: remittance.hubId, accountType: "HUB_CASH" },
              direction: "DEBIT",
              amountMinor: counted,
            },
            {
              account: {
                ownerType: "DRIVER",
                ownerId: remittance.driverId,
                accountType: "DRIVER_CASH",
              },
              direction: "CREDIT",
              amountMinor: counted,
            },
          ],
        });
      }

      const updated = await tx
        .update(codRemittances)
        .set({
          status: "CONFIRMED",
          countedAmountMinor: counted,
          varianceMinor: variance,
          receivedByUserId: ctx.actorUserId,
          confirmedAt: now,
          updatedAt: sql`now()`,
          ...(dto.varianceReason === undefined ? {} : { varianceReason: dto.varianceReason }),
          ...(dto.notes === undefined ? {} : { notes: dto.notes }),
        })
        .where(eq(codRemittances.id, id))
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError("Remittance");
      }

      const exponent = await this.currency.exponentOf(remittance.currency);
      await this.outbox.publish(tx, {
        eventType: "cod.cash_remitted",
        aggregateType: "cod_remittance",
        aggregateId: remittance.id,
        occurredAt: now,
        payload: {
          remittanceId: remittance.id,
          driverId: remittance.driverId,
          hubId: remittance.hubId,
          receivedByUserId: ctx.actorUserId,
          expectedAmountMinor: remittance.expectedAmountMinor.toString(),
          declaredAmountMinor: remittance.declaredAmountMinor.toString(),
          countedAmountMinor: counted.toString(),
          varianceMinor: variance.toString(),
          currency: remittance.currency,
          currencyExponent: exponent,
          shipmentIds: remittance.shipmentIds,
          occurredAt: now.toISOString(),
          ...(dto.varianceReason === undefined ? {} : { varianceReason: dto.varianceReason }),
        },
      });

      if (variance !== 0n) {
        // Scored for review, never auto-suspend (event-storming §cod.variance_detected).
        const history = await this.driverVarianceHistory(tx, remittance.driverId, remittance.id);
        await this.outbox.publish(tx, {
          eventType: "cod.variance_detected",
          aggregateType: "cod_remittance",
          aggregateId: remittance.id,
          occurredAt: now,
          payload: {
            remittanceId: remittance.id,
            driverId: remittance.driverId,
            hubId: remittance.hubId,
            varianceMinor: variance.toString(),
            currency: remittance.currency,
            varianceDirection: variance < 0n ? "SHORTAGE" : "SURPLUS",
            driverHistoricalVarianceCount: history.count,
            driverHistoricalVarianceMinor: history.totalMinor.toString(),
            ...(dto.varianceReason === undefined ? {} : { varianceReason: dto.varianceReason }),
          },
        });
      }

      return row;
    });
  }

  /** Hub operator flags a submitted remittance for investigation (no ledger post). */
  async dispute(id: string, input: unknown, _ctx: RemittanceContext): Promise<CodRemittance> {
    const dto = parseWithZod(disputeRemittanceSchema, input);
    return this.transition(id, "SUBMITTED", "DISPUTED", { varianceReason: dto.reason });
  }

  /** Resolve a disputed remittance once investigated. */
  async resolve(id: string, _ctx: RemittanceContext): Promise<CodRemittance> {
    return this.transition(id, "DISPUTED", "RESOLVED", {});
  }

  async getById(id: string): Promise<CodRemittance> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx.select().from(codRemittances).where(eq(codRemittances.id, id)).limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError("Remittance");
      }
      return row;
    });
  }

  private async transition(
    id: string,
    from: string,
    to: string,
    extra: { varianceReason?: string },
  ): Promise<CodRemittance> {
    return this.database.withTenant(async (tx) => {
      const remittance = await this.loadForUpdate(tx, id);
      if (remittance.status !== from) {
        throw new ConflictError(
          "REMITTANCE_INVALID_TRANSITION",
          `A remittance cannot move to ${to} from ${remittance.status}.`,
        );
      }
      const updated = await tx
        .update(codRemittances)
        .set({
          status: to,
          updatedAt: sql`now()`,
          ...(extra.varianceReason === undefined ? {} : { varianceReason: extra.varianceReason }),
        })
        .where(eq(codRemittances.id, id))
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError("Remittance");
      }
      return row;
    });
  }

  private async loadForUpdate(tx: TenantTransaction, id: string): Promise<CodRemittance> {
    const rows = await tx
      .select()
      .from(codRemittances)
      .where(eq(codRemittances.id, id))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Remittance");
    }
    return row;
  }

  /** Prior confirmed variances for a driver — context so review can spot a pattern. */
  private async driverVarianceHistory(
    tx: TenantTransaction,
    driverId: string,
    excludeId: string,
  ): Promise<{ count: number; totalMinor: bigint }> {
    const rows = await tx
      .select({
        count: sql<string>`count(*)`,
        total: sql<string>`coalesce(sum(abs(${codRemittances.varianceMinor})), 0)`,
      })
      .from(codRemittances)
      .where(
        and(
          eq(codRemittances.driverId, driverId),
          ne(codRemittances.id, excludeId),
          ne(codRemittances.varianceMinor, 0n),
        ),
      );
    const row = rows[0];
    return {
      count: Number(row?.count ?? "0"),
      totalMinor: BigInt(row?.total ?? "0"),
    };
  }
}

/** A unique-per-tenant receipt code. Random suffix; the unique index is the guard. */
function remittanceCode(): string {
  const now = new Date();
  const datePart =
    `${now.getUTCFullYear()}` +
    `${(now.getUTCMonth() + 1).toString().padStart(2, "0")}` +
    `${now.getUTCDate().toString().padStart(2, "0")}`;
  return `RM-${datePart}-${randomBytes(3).toString("hex").toUpperCase()}`;
}
