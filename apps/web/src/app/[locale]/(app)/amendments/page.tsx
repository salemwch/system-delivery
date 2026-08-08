import Link from "next/link";
import { notFound } from "next/navigation";

import { AmendmentDecision } from "@/components/amendment-decision";
import { DataTable, PageHeader } from "@/components/ui";
import { timezone } from "@/lib/config";
import { amendmentLines } from "@/lib/amendment-lines";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { fetchAmendments } from "@/lib/queries";
import { hasPermission, requireSession } from "@/lib/session";

const TABS = ["PENDING", "APPLIED", "REJECTED"] as const;

/**
 * Modification Colis — the dispatcher's queue.
 *
 * Pending first and oldest-first, because a merchant waiting on a corrected
 * phone number is a parcel that cannot be delivered until someone answers. The
 * other tabs are the record of what was decided.
 *
 * Each row states the change as `field: old → new`, which is the only form a
 * dispatcher can decide from at a glance. `previous` is null until an amendment
 * is applied, so a pending row shows the requested value alone — there is
 * nothing to compare it to yet that the parcel page does not already show.
 */
export default async function AmendmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string; status?: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const tz = timezone();
  const query = await searchParams;

  const session = await requireSession(locale);
  if (!hasPermission(session, P.SHIPMENT_READ)) {
    notFound();
  }
  const canDecide = hasPermission(session, P.SHIPMENT_AMEND_APPROVE);

  const status = TABS.find((tab) => tab === query.status) ?? "PENDING";
  const result = await fetchAmendments(query.cursor, status);

  const base = `/${locale}/amendments`;

  return (
    <div className="space-y-4">
      <PageHeader title={messages.amendments} />

      <div className="flex gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab}
            href={tab === "PENDING" ? base : `${base}?status=${tab}`}
            aria-current={tab === status ? "page" : undefined}
            className={
              tab === status
                ? "rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-white"
                : "rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            }
          >
            {tabLabel(tab, messages)}
          </Link>
        ))}
      </div>

      <DataTable
        headers={[
          messages.shipments,
          messages.amendments,
          messages.reason,
          locale === "ar" ? "التاريخ" : locale === "fr" ? "Demandée le" : "Requested",
          status === "PENDING" ? "" : messages.status,
        ]}
      >
        {result.data.map((amendment) => (
          <tr key={amendment.id} className="align-top hover:bg-slate-50">
            <td className="px-4 py-3">
              <Link
                href={`/${locale}/shipments/${amendment.shipmentId}`}
                className="text-sm text-brand hover:underline"
              >
                {messages.shipments} →
              </Link>
            </td>
            <td className="px-4 py-3">
              <ul className="space-y-0.5">
                {amendmentLines(amendment).map((line) => (
                  <li key={line} className="ltr-isolate font-mono text-xs text-slate-700">
                    {line}
                  </li>
                ))}
              </ul>
            </td>
            <td className="px-4 py-3 max-w-xs text-sm text-slate-600">
              {amendment.reason ?? "—"}
            </td>
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(amendment.createdAt, locale, tz)}
            </td>
            <td className="px-4 py-3">
              {status === "PENDING" ? (
                canDecide ? <AmendmentDecision amendmentId={amendment.id} locale={locale} /> : null
              ) : (
                <div className="text-xs">
                  <span
                    className={
                      amendment.status === "APPLIED"
                        ? "font-medium text-emerald-800"
                        : "font-medium text-red-700"
                    }
                  >
                    {tabLabel(amendment.status, messages)}
                  </span>
                  {amendment.decisionReason === null ? null : (
                    <p className="mt-0.5 max-w-xs text-slate-500">{amendment.decisionReason}</p>
                  )}
                </div>
              )}
            </td>
          </tr>
        ))}
      </DataTable>

      {result.cursor === null ? null : (
        <div className="flex justify-center">
          <Link
            href={`${base}?status=${status}&cursor=${encodeURIComponent(result.cursor)}`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            {messages.loadMore}
          </Link>
        </div>
      )}
    </div>
  );
}

function tabLabel(tab: string, messages: (typeof MESSAGES)["fr"]): string {
  switch (tab) {
    case "APPLIED":
      return messages.applied;
    case "REJECTED":
      return messages.rejected;
    default:
      return messages.pending;
  }
}
