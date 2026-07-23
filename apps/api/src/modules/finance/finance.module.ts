import { Module } from "@nestjs/common";

import { CurrencyService } from "./application/currency.service.js";
import { LedgerService } from "./application/ledger.service.js";
import { LedgerEventHandler } from "./application/ledger-event.handler.js";

/**
 * Finance context (docs/04-context-map.md §3.10) — Layer 3.
 *
 * At MVP it is reactive: the {@link LedgerEventHandler} is driven by the platform's
 * generic stream consumer (bound in the core-worker composition root), and the
 * ledger/currency services it needs are provided here. Depends only on the shared
 * database (global) — the ledger reads nothing from a higher layer; every money
 * event it acts on is self-contained.
 */
@Module({
  providers: [CurrencyService, LedgerService, LedgerEventHandler],
  exports: [CurrencyService, LedgerService, LedgerEventHandler],
})
export class FinanceModule {}
