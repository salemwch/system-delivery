import Link from "next/link";

import { DataTable, PageHeader } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { toLocale } from "@/lib/i18n";
import { apiFetch } from "@/lib/api";

interface ReconciliationEntry {
  readonly driverId: string;
  readonly driverName: string;
  readonly expectedMinor: number;
  readonly remittedMinor: number;
  readonly differenceMinor: number;
  readonly currency: string;
}

interface ReconciliationResult {
  readonly data: readonly ReconciliationEntry[];
  readonly currency: string;
  readonly currencyExponent: number;
}

export default async function RemittancesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);

  const result = await apiFetch<ReconciliationResult>("/v1/finance/reconciliation");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Link href={`/${locale}/finance`} className="text-sm text-brand hover:underline">
          {locale === "ar" ? "← المالية" : locale === "fr" ? "← Finance" : "← Finance"}
        </Link>
      </div>

      <PageHeader
        title={locale === "ar" ? "المطابقة" : locale === "fr" ? "Rapprochement" : "Reconciliation"}
      />

      <DataTable
        headers={[
          locale === "ar" ? "السائق" : locale === "fr" ? "Chauffeur" : "Driver",
          locale === "ar" ? "المتوقع" : locale === "fr" ? "Attendu" : "Expected",
          locale === "ar" ? "المُسلّم" : locale === "fr" ? "Remis" : "Remitted",
          locale === "ar" ? "الفرق" : locale === "fr" ? "Écart" : "Difference",
        ]}
      >
        {result.data.map((entry) => (
          <tr key={entry.driverId} className="hover:bg-slate-50">
            <td className="px-4 py-3 text-sm font-medium">{entry.driverName}</td>
            <td className="px-4 py-3 text-sm tabular-nums ltr-isolate">
              {formatMoney(entry.expectedMinor, result.currencyExponent, locale)}
            </td>
            <td className="px-4 py-3 text-sm tabular-nums ltr-isolate">
              {formatMoney(entry.remittedMinor, result.currencyExponent, locale)}
            </td>
            <td className={`px-4 py-3 text-sm tabular-nums ltr-isolate font-medium ${entry.differenceMinor !== 0 ? "text-red-700" : "text-emerald-700"}`}>
              {formatMoney(entry.differenceMinor, result.currencyExponent, locale)}
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
