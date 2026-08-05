import Link from "next/link";

import { DataTable, PageHeader } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { toLocale } from "@/lib/i18n";
import { apiFetch } from "@/lib/api";

interface CashInFieldEntry {
  readonly driverId: string;
  readonly driverName: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly shipmentCount: number;
}

interface CashInFieldResult {
  readonly data: readonly CashInFieldEntry[];
  readonly currency: string;
  readonly currencyExponent: number;
}

export default async function LedgerPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);

  const result = await apiFetch<CashInFieldResult>("/v1/finance/cash-in-field");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Link href={`/${locale}/finance`} className="text-sm text-brand hover:underline">
          {locale === "ar" ? "← المالية" : locale === "fr" ? "← Finance" : "← Finance"}
        </Link>
      </div>

      <PageHeader
        title={locale === "ar" ? "النقد في الميدان" : locale === "fr" ? "Espèces sur le terrain" : "Cash in field"}
      />

      <DataTable
        headers={[
          locale === "ar" ? "السائق" : locale === "fr" ? "Chauffeur" : "Driver",
          locale === "ar" ? "الطرود" : locale === "fr" ? "Colis" : "Shipments",
          locale === "ar" ? "المبلغ" : locale === "fr" ? "Montant" : "Amount",
        ]}
      >
        {result.data.map((entry) => (
          <tr key={entry.driverId} className="hover:bg-slate-50">
            <td className="px-4 py-3 text-sm font-medium">{entry.driverName}</td>
            <td className="px-4 py-3 text-sm tabular-nums">{entry.shipmentCount}</td>
            <td className="px-4 py-3 text-sm tabular-nums ltr-isolate">
              {formatMoney(entry.totalMinor, result.currencyExponent, locale)} {result.currency}
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
