import Link from "next/link";
import { notFound } from "next/navigation";

import { DataTable, PageHeader } from "@/components/ui";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { hasPermission, requireSession } from "@/lib/session";
import { fetchMerchants } from "@/lib/queries";

/**
 * Bulk import — pick the merchant first.
 *
 * ⚠️ The merchant is chosen HERE, not in the file. A CSV with a merchant column
 * puts one of the most consequential fields in the system under a typo: a wrong
 * value files a hundred parcels under another company, and their COD settles to
 * that company's account. Picking once, deliberately, before any file is chosen
 * removes the possibility.
 *
 * A COMMERCIAL sees only their own portfolio here, because RLS narrows the
 * merchant list (invariant I25) — they cannot import into a rival's account
 * even by guessing an id.
 */
export default async function ImportIndexPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const query = await searchParams;

  const session = await requireSession(locale);
  if (!hasPermission(session, P.SHIPMENT_CREATE)) {
    notFound();
  }

  const result = await fetchMerchants(query.cursor);

  return (
    <div className="space-y-4">
      <PageHeader title={messages.importShipments} />

      <p className="text-sm text-slate-600">{messages.importPickMerchant}</p>

      <DataTable
        headers={[
          locale === "ar" ? "الاسم" : locale === "fr" ? "Nom" : "Name",
          messages.contact,
          messages.actions,
        ]}
      >
        {result.data.map((merchant) => (
          <tr key={merchant.id} className="hover:bg-slate-50">
            <td className="px-4 py-3 text-sm font-medium">
              <Link
                href={`/${locale}/merchants/${merchant.id}`}
                className="text-brand hover:underline"
              >
                {merchant.name}
              </Link>
            </td>
            <td className="px-4 py-3 text-sm">
              {merchant.contactName ?? "—"}
              <span className="ms-2 ltr-isolate text-slate-500">{merchant.contactPhone ?? ""}</span>
            </td>
            <td className="px-4 py-3">
              <Link
                href={`/${locale}/merchants/${merchant.id}/import`}
                className="inline-flex min-h-9 items-center rounded-lg border border-brand bg-white px-3 py-1.5 text-xs font-semibold text-brand transition hover:bg-brand-soft"
              >
                {messages.importShipments}
              </Link>
            </td>
          </tr>
        ))}
      </DataTable>

      {result.cursor !== null ? (
        <div className="flex justify-center">
          <Link
            href={`/${locale}/import?cursor=${encodeURIComponent(result.cursor)}`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            {locale === "ar" ? "المزيد" : locale === "fr" ? "Voir plus" : "Load more"}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
