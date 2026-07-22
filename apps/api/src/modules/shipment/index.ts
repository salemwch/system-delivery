/**
 * Shipment context public API (docs/04-context-map.md §3.6).
 *
 * Placeholder. The shipment aggregate — lifecycle, immutable custody log,
 * proof of delivery — is the next domain module to be built.
 *
 * The barrel exists now because tools/verify-lint-rules.mjs uses a
 * `platform -> shipment` import to prove the upward-dependency rule rejects a
 * layer violation. Removing it would silently disable that check.
 */
export const SHIPMENT_MODULE = "shipment" as const;
