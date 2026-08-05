import Link from "next/link";

import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { timezone } from "@/lib/config";
import { fetchRoutes } from "@/lib/queries";

export default async function DispatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const tz = timezone();
  const query = await searchParams;

  const result = await fetchRoutes(query.cursor);

  const headers = [
    locale === "ar" ? "المسار" : locale === "fr" ? "Route" : "Route",
    messages.status,
    locale === "ar" ? "السائق" : locale === "fr" ? "Chauffeur" : "Driver",
    locale === "ar" ? "التوقفات" : locale === "fr" ? "Arrêts" : "Stops",
    locale === "ar" ? "المسافة" : locale === "fr" ? "Distance" : "Distance",
    locale === "ar" ? "التاريخ" : locale === "fr" ? "Date" : "Date",
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={messages.dispatch} />

      <DataTable headers={headers}>
        {result.data.map((r) => (
          <tr key={r.id} className="hover:bg-slate-50">
            <td className="px-4 py-3">
              <Link
                href={`/${locale}/dispatch/${r.id}`}
                className="ltr-isolate font-mono text-sm text-brand hover:underline"
              >
                {r.id.slice(0, 8)}
              </Link>
            </td>
            <td className="px-4 py-3">
              <StatusBadge status={r.status} locale={locale} />
            </td>
            <td className="px-4 py-3 text-sm">{r.driverName ?? "—"}</td>
            <td className="px-4 py-3 text-sm tabular-nums">{r.stopCount}</td>
            <td className="px-4 py-3 text-sm tabular-nums ltr-isolate">
              {r.distanceMeters > 0 ? `${(r.distanceMeters / 1000).toFixed(1)} km` : "—"}
            </td>
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(r.createdAt, locale, tz)}
            </td>
          </tr>
        ))}
      </DataTable>

      {result.cursor !== null ? (
        <div className="flex justify-center">
          <Link
            href={`/${locale}/dispatch?cursor=${encodeURIComponent(result.cursor)}`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            {locale === "ar" ? "المزيد" : locale === "fr" ? "Voir plus" : "Load more"}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
