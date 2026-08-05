import Link from "next/link";

import { DataTable, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { timezone } from "@/lib/config";
import { fetchAudit } from "@/lib/queries";

export default async function AuditPage({
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

  const result = await fetchAudit(query.cursor);

  return (
    <div className="space-y-4">
      <PageHeader title={messages.audit} />

      <DataTable
        headers={[
          locale === "ar" ? "الإجراء" : locale === "fr" ? "Action" : "Action",
          locale === "ar" ? "النوع" : locale === "fr" ? "Entité" : "Entity",
          locale === "ar" ? "المستخدم" : locale === "fr" ? "Utilisateur" : "User",
          locale === "ar" ? "التاريخ" : locale === "fr" ? "Date" : "Date",
        ]}
      >
        {result.data.map((a) => (
          <tr key={a.id} className="hover:bg-slate-50">
            <td className="px-4 py-3 text-sm font-medium">{a.action}</td>
            <td className="px-4 py-3 text-sm">
              <span className="text-slate-600">{a.entityType}</span>
              <span className="ms-1 ltr-isolate font-mono text-xs text-slate-400">{a.entityId.slice(0, 8)}</span>
            </td>
            <td className="px-4 py-3 text-sm ltr-isolate">{a.userEmail}</td>
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(a.createdAt, locale, tz)}
            </td>
          </tr>
        ))}
      </DataTable>

      {result.cursor !== null ? (
        <div className="flex justify-center">
          <Link
            href={`/${locale}/audit?cursor=${encodeURIComponent(result.cursor)}`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            {locale === "ar" ? "المزيد" : locale === "fr" ? "Voir plus" : "Load more"}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
