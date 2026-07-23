/**
 * Finance context public API (docs/04-context-map.md §3.10) — Layer 3.
 *
 * The double-entry ledger and COD money flow. Reactive at MVP: the
 * {@link LedgerEventHandler} is driven by the platform stream consumer (wired in
 * the core-worker composition root). The services are exported so that composition
 * root — and later a request-path controller for remittance/settlement — can use
 * them. It never imports higher layers; it consumes self-contained events.
 */
export { FinanceModule } from "./finance.module.js";
export { CurrencyService } from "./application/currency.service.js";
export { LedgerService } from "./application/ledger.service.js";
export type {
  AccountRef,
  PostingLine,
  PostTransactionInput,
} from "./application/ledger.service.js";
export { LedgerEventHandler } from "./application/ledger-event.handler.js";

export {
  ACCOUNT_TYPES,
  OWNER_TYPES,
  DIRECTIONS,
  ENTRY_TYPES,
  normalBalanceFor,
  balanceDelta,
  asNormalBalance,
} from "./domain/ledger.js";
export type {
  AccountType,
  OwnerType,
  Direction,
  EntryType,
  NormalBalance,
} from "./domain/ledger.js";

export { formatMinorUnits, parseMinorUnits } from "./domain/money.js";

export { currencies, ledgerAccounts, ledgerEntries } from "./domain/schema.js";
export type {
  Currency,
  LedgerAccount,
  NewLedgerAccount,
  LedgerEntry,
  NewLedgerEntry,
} from "./domain/schema.js";
