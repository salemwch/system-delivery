import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { timezone } from "@/lib/config";
import { fetchComplaints } from "@/lib/queries";

export default async function ComplaintsPage({
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

  const result = await fetchComplaints(query.cursor);

  return (
    <div className="space-y-4">
      <PageHeader title={messages.complaints} />

      <DataTable
        headers={[
          locale === "ar" ? "رقم التتبع" : locale === "fr" ? "N° suivi" : "Tracking #",
          locale === "ar" ? "النوع" : locale === "fr" ? "Type" : "Type",
          messages.status,
          locale === "ar" ? "الأولوية" : locale === "fr" ? "Priorité" : "Priority",
          locale === "ar" ? "التاريخ" : locale === "fr" ? "Date" : "Date",
        ]}
      >
        {result.data.map((c) => (
          <tr key={c.id} className="hover:bg-slate-50">
            <td className="px-4 py-3">
              <span className="ltr-isolate font-mono text-sm">{c.code}</span>
            </td>
            <td className="px-4 py-3 text-sm">{c.type}</td>
            <td className="px-4 py-3">
              <StatusBadge status={c.status} locale={locale} />
            </td>
            <td className="px-4 py-3 text-sm">{c.severity}</td>
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(c.createdAt, locale, tz)}
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
