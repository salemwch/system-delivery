import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/application/token.service.js";
import { RemittanceService } from "../application/remittance.service.js";
import type { RemittanceContext } from "../application/remittance.service.js";
import { SettlementService } from "../application/settlement.service.js";
import type { SettlementContext } from "../application/settlement.service.js";
import { ReconciliationService } from "../application/reconciliation.service.js";
import type { CashInField, DailyReconciliation } from "../application/reconciliation.service.js";
import type { CodRemittance, Settlement } from "../domain/schema.js";
import {
  confirmRemittanceSchema,
  createSettlementSchema,
  disputeRemittanceSchema,
  markSettlementPaidSchema,
  submitRemittanceSchema,
} from "../domain/dtos.js";

const cashInFieldQuerySchema = z.object({
  currency: z.string().trim().length(3).transform((v) => v.toUpperCase()),
});

const reconciliationQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  currency: z.string().trim().length(3).transform((v) => v.toUpperCase()),
});

interface RemittanceResponse {
  readonly id: string;
  readonly code: string;
  readonly driverId: string;
  readonly hubId: string;
  readonly receivedByUserId: string | null;
  readonly status: string;
  readonly expectedAmountMinor: string;
  readonly declaredAmountMinor: string;
  readonly countedAmountMinor: string | null;
  readonly varianceMinor: string;
  readonly currency: string;
  readonly shipmentIds: string[];
  readonly varianceReason: string | null;
  readonly notes: string | null;
  readonly submittedAt: string | null;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SettlementResponse {
  readonly id: string;
  readonly merchantId: string;
  readonly code: string;
  readonly status: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly grossCodAmountMinor: string;
  readonly deliveryFeesMinor: string;
  readonly adjustmentsMinor: string;
  readonly netPayableMinor: string;
  readonly currency: string;
  readonly shipmentCount: number;
  readonly paymentMethod: string | null;
  readonly paymentReference: string | null;
  readonly createdByUserId: string;
  readonly approvedByUserId: string | null;
  readonly approvedAt: string | null;
  readonly paidAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function remittanceCtx(principal: Principal): RemittanceContext {
  return { actorUserId: principal.userId };
}

function settlementCtx(principal: Principal): SettlementContext {
  const role = principal.roles[0] ?? "DISPATCHER";
  return { actorUserId: principal.userId, role };
}

@Controller("v1/finance")
export class FinanceController {
  constructor(
    private readonly remittances: RemittanceService,
    private readonly settlements: SettlementService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  // ── Remittances ─────────────────────────────────────────────────────────────

  @Post("remittances")
  @RequirePermissions("cod:collect")
  async submitRemittance(
    @Body(zodBody(submitRemittanceSchema)) body: z.infer<typeof submitRemittanceSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RemittanceResponse> {
    const remittance = await this.remittances.submit(body, remittanceCtx(principal));
    return toRemittanceResponse(remittance);
  }

  @Get("remittances/:id")
  @RequirePermissions("cod:read_amount")
  async getRemittance(@Param("id") id: string): Promise<RemittanceResponse> {
    const remittance = await this.remittances.getById(id);
    return toRemittanceResponse(remittance);
  }

  @Post("remittances/:id/confirm")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("cod:remit_receive")
  async confirmRemittance(
    @Param("id") id: string,
    @Body(zodBody(confirmRemittanceSchema)) body: z.infer<typeof confirmRemittanceSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RemittanceResponse> {
    const remittance = await this.remittances.confirm(id, body, remittanceCtx(principal));
    return toRemittanceResponse(remittance);
  }

  @Post("remittances/:id/dispute")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("cod:remit_receive")
  async disputeRemittance(
    @Param("id") id: string,
    @Body(zodBody(disputeRemittanceSchema)) body: z.infer<typeof disputeRemittanceSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RemittanceResponse> {
    const remittance = await this.remittances.dispute(id, body, remittanceCtx(principal));
    return toRemittanceResponse(remittance);
  }

  // ── Settlements ─────────────────────────────────────────────────────────────

  @Post("settlements")
  @RequirePermissions("settlement:read")
  async createSettlement(
    @Body(zodBody(createSettlementSchema)) body: z.infer<typeof createSettlementSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SettlementResponse> {
    const settlement = await this.settlements.createDraft(body, settlementCtx(principal));
    return toSettlementResponse(settlement);
  }

  @Get("settlements/:id")
  @RequirePermissions("settlement:read")
  async getSettlement(@Param("id") id: string): Promise<SettlementResponse> {
    const settlement = await this.settlements.getById(id);
    return toSettlementResponse(settlement);
  }

  @Post("settlements/:id/approve")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("settlement:approve")
  async approveSettlement(
    @Param("id") id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SettlementResponse> {
    const settlement = await this.settlements.approve(id, settlementCtx(principal));
    return toSettlementResponse(settlement);
  }

  @Post("settlements/:id/mark-paid")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("settlement:mark_paid")
  async markSettlementPaid(
    @Param("id") id: string,
    @Body(zodBody(markSettlementPaidSchema)) body: z.infer<typeof markSettlementPaidSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SettlementResponse> {
    const settlement = await this.settlements.markPaid(id, body, settlementCtx(principal));
    return toSettlementResponse(settlement);
  }

  // ── Reconciliation ──────────────────────────────────────────────────────────

  @Get("cash-in-field")
  @RequirePermissions("ledger:read")
  async cashInField(@Query() query: unknown): Promise<CashInField> {
    const parsed = cashInFieldQuerySchema.parse(query);
    return this.reconciliation.cashInField(parsed.currency);
  }

  @Get("reconciliation")
  @RequirePermissions("ledger:read")
  async dailyReconciliation(@Query() query: unknown): Promise<DailyReconciliation> {
    const parsed = reconciliationQuerySchema.parse(query);
    return this.reconciliation.dailyReconciliation(parsed.date, parsed.currency);
  }
}

function toRemittanceResponse(r: CodRemittance): RemittanceResponse {
  return {
    id: r.id,
    code: r.code,
    driverId: r.driverId,
    hubId: r.hubId,
    receivedByUserId: r.receivedByUserId,
    status: r.status,
    expectedAmountMinor: r.expectedAmountMinor.toString(),
    declaredAmountMinor: r.declaredAmountMinor.toString(),
    countedAmountMinor: r.countedAmountMinor?.toString() ?? null,
    varianceMinor: r.varianceMinor.toString(),
    currency: r.currency,
    shipmentIds: r.shipmentIds,
    varianceReason: r.varianceReason,
    notes: r.notes,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toSettlementResponse(s: Settlement): SettlementResponse {
  return {
    id: s.id,
    merchantId: s.merchantId,
    code: s.code,
    status: s.status,
    periodFrom: s.periodFrom,
    periodTo: s.periodTo,
    grossCodAmountMinor: s.grossCodAmountMinor.toString(),
    deliveryFeesMinor: s.deliveryFeesMinor.toString(),
    adjustmentsMinor: s.adjustmentsMinor.toString(),
    netPayableMinor: s.netPayableMinor.toString(),
    currency: s.currency,
    shipmentCount: s.shipmentCount,
    paymentMethod: s.paymentMethod,
    paymentReference: s.paymentReference,
    createdByUserId: s.createdByUserId,
    approvedByUserId: s.approvedByUserId,
    approvedAt: s.approvedAt?.toISOString() ?? null,
    paidAt: s.paidAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
