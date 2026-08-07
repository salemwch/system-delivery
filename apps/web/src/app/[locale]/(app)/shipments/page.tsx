import Link from "next/link";

import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { formatDateTime, formatMoney } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { timezone } from "@/lib/config";
import { hasPermission, readSession } from "@/lib/session";
import { P } from "@/lib/permissions";
import { fetchShipments } from "@/lib/queries";

export default async function ShipmentsPage({
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
  const session = await readSession();
  const canReadCod = session !== null && hasPermission(session, P.COD_READ_AMOUNT);
  const query = await searchParams;

  const result = await fetchShipments(query.cursor);

  const headers = [
    locale === "ar" ? "رقم التتبع" : locale === "fr" ? "N° suivi" : "Tracking #",
    messages.status,
    locale === "ar" ? "المستلم" : locale === "fr" ? "Destinataire" : "Recipient",
    locale === "ar" ? "الهاتف" : locale === "fr" ? "Téléphone" : "Phone",
    ...(canReadCod
      ? [locale === "ar" ? "المبلغ COD" : locale === "fr" ? "Montant COD" : "COD amount"]
      : []),
    locale === "ar" ? "التاريخ" : locale === "fr" ? "Date" : "Date",
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={messages.shipments} />

      <DataTable headers={headers}>
        {result.data.map((s) => (
          <tr key={s.id} className="hover:bg-slate-50">
            <td className="px-4 py-3">
              <Link
                href={`/${locale}/shipments/${s.id}`}
                className="ltr-isolate font-mono text-sm text-brand hover:underline"
              >
                {s.trackingNumber}
              </Link>
            </td>
            <td className="px-4 py-3">
              <StatusBadge status={s.status} locale={locale} />
            </td>
            <td className="px-4 py-3 text-sm">{s.recipientName}</td>
            <td className="px-4 py-3 text-sm">{s.recipientPhone}</td>
            {canReadCod ? (
              <td className="px-4 py-3 text-sm tabular-nums ltr-isolate">
                {/* String minor units, and the exponent comes from the API —
                    TND is 3 decimals and a hardcoded scale misprices it. */}
                {BigInt(s.codAmountMinor) > 0n
                  ? formatMoney(BigInt(s.codAmountMinor), s.currencyExponent, locale)
                  : "—"}
              </td>
            ) : null}
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(s.createdAt, locale, tz)}
            </td>
          </tr>
        ))}
      </DataTable>

      {result.cursor !== null ? (
        <div className="flex justify-center">
          <Link
            href={`/${locale}/shipments?cursor=${encodeURIComponent(result.cursor)}`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            {locale === "ar" ? "المزيد" : locale === "fr" ? "Voir plus" : "Load more"}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
