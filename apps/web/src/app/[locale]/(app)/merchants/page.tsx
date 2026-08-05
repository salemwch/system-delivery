import Link from "next/link";

import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { timezone } from "@/lib/config";
import { P } from "@/lib/permissions";
import { hasPermission, requireSession } from "@/lib/session";
import { fetchMerchants } from "@/lib/queries";

/**
 * The merchant list.
 *
 * A COMMERCIAL sees only the accounts they manage — narrowed by RLS on the API
 * side, not by a filter here, so this page needs no notion of a portfolio at
 * all (invariant I25).
 */
export default async function MerchantsPage({
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

  const [session, result] = await Promise.all([
    requireSession(locale),
    fetchMerchants(query.cursor),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={messages.merchants}>
        {hasPermission(session, P.MERCHANT_CREATE) ? (
          <Link
            href={`/${locale}/merchants/new`}
            className="inline-flex min-h-11 items-center rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark"
          >
            {messages.newMerchant}
          </Link>
        ) : null}
      </PageHeader>

      <DataTable
        headers={[
          locale === "ar" ? "الاسم" : locale === "fr" ? "Nom" : "Name",
          locale === "ar" ? "جهة الاتصال" : locale === "fr" ? "Contact" : "Contact",
          locale === "ar" ? "الهاتف" : locale === "fr" ? "Téléphone" : "Phone",
          messages.status,
          locale === "ar" ? "التاريخ" : locale === "fr" ? "Date" : "Date",
        ]}
      >
        {result.data.map((m) => (
          <tr key={m.id} className="hover:bg-slate-50">
            <td className="px-4 py-3 text-sm font-medium">
              <Link href={`/${locale}/merchants/${m.id}`} className="text-brand hover:underline">
                {m.name}
              </Link>
            </td>
            <td className="px-4 py-3 text-sm">{m.contactName ?? "—"}</td>
            <td className="px-4 py-3 text-sm ltr-isolate">{m.contactPhone ?? "—"}</td>
            <td className="px-4 py-3">
              <StatusBadge status={m.status} locale={locale} />
            </td>
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(m.createdAt, locale, tz)}
            </td>
          </tr>
        ))}
      </DataTable>

      {result.cursor !== null ? (
        <div className="flex justify-center">
          <Link
            href={`/${locale}/merchants?cursor=${encodeURIComponent(result.cursor)}`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            {locale === "ar" ? "المزيد" : locale === "fr" ? "Voir plus" : "Load more"}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
