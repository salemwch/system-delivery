import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { timezone } from "@/lib/config";
import { fetchPickups } from "@/lib/queries";

export default async function PickupsPage({
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

  const result = await fetchPickups(query.cursor);

  return (
    <div className="space-y-4">
      <PageHeader title={messages.pickups} />

      <DataTable
        headers={[
          locale === "ar" ? "التاجر" : locale === "fr" ? "Commerçant" : "Merchant",
          messages.status,
          locale === "ar" ? "الطرود" : locale === "fr" ? "Colis" : "Parcels",
          locale === "ar" ? "الموعد" : locale === "fr" ? "Prévu" : "Scheduled",
          locale === "ar" ? "التاريخ" : locale === "fr" ? "Date" : "Created",
        ]}
      >
        {result.data.map((p) => (
          <tr key={p.id} className="hover:bg-slate-50">
            <td className="px-4 py-3 text-sm font-medium">{p.merchantName}</td>
            <td className="px-4 py-3">
              <StatusBadge status={p.status} locale={locale} />
            </td>
            <td className="px-4 py-3 text-sm tabular-nums">{p.parcelCount}</td>
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(p.scheduledAt, locale, tz)}
            </td>
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(p.createdAt, locale, tz)}
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
