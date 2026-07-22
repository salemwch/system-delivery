/**
 * The feature-flag registry (docs/02-domain-model.md §3.17).
 *
 * Keys are compile-time constants so a typo is a build error, not a silently
 * disabled feature. This is what makes "which flags exist, and who has them"
 * answerable — and what keeps per-tenant differences out of `if (tenantId ===
 * '...')` branching (invariant I17).
 */
export const FEATURE_KEYS = [
  "COD_ENABLED",
  "MULTI_HUB_ENABLED",
  "LINEHAUL_ENABLED",
  "ROUTE_OPTIMIZATION_ENABLED",
  "SMS_ENABLED",
  "PUSH_ENABLED",
  "TRACKING_PAGE_ENABLED",
  "BULK_IMPORT_ENABLED",
  "RETURN_MANAGEMENT_ENABLED",
  "GEOFENCE_ARRIVAL_ENABLED",
  "FRAUD_RULES_ENABLED",
  "POD_PHOTO_REQUIRED",
  "POD_SIGNATURE_REQUIRED",
  "POD_OTP_REQUIRED",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

const FEATURE_KEY_SET: ReadonlySet<string> = new Set<string>(FEATURE_KEYS);

export function isFeatureKey(value: string): value is FeatureKey {
  return FEATURE_KEY_SET.has(value);
}

/**
 * Feature dependencies (docs/02-domain-model.md §3.17 rule 4).
 *
 * Enabling a feature requires its prerequisites to be enabled. LINEHAUL needs
 * MULTI_HUB, because inter-hub transfers are meaningless without hubs.
 */
export const FEATURE_DEPENDENCIES: Readonly<Partial<Record<FeatureKey, readonly FeatureKey[]>>> = {
  LINEHAUL_ENABLED: ["MULTI_HUB_ENABLED"],
};

/**
 * Default flags applied at tenant provisioning, per plan.
 *
 * The Tunisia/MENA default has COD on and the operational features enabled;
 * the stricter POD requirements are opt-in per tenant.
 */
export const DEFAULT_FEATURES: Readonly<Record<FeatureKey, boolean>> = {
  COD_ENABLED: true,
  MULTI_HUB_ENABLED: true,
  LINEHAUL_ENABLED: true,
  ROUTE_OPTIMIZATION_ENABLED: true,
  SMS_ENABLED: true,
  PUSH_ENABLED: true,
  TRACKING_PAGE_ENABLED: true,
  BULK_IMPORT_ENABLED: true,
  RETURN_MANAGEMENT_ENABLED: true,
  GEOFENCE_ARRIVAL_ENABLED: true,
  FRAUD_RULES_ENABLED: true,
  POD_PHOTO_REQUIRED: false,
  POD_SIGNATURE_REQUIRED: false,
  POD_OTP_REQUIRED: false,
};
