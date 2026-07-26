import { Module } from "@nestjs/common";

import { PlatformModule } from "../platform/index.js";
import { FinanceController } from "./api/finance.controller.js";
import { CurrencyService } from "./application/currency.service.js";
import { LedgerService } from "./application/ledger.service.js";
import { LedgerEventHandler } from "./application/ledger-event.handler.js";
import { ReconciliationService } from "./application/reconciliation.service.js";
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
  imports: [PlatformModule],
  controllers: [FinanceController],
  providers: [
    CurrencyService,
    LedgerService,
    LedgerEventHandler,
    RemittanceService,
    SettlementService,
    ReconciliationService,
  ],
  exports: [
    CurrencyService,
    LedgerService,
    LedgerEventHandler,
    RemittanceService,
    SettlementService,
    ReconciliationService,
  ],
})
export class FinanceModule {}
