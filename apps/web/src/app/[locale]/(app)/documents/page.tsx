import Link from "next/link";
import { notFound } from "next/navigation";

import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import { timezone } from "@/lib/config";
import { P } from "@/lib/permissions";
import { hasPermission, requireSession } from "@/lib/session";
import { fetchShipments } from "@/lib/queries";

/**
 * The print queue.
 *
 * A docket belongs to a shipment, so this is not a separate archive — it is the
 * shipment list narrowed to the parcels a given docket is FOR, with the print
 * link on each row. Someone working through a stack prints from here rather
 * than opening each shipment in turn.
 *
 * ⚠️ Filtered CLIENT-side over one page, not by a status query.
 * `GET /v1/shipments` accepts a single `status`, and a delivery note is
 * meaningful for several (created, picked up, in transit, out for delivery).
 * Asking for each in turn would be four round trips per view. One page of 100,
 * narrowed here, is honest about what it shows: the most recent hundred. A
 * real print run over a date range needs a `status IN (…)` filter on the API,
 * which does not exist yet.
 */

/** Which statuses each docket is meaningful for. */
const RELEVANT: Readonly<Record<DocumentKind, ReadonlySet<string>>> = {
  "delivery-note": new Set([
    "CREATED",
    "PICKUP_ASSIGNED",
    "PICKED_UP",
    "AT_HUB",
    "IN_TRANSIT",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
  ]),
  // The consignment note travels with the parcel from the merchant, so it is
  // wanted before anyone has collected it.
  "consignment-note": new Set(["CREATED", "PICKUP_ASSIGNED", "PICKED_UP"]),
  "return-note": new Set(["RETURN_PENDING", "RETURNED"]),
};

type DocumentKind = "delivery-note" | "consignment-note" | "return-note";

function isDocumentKind(value: string): value is DocumentKind {
  return value === "delivery-note" || value === "consignment-note" || value === "return-note";
}

export default async function DocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ kind?: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const tz = timezone();
  const query = await searchParams;

  const session = await requireSession(locale);
  if (!hasPermission(session, P.SHIPMENT_LABEL)) {
    notFound();
  }

  const kind: DocumentKind =
    query.kind !== undefined && isDocumentKind(query.kind) ? query.kind : "delivery-note";

  const result = await fetchShipments(null, 100);
  const rows = result.data.filter((shipment) => RELEVANT[kind].has(shipment.status));

  const tabs: readonly { readonly kind: DocumentKind; readonly label: string }[] = [
    { kind: "delivery-note", label: messages.deliveryNote },
    { kind: "consignment-note", label: messages.consignmentNote },
    { kind: "return-note", label: messages.returnNote },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={messages.documents} />

      <nav className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab.kind}
            href={`/${locale}/documents?kind=${tab.kind}`}
            aria-current={tab.kind === kind ? "page" : undefined}
            className={
              tab.kind === kind
                ? "rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white"
                : "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            }
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{messages.noResults}</p>
      ) : (
        <DataTable
          headers={[
            messages.reference,
            locale === "ar" ? "المستلم" : locale === "fr" ? "Destinataire" : "Recipient",
            messages.status,
            locale === "ar" ? "التاريخ" : locale === "fr" ? "Date" : "Created",
            messages.actions,
          ]}
        >
          {rows.map((shipment) => (
            <tr key={shipment.id} className="hover:bg-slate-50">
              <td className="px-4 py-3">
                <Link
                  href={`/${locale}/shipments/${shipment.id}`}
                  className="ltr-isolate font-mono text-sm text-brand hover:underline"
                >
                  {shipment.trackingNumber}
                </Link>
              </td>
              <td className="px-4 py-3 text-sm">{shipment.recipientName}</td>
              <td className="px-4 py-3">
                <StatusBadge status={shipment.status} locale={locale} />
              </td>
              <td className="px-4 py-3 text-sm text-slate-500">
                {formatDateTime(shipment.createdAt, locale, tz)}
              </td>
              <td className="px-4 py-3">
                <PrintLink locale={locale} id={shipment.id} kind={kind} label={messages.print} />
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}

function PrintLink({
  locale,
  id,
  kind,
  label,
}: {
  locale: Locale;
  id: string;
  kind: DocumentKind;
  label: string;
}) {
  return (
    <a
      href={`/${locale}/documents/${id}/${kind}`}
      target="_blank"
      rel="noopener"
      className="inline-flex min-h-9 items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:bg-slate-50"
    >
      {label}
    </a>
  );
}
