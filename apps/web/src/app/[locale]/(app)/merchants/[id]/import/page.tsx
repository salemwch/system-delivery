import Link from "next/link";
import { notFound } from "next/navigation";

import { ImportForm } from "@/components/import-form";
import { PageHeader } from "@/components/ui";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { hasPermission, requireSession } from "@/lib/session";
import { fetchMerchant, fetchMerchantStats } from "@/lib/queries";

/**
 * Bulk import, scoped to ONE merchant.
 *
 * Deliberately not a standalone "Import Colis" page: every shipment belongs to
 * a merchant, and a global importer would need a merchant column in the CSV —
 * one typo there files a hundred parcels under the wrong company, with COD
 * settling to the wrong account. Reaching it through the merchant fixes the
 * owner before the file is even chosen.
 */
export default async function ImportPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: raw, id } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const session = await requireSession(locale);

  if (!hasPermission(session, P.SHIPMENT_CREATE)) {
    notFound();
  }

  // The stats call is what carries the currency exponent — COD amounts in the
  // file are typed as "12,500" and must be scaled by the currency's own
  // exponent, never a hardcoded 100.
  const [merchant, stats] = await Promise.all([fetchMerchant(id), fetchMerchantStats(id)]);

  return (
    <div className="space-y-6">
      <Link href={`/${locale}/merchants/${id}`} className="text-sm text-brand hover:underline">
        ← {merchant.name}
      </Link>

      <PageHeader title={messages.importShipments} />

      <ImportForm
        merchantId={merchant.id}
        currencyExponent={stats.currencyExponent}
        locale={locale}
      />
    </div>
  );
}
