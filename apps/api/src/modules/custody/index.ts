/**
 * Custody context public API (docs/04-context-map.md §3.8).
 *
 * Bulk custody transfer between holders: manifests, sealing, receipt scanning,
 * discrepancy detection, and hub inbound scanning. Everything other modules may
 * use is exported here; internals stay unreachable.
 */
export { CustodyModule } from "./custody.module.js";
export { ManifestService } from "./application/manifest.service.js";
export { HubScanService } from "./application/hub-scan.service.js";

export type {
  ListManifestsParams,
  ManifestPage,
  ManifestItemView,
  ReceiptSummary,
  AppliedScan,
  ScanResult,
  ScanItemResult,
  BatchScanResult,
  DiscrepancyView,
  DiscrepancyReport,
} from "./application/manifest.service.js";
export type {
  InboundScanResult,
  InboundScanItemResult,
  InboundBatchResult,
} from "./application/hub-scan.service.js";

export { manifests, manifestItems, manifestDiscrepancies } from "./domain/schema.js";
export type {
  Manifest,
  NewManifest,
  ManifestItem,
  NewManifestItem,
  ManifestDiscrepancy,
  NewManifestDiscrepancy,
} from "./domain/schema.js";

export {
  MANIFEST_STATUSES,
  MANIFEST_TYPES,
  TERMINAL_MANIFEST_STATUSES,
  canManifestTransition,
  toManifestStatus,
  toManifestType,
  originatesAtHub,
  travelsInTransit,
} from "./domain/manifest-status.js";
export type { ManifestStatus, ManifestType } from "./domain/manifest-status.js";

export { formatManifestCode, normaliseHubCode } from "./domain/manifest-code.js";

export type {
  OpenManifestInput,
  AddManifestItemInput,
  SealManifestInput,
  DispatchManifestInput,
  ReceiveScanInput,
  ReceiveScanBatchInput,
  FinaliseReceiptInput,
  ResolveDiscrepancyInput,
  HubInboundScanInput,
  HubInboundScanBatchInput,
  ListManifestsInput,
} from "./domain/dtos.js";
