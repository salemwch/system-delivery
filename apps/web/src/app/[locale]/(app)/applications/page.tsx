import Link from "next/link";
import { notFound } from "next/navigation";

import { ApplicationDecision } from "@/components/application-decision";
import { LeadForm } from "@/components/lead-form";
import { DataTable, PageHeader } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { fetchApplications } from "@/lib/queries";
import { hasPermission, requireSession } from "@/lib/session";

const TABS = ["PENDING", "APPROVED", "REJECTED"] as const;

/**
 * Nouveaux clients — shippers asking to be taken on.
 *
 * The pending tab is a WORK LIST: oldest first, because the one waiting longest
 * is the one to answer, and every row carries the two buttons that clear it.
 * The other two tabs are history — what was decided, by whom, and on what
 * grounds.
 *
 * An application is not a merchant and never appears in the merchant surface.
 * Approving one creates the merchant; the link in the last column is how you
 * get from the decision to what it produced.
 */
export default async function ApplicationsPage({
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
  if (!hasPermission(session, P.MERCHANT_READ)) {
    notFound();
  }
  const canDecide = hasPermission(session, P.MERCHANT_DECIDE_APPLICATION);
  const canLog = hasPermission(session, P.MERCHANT_CREATE);

  const status = TABS.find((tab) => tab === query.status) ?? "PENDING";
  const result = await fetchApplications(query.cursor, status);

  const base = `/${locale}/applications`;

  return (
    <div className="space-y-4">
      <PageHeader title={messages.applications} />

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

      {canLog ? <LeadForm locale={locale} /> : null}

      <DataTable
        headers={[
          messages.merchants,
          messages.contact,
          messages.city,
          messages.expectedVolume,
          messages.source,
          locale === "ar" ? "التاريخ" : locale === "fr" ? "Reçue le" : "Received",
          status === "PENDING" ? "" : messages.status,
        ]}
      >
        {result.data.map((application) => (
          <tr key={application.id} className="align-top hover:bg-slate-50">
            <td className="px-4 py-3">
              <p className="text-sm font-medium text-slate-900">{application.businessName}</p>
              {application.message === null ? null : (
                <p className="mt-1 max-w-xs text-xs text-slate-500">{application.message}</p>
              )}
            </td>
            <td className="px-4 py-3 text-sm">
              <p className="text-slate-800">{application.contactName}</p>
              <p className="ltr-isolate font-mono text-xs text-slate-500">
                {application.contactPhone}
              </p>
              {application.contactEmail === null ? null : (
                <p className="ltr-isolate text-xs text-slate-500">{application.contactEmail}</p>
              )}
            </td>
            <td className="px-4 py-3 text-sm text-slate-600">{application.city ?? "—"}</td>
            <td className="px-4 py-3 text-end text-sm tabular-nums ltr-isolate text-slate-600">
              {application.expectedVolume ?? "—"}
            </td>
            <td className="px-4 py-3 text-xs text-slate-500">
              {application.source === "STAFF" ? messages.sourceStaff : messages.sourcePublic}
            </td>
            <td className="px-4 py-3 text-sm text-slate-500">
              {formatDateTime(application.createdAt, locale, tz)}
            </td>
            <td className="px-4 py-3">
              {status === "PENDING" ? (
                canDecide ? (
                  <ApplicationDecision
                    applicationId={application.id}
                    suggestedName={application.businessName}
                    locale={locale}
                  />
                ) : null
              ) : (
                <Outcome
                  status={application.status}
                  reason={application.decisionReason}
                  merchantHref={
                    application.merchantId === null
                      ? null
                      : `/${locale}/merchants/${application.merchantId}`
                  }
                  messages={messages}
                />
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
    case "APPROVED":
      return messages.approved;
    case "REJECTED":
      return messages.rejected;
    default:
      return messages.pending;
  }
}

/** What the decision was, and — for an approval — what it produced. */
function Outcome({
  status,
  reason,
  merchantHref,
  messages,
}: {
  status: string;
  reason: string | null;
  merchantHref: string | null;
  messages: (typeof MESSAGES)["fr"];
}) {
  if (status === "APPROVED") {
    return merchantHref === null ? (
      <span className="text-xs text-slate-500">{messages.approved}</span>
    ) : (
      <Link href={merchantHref} className="text-xs font-medium text-brand hover:underline">
        {messages.approved} →
      </Link>
    );
  }
  return (
    <div className="text-xs">
      <span className="font-medium text-red-700">{messages.rejected}</span>
      {reason === null ? null : <p className="mt-0.5 max-w-xs text-slate-500">{reason}</p>}
    </div>
  );
}
