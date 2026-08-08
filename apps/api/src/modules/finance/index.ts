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
export { LedgerService } from "./application/ledger.service.js";
export type {
  AccountRef,
  PostingLine,
  PostTransactionInput,
} from "./application/ledger.service.js";
export { LedgerEventHandler } from "./application/ledger-event.handler.js";
export { RemittanceService } from "./application/remittance.service.js";
export type { RemittanceContext } from "./application/remittance.service.js";
export { SettlementService } from "./application/settlement.service.js";
export type { SettlementContext } from "./application/settlement.service.js";
export { InvoiceService } from "./application/invoice.service.js";
export type { InvoiceView, InvoicePage } from "./application/invoice.service.js";
export { ReconciliationService } from "./application/reconciliation.service.js";
export type {
  CashInField,
  DriverCashHolding,
  DailyReconciliation,
} from "./application/reconciliation.service.js";
export {
  submitRemittanceSchema,
  confirmRemittanceSchema,
  disputeRemittanceSchema,
  createSettlementSchema,
  markSettlementPaidSchema,
  createInvoiceSchema,
  addInvoiceLineSchema,
  createCreditNoteSchema,
  listInvoicesSchema,
  updateBillingSettingsSchema,
} from "./domain/dtos.js";
export type {
  SubmitRemittanceDto,
  ConfirmRemittanceDto,
  DisputeRemittanceDto,
  CreateSettlementDto,
  MarkSettlementPaidDto,
} from "./domain/dtos.js";

export {
  computeInvoiceTotals,
  formatDocumentNumber,
  NUMBER_PREFIX,
} from "./domain/invoice-totals.js";
export type { InvoiceLineInput, InvoiceTotals } from "./domain/invoice-totals.js";

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

export {
  ledgerAccounts,
  ledgerEntries,
  codRemittances,
  settlements,
  settlementShipments,
  billingSettings,
  invoiceSequences,
  invoices,
  invoiceLines,
} from "./domain/schema.js";
export type {
  LedgerAccount,
  NewLedgerAccount,
  LedgerEntry,
  NewLedgerEntry,
  CodRemittance,
  NewCodRemittance,
  Settlement,
  NewSettlement,
  SettlementShipment,
  NewSettlementShipment,
  BillingSettings,
  Invoice,
  NewInvoice,
  InvoiceLine,
  NewInvoiceLine,
} from "./domain/schema.js";
