import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import { tenantFeatures, tenants } from "../domain/schema.js";
import { FEATURE_KEYS } from "../domain/feature-keys.js";

interface FailureReason {
  readonly code: string;
  readonly labels: Record<string, string>;
  readonly allowsReattempt: boolean;
}

export interface BootstrapConfig {
  readonly features: Record<string, boolean>;
  readonly failureReasons: readonly FailureReason[];
  readonly podTypes: readonly string[];
  readonly currency: { readonly code: string; readonly exponent: number; readonly symbol: string };
  readonly timezone: string;
  readonly locales: readonly string[];
  readonly weekendDays: readonly number[];
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  TND: "د.ت",
  USD: "$",
  EUR: "€",
  SAR: "﷼",
  AED: "د.إ",
  EGP: "ج.م",
  MAD: "د.م.",
};

const CURRENCY_EXPONENTS: Record<string, number> = {
  TND: 3,
  BHD: 3,
  KWD: 3,
  OMR: 3,
};

const DEFAULT_FAILURE_REASONS: readonly FailureReason[] = [
  {
    code: "CUSTOMER_UNAVAILABLE",
    labels: { ar: "العميل غير متوفر", fr: "Client absent", en: "Customer unavailable" },
    allowsReattempt: true,
  },
  {
    code: "INSUFFICIENT_CASH",
    labels: { ar: "نقص في السيولة", fr: "Fonds insuffisants", en: "Insufficient cash" },
    allowsReattempt: true,
  },
  {
    code: "CUSTOMER_REFUSED",
    labels: { ar: "رفض العميل", fr: "Refus du client", en: "Customer refused" },
    allowsReattempt: false,
  },
  {
    code: "WRONG_ADDRESS",
    labels: { ar: "عنوان خاطئ", fr: "Mauvaise adresse", en: "Wrong address" },
    allowsReattempt: true,
  },
  {
    code: "DAMAGED_PACKAGE",
    labels: { ar: "طرد تالف", fr: "Colis endommagé", en: "Damaged package" },
    allowsReattempt: false,
  },
  {
    code: "ACCESS_RESTRICTED",
    labels: { ar: "دخول ممنوع", fr: "Accès restreint", en: "Access restricted" },
    allowsReattempt: true,
  },
];

@Injectable()
export class ConfigBootstrapService {
  constructor(private readonly database: DatabaseService) {}

  async getBootstrap(): Promise<BootstrapConfig> {
    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();

      const tenantRows = await tx
        .select({
          defaultCurrency: tenants.defaultCurrency,
          defaultTimezone: tenants.defaultTimezone,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const tenant = tenantRows[0];
      const currencyCode = tenant?.defaultCurrency ?? "TND";
      const timezone = tenant?.defaultTimezone ?? "Africa/Tunis";

      const featureRows = await tx
        .select({
          featureKey: tenantFeatures.featureKey,
          enabled: tenantFeatures.enabled,
        })
        .from(tenantFeatures)
        .where(eq(tenantFeatures.tenantId, tenantId));

      const features: Record<string, boolean> = {};
      for (const key of FEATURE_KEYS) {
        features[key] = false;
      }
      for (const row of featureRows) {
        features[row.featureKey] = row.enabled;
      }

      const podTypes: string[] = ["SIGNATURE", "PHOTO", "OTP", "CONTACTLESS"];
      if (features["POD_PHOTO_REQUIRED"]) {
        const idx = podTypes.indexOf("CONTACTLESS");
        if (idx !== -1) podTypes.splice(idx, 1);
      }

      const exponent = CURRENCY_EXPONENTS[currencyCode] ?? 2;
      const symbol = CURRENCY_SYMBOLS[currencyCode] ?? currencyCode;

      return {
        features,
        failureReasons: DEFAULT_FAILURE_REASONS,
        podTypes,
        currency: { code: currencyCode, exponent, symbol },
        timezone,
        locales: ["ar", "fr", "en"],
        weekendDays: [6, 7],
      };
    });
  }
}
