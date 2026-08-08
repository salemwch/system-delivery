import Link from "next/link";

import { BillingSettingsForm } from "@/components/billing-settings-form";
import { PageHeader } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { fetchBillingSettings } from "@/lib/queries";

/**
 * TVA rate, timbre fiscal, payment terms and the fiscal identity printed on
 * every invoice.
 *
 * The API returns the tenant's own values, or the Tunisian defaults (19% and a
 * 1.000 TND timbre) for a tenant that has never opened this screen — so the form
 * always renders real numbers rather than blanks the operator has to guess at.
 */
const TENANT_CURRENCY = "TND";
const TENANT_CURRENCY_EXPONENT = 3;

export default async function BillingSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];

  const settings = await fetchBillingSettings();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Link href={`/${locale}/finance/invoices`} className="text-sm text-brand hover:underline">
          ← {messages.invoices}
        </Link>
      </div>

      <PageHeader title={messages.billingSettings} />

      <BillingSettingsForm
        locale={locale}
        vatRateBp={settings.vatRateBp}
        // Minor units → the decimal the operator types. A plain `Number()` here
        // would divide by 100 somewhere down the line; `formatMoney` reads the
        // exponent instead, and TND's is three.
        stampDuty={formatMoney(
          BigInt(settings.stampDutyMinor),
          TENANT_CURRENCY_EXPONENT,
          "en",
        )}
        paymentTermsDays={settings.paymentTermsDays}
        legalName={settings.legalName}
        taxIdentifier={settings.taxIdentifier}
        legalAddress={settings.legalAddress}
        currency={TENANT_CURRENCY}
        exponent={TENANT_CURRENCY_EXPONENT}
      />
    </div>
  );
}
