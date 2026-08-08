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
 * Every section here is backed by something real. A settings screen that lists
 * a heading with nothing behind it teaches an operator that the menu lies.
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
      href: `/${locale}/settings/general`,
      title: messages.generalSettings,
      hint:
        locale === "ar"
          ? "اسم الشركة والمنطقة الزمنية واللغات"
          : locale === "fr"
            ? "Nom, fuseau horaire et langues"
            : "Name, timezone and languages",
    },
    {
      href: `/${locale}/settings/options`,
      title: messages.optionsSettings,
      hint:
        locale === "ar"
          ? "تفعيل أو إيقاف الميزات"
          : locale === "fr"
            ? "Activer ou désactiver les fonctionnalités"
            : "Turn features on or off",
    },
    {
      href: `/${locale}/settings/email`,
      title: messages.emailSettings,
      hint:
        locale === "ar"
          ? "إرسال الوثائق للتجار"
          : locale === "fr"
            ? "Envoi des documents aux expéditeurs"
            : "Sending documents to merchants",
    },
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
    {
      href: `/${locale}/settings/cities`,
      title: messages.cities,
      hint:
        locale === "ar"
          ? "المدن المغطاة وتعريفة كل واحدة"
          : locale === "fr"
            ? "Les villes desservies et leur tarif"
            : "Cities you serve and what each costs",
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
