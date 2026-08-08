import Link from "next/link";
import { notFound } from "next/navigation";

import { OpenTicketForm } from "@/components/open-ticket-form";
import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { fetchMerchants, fetchTickets } from "@/lib/queries";
import { hasPermission, requireSession } from "@/lib/session";

const TABS = ["OPEN", "PENDING_MERCHANT", "CLOSED"] as const;

/**
 * Support — the back office's queue.
 *
 * ⚠️ OPEN and PENDING_MERCHANT are separate tabs on purpose. A ticket waiting on
 * the merchant is not the courier's backlog, and folding them together makes the
 * queue permanently red through nobody's fault — which is how a team learns to
 * ignore it.
 */
export default async function SupportPage({
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
  if (!hasPermission(session, P.SUPPORT_READ)) {
    notFound();
  }

  const canOpen = hasPermission(session, P.SUPPORT_WRITE);

  const status = TABS.find((tab) => tab === query.status) ?? "OPEN";
  // The merchant list is only needed for the open-a-ticket form, so only a
  // caller who can open one pays for it.
  const [result, merchants] = await Promise.all([
    fetchTickets(query.cursor, { status }),
    canOpen ? fetchMerchants(null, 200) : Promise.resolve({ data: [], cursor: null }),
  ]);

  const base = `/${locale}/support`;

  return (
    <div className="space-y-4">
      <PageHeader title={messages.support} />

      <div className="flex gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab}
            href={tab === "OPEN" ? base : `${base}?status=${tab}`}
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

      {canOpen ? (
        <OpenTicketForm
          locale={locale}
          merchants={merchants.data.map((merchant) => ({
            id: merchant.id,
            name: merchant.name,
          }))}
        />
      ) : null}

      <DataTable
        headers={[
          messages.reference,
          messages.subject,
          messages.category,
          messages.status,
          locale === "ar" ? "آخر رسالة" : locale === "fr" ? "Dernier message" : "Last message",
        ]}
      >
        {result.data.map((ticket) => (
          <tr key={ticket.id} className="hover:bg-slate-50">
            <td className="px-4 py-3">
              <Link
                href={`${base}/${ticket.id}`}
                className="ltr-isolate font-mono text-sm text-brand hover:underline"
              >
                {ticket.reference}
              </Link>
            </td>
            <td className="px-4 py-3 text-sm font-medium text-slate-900">{ticket.subject}</td>
            <td className="px-4 py-3 text-xs text-slate-500">{ticket.category}</td>
            <td className="px-4 py-3">
              <StatusBadge status={ticket.status} locale={locale} />
            </td>
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(ticket.lastMessageAt, locale, tz)}
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
    case "PENDING_MERCHANT":
      return messages.awaitingMerchant;
    case "CLOSED":
      return messages.closed;
    default:
      return messages.openRemarks;
  }
}
