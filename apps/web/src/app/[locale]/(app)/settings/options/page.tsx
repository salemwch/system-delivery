import Link from "next/link";
import { notFound } from "next/navigation";

import { FeatureToggle } from "@/components/feature-toggle";
import { PageHeader } from "@/components/ui";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { fetchFeatures } from "@/lib/queries";
import { hasPermission, requireSession } from "@/lib/session";

/**
 * Options — the per-tenant feature flags.
 *
 * ⚠️ These are not preferences. Flags are how per-tenant behaviour is expressed
 * AT ALL (invariant I17): nothing in this codebase branches on a literal tenant
 * id, so turning COD off for one courier IS this switch. Each row therefore
 * carries what it actually does, not just its name — a screen of fourteen
 * SCREAMING_SNAKE keys is a screen nobody dares touch.
 */
export default async function OptionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];

  const session = await requireSession(locale);
  if (!hasPermission(session, P.FEATURE_MANAGE)) {
    notFound();
  }

  const features = await fetchFeatures();

  return (
    <div className="space-y-6">
      <Link href={`/${locale}/settings`} className="text-sm text-brand hover:underline">
        ← {messages.settings}
      </Link>

      <PageHeader title={messages.optionsSettings} />

      <ul className="max-w-2xl divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
        {features.map((feature) => (
          <li key={feature.key} className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="text-sm font-medium text-slate-900">
                {featureLabel(feature.key, locale)}
              </p>
              <p className="ltr-isolate font-mono text-xs text-slate-400">{feature.key}</p>
            </div>
            <FeatureToggle featureKey={feature.key} enabled={feature.enabled} locale={locale} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What a flag actually does, in the operator's language.
 *
 * A key with no entry falls back to itself rather than to an empty string: a new
 * flag added to the API must still be operable before someone writes its copy.
 */
function featureLabel(key: string, locale: "ar" | "fr" | "en"): string {
  const labels: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    COD_ENABLED: {
      ar: "الدفع عند الاستلام",
      fr: "Contre-remboursement",
      en: "Cash on delivery",
    },
    MULTI_HUB_ENABLED: { ar: "مراكز متعددة", fr: "Plusieurs hubs", en: "Multiple hubs" },
    LINEHAUL_ENABLED: {
      ar: "النقل بين المراكز",
      fr: "Transport inter-hubs",
      en: "Inter-hub linehaul",
    },
    ROUTE_OPTIMIZATION_ENABLED: {
      ar: "تحسين الجولات",
      fr: "Optimisation des tournées",
      en: "Route optimisation",
    },
    SMS_ENABLED: { ar: "رسائل قصيرة", fr: "SMS clients", en: "Customer SMS" },
    PUSH_ENABLED: { ar: "إشعارات السائقين", fr: "Notifications livreurs", en: "Driver push" },
    TRACKING_PAGE_ENABLED: { ar: "صفحة التتبع", fr: "Page de suivi", en: "Tracking page" },
    BULK_IMPORT_ENABLED: { ar: "استيراد جماعي", fr: "Import en masse", en: "Bulk import" },
    RETURN_MANAGEMENT_ENABLED: { ar: "إدارة الإرجاع", fr: "Gestion des retours", en: "Returns" },
    GEOFENCE_ARRIVAL_ENABLED: {
      ar: "كشف الوصول",
      fr: "Détection d’arrivée",
      en: "Arrival detection",
    },
    FRAUD_RULES_ENABLED: { ar: "قواعد الاحتيال", fr: "Règles anti-fraude", en: "Fraud rules" },
    POD_PHOTO_REQUIRED: { ar: "صورة إجبارية", fr: "Photo obligatoire", en: "Photo required" },
    POD_SIGNATURE_REQUIRED: { ar: "إمضاء إجباري", fr: "Signature obligatoire", en: "Signature required" },
    POD_OTP_REQUIRED: { ar: "رمز إجباري", fr: "Code obligatoire", en: "OTP required" },
  };
  return labels[key]?.[locale] ?? key;
}
