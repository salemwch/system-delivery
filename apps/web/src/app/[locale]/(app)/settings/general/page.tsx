import Link from "next/link";
import { notFound } from "next/navigation";

import { TenantProfileForm } from "@/components/tenant-profile-form";
import { PageHeader } from "@/components/ui";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { fetchTenantProfile } from "@/lib/queries";
import { hasPermission, requireSession } from "@/lib/session";

/**
 * Général — the courier's own identity.
 *
 * ⚠️ The currency and country are SHOWN but not editable, and showing them is
 * the point: an operator looking for "where do I change the currency?" needs to
 * find the answer here rather than conclude the screen is incomplete. The
 * currency is stamped on every shipment, invoice and ledger entry ever written,
 * and changing it would reinterpret a year of amounts rather than convert them.
 */
export default async function GeneralSettingsPage({
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

  const profile = await fetchTenantProfile();

  return (
    <div className="space-y-6">
      <Link href={`/${locale}/settings`} className="text-sm text-brand hover:underline">
        ← {messages.settings}
      </Link>

      <PageHeader title={messages.generalSettings} />

      <TenantProfileForm locale={locale} profile={profile} />

      <section className="max-w-xl rounded-xl border border-slate-200 bg-slate-50 p-4">
        <h2 className="text-sm font-semibold text-slate-900">{messages.notEditable}</h2>
        <dl className="mt-2 space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">{messages.currency}</dt>
            <dd className="ltr-isolate font-mono">{profile.defaultCurrency}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">{messages.country}</dt>
            <dd className="ltr-isolate font-mono">{profile.countryCode}</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-slate-500">{messages.notEditableHint}</p>
      </section>
    </div>
  );
}
