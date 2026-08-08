import Link from "next/link";
import { notFound } from "next/navigation";

import { SupportThread } from "@/components/support-thread";
import { TicketCommands } from "@/components/ticket-commands";
import { PageHeader, StatusBadge } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { fetchTicket } from "@/lib/queries";
import { hasPermission, requireSession } from "@/lib/session";

/**
 * One ticket and its thread.
 *
 * The staff view. Every message the API returned is rendered, including the
 * internal ones — which is safe precisely because a merchant login never
 * RECEIVES an internal message: RLS removes the row before this page sees it,
 * so there is nothing here to filter and nothing to forget.
 */
export default async function TicketPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: raw, id } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const tz = timezone();

  const session = await requireSession(locale);
  if (!hasPermission(session, P.SUPPORT_READ)) {
    notFound();
  }
  const canReply = hasPermission(session, P.SUPPORT_WRITE);
  const canManage = hasPermission(session, P.SUPPORT_MANAGE);

  const ticket = await fetchTicket(id);

  return (
    <div className="space-y-6">
      <Link href={`/${locale}/support`} className="text-sm text-brand hover:underline">
        ← {messages.support}
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <PageHeader title={ticket.subject} />
        <StatusBadge status={ticket.status} locale={locale} />
        <span className="ltr-isolate font-mono text-sm text-slate-500">{ticket.reference}</span>
      </div>

      <div className="flex flex-wrap gap-4 text-sm text-slate-600">
        <span>{ticket.category}</span>
        <Link href={`/${locale}/merchants/${ticket.merchantId}`} className="text-brand hover:underline">
          {messages.merchants} →
        </Link>
        {ticket.shipmentId === null ? null : (
          <Link
            href={`/${locale}/shipments/${ticket.shipmentId}`}
            className="text-brand hover:underline"
          >
            {messages.shipments} →
          </Link>
        )}
      </div>

      {canManage ? <TicketCommands ticketId={ticket.id} status={ticket.status} locale={locale} /> : null}

      <SupportThread
        locale={locale}
        ticketId={ticket.id}
        canReply={canReply}
        // Only staff may write one, and only staff can see one — the API refuses
        // it from a merchant caller regardless of what this renders.
        canWriteInternal={canManage}
        closed={ticket.status === "CLOSED"}
        messages={ticket.messages.map((message) => ({
          id: message.id,
          body: message.body,
          visibility: message.visibility,
          authorSide: message.authorSide,
          at: formatDateTime(message.createdAt, locale, tz),
        }))}
      />
    </div>
  );
}
