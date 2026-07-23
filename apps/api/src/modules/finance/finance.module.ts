import { Module } from "@nestjs/common";

import { PlatformModule } from "../platform/index.js";
import { CurrencyService } from "./application/currency.service.js";
import { LedgerService } from "./application/ledger.service.js";
import { LedgerEventHandler } from "./application/ledger-event.handler.js";
import { RemittanceService } from "./application/remittance.service.js";

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
  providers: [CurrencyService, LedgerService, LedgerEventHandler, RemittanceService],
  exports: [CurrencyService, LedgerService, LedgerEventHandler, RemittanceService],
})
export class FinanceModule {}
