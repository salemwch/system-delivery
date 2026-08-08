import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { hasPermission, requireSession } from "@/lib/session";

/**
 * Tenant configuration.
 *
 * Gated on `feature:manage` — OWNER only — because everything reachable from
 * here changes behaviour for the whole company: the copy every customer reads,
 * and the territories dispatch routes against.
 *
 * Two sections, not the six a mature product carries. Cities, general options
 * and email are not modelled yet; an empty page promising them would be worse
 * than their absence.
 */
export default async function SettingsPage({
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

  const sections = [
    {
      href: `/${locale}/settings/templates`,
      title: messages.smsTemplates,
      hint:
        locale === "ar"
          ? "نص الرسائل التي يقرأها العملاء"
          : locale === "fr"
            ? "Le texte des messages que vos clients reçoivent"
            : "The message text your customers receive",
    },
    {
      href: `/${locale}/settings/zones`,
      title: messages.zones,
      hint:
        locale === "ar"
          ? "المناطق الجغرافية للتوزيع"
          : locale === "fr"
            ? "Les territoires de livraison"
            : "Delivery territories",
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={messages.settings} />

      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-brand"
          >
            <p className="font-semibold text-slate-900">{section.title}</p>
            <p className="mt-1 text-sm text-slate-500">{section.hint}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
