import { Module } from "@nestjs/common";

import { MoneyModule } from "../../shared/money/money.module.js";
import { PlatformModule } from "../platform/index.js";
import { FinanceController } from "./api/finance.controller.js";
import { ExpenseController } from "./api/expense.controller.js";
import { InvoiceController } from "./api/invoice.controller.js";
import { LedgerService } from "./application/ledger.service.js";
import { LedgerEventHandler } from "./application/ledger-event.handler.js";
import { ReconciliationService } from "./application/reconciliation.service.js";
import { ExpenseService } from "./application/expense.service.js";
import { PaymentNoteService } from "./application/payment-note.service.js";
import { InvoiceService } from "./application/invoice.service.js";
import { RemittanceService } from "./application/remittance.service.js";
import { SettlementService } from "./application/settlement.service.js";

/**
 * Finance context (docs/04-context-map.md §3.10) — Layer 3.
 *
 * Two faces: a reactive one and a command one. The {@link LedgerEventHandler} is
 * driven by the platform's generic stream consumer (bound in the core-worker
 * composition root) and posts the ledger for cross-layer money events
 * (`cod.collected`). {@link RemittanceService} is a request-path command service
 * (hub operator) that posts the ledger DIRECTLY and emits its events through the
 * outbox — hence the dependency on `platform` (OutboxService). Everything below is
 * lower-layer or self-contained; finance never reads up.
 */
@Module({
  imports: [PlatformModule, MoneyModule],
  controllers: [FinanceController, InvoiceController, ExpenseController],
  providers: [
    LedgerService,
    LedgerEventHandler,
    RemittanceService,
    SettlementService,
    ReconciliationService,
    InvoiceService,
    ExpenseService,
    PaymentNoteService,
  ],
  exports: [
    LedgerService,
    LedgerEventHandler,
    RemittanceService,
    SettlementService,
    ReconciliationService,
    InvoiceService,
    ExpenseService,
    PaymentNoteService,
  ],
})
export class FinanceModule {}
