import Link from "next/link";

import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { timezone } from "@/lib/config";
import { fetchManifests } from "@/lib/queries";

export default async function CustodyPage({
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

  const result = await fetchManifests(query.cursor);

  return (
    <div className="space-y-4">
      <PageHeader title={messages.custody} />

      <DataTable
        headers={[
          locale === "ar" ? "المانيفست" : locale === "fr" ? "Manifeste" : "Manifest",
          locale === "ar" ? "النوع" : locale === "fr" ? "Type" : "Type",
          messages.status,
          locale === "ar" ? "الطرود" : locale === "fr" ? "Colis" : "Shipments",
          locale === "ar" ? "التاريخ" : locale === "fr" ? "Date" : "Date",
        ]}
      >
        {result.data.map((m) => (
          <tr key={m.id} className="hover:bg-slate-50">
            <td className="px-4 py-3">
              <span className="ltr-isolate font-mono text-sm">{m.id.slice(0, 8)}</span>
            </td>
            <td className="px-4 py-3 text-sm">{m.type}</td>
            <td className="px-4 py-3">
              <StatusBadge status={m.status} locale={locale} />
            </td>
            <td className="px-4 py-3 text-sm tabular-nums">{m.shipmentCount}</td>
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(m.createdAt, locale, tz)}
            </td>
          </tr>
        ))}
      </DataTable>

      {result.cursor !== null ? (
        <div className="flex justify-center">
          <Link
            href={`/${locale}/custody?cursor=${encodeURIComponent(result.cursor)}`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            {locale === "ar" ? "المزيد" : locale === "fr" ? "Voir plus" : "Load more"}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
