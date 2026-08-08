import Link from "next/link";

import { StatusBadge } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatDateTime, formatMoney } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import { hasPermission, readSession } from "@/lib/session";
import { P } from "@/lib/permissions";
import { AmendmentPanel } from "@/components/amendment-panel";
import { NotePanel } from "@/components/note-panel";
import { amendmentLines } from "@/lib/amendment-lines";
import {
  fetchAmendmentsFor,
  fetchNotesFor,
  fetchShipment,
  fetchShipmentEvents,
} from "@/lib/queries";

export default async function ShipmentDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: raw, id } = await params;
  const locale = toLocale(raw);
  const tz = timezone();
  const session = await readSession();
  const messages = MESSAGES[locale];
  const canReadCod = session !== null && hasPermission(session, P.COD_READ_AMOUNT);
  const canPrint = session !== null && hasPermission(session, P.SHIPMENT_LABEL);
  const canReadNotes = session !== null && hasPermission(session, P.NOTE_READ);
  const canWriteNotes = session !== null && hasPermission(session, P.NOTE_MANAGE);

  // Three calls, in parallel: the detail response never embedded its events,
  // and remarks are a separate context entirely. Sequential awaits here would
  // add a round trip to every parcel a dispatcher opens.
  const canAmend = session !== null && hasPermission(session, P.SHIPMENT_UPDATE);
  const amendApplies = session !== null && hasPermission(session, P.SHIPMENT_AMEND_APPROVE);

  const [shipment, events, notes, amendments] = await Promise.all([
    fetchShipment(id),
    fetchShipmentEvents(id),
    canReadNotes ? fetchNotesFor("SHIPMENT", id) : Promise.resolve([]),
    fetchAmendmentsFor(id),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link
          href={`/${locale}/shipments`}
          className="text-sm text-brand hover:underline"
        >
          {locale === "ar" ? "← الطرود" : locale === "fr" ? "← Expéditions" : "← Shipments"}
        </Link>
      </div>

      <div className="flex items-center gap-4">
        <h1 className="font-mono text-xl font-bold ltr-isolate">{shipment.trackingNumber}</h1>
        <StatusBadge status={shipment.status} locale={locale} />
      </div>

      {/*
        The printable dockets. `target="_blank"` because they open as a
        standalone A4 page the operator prints with Ctrl-P — navigating away
        from the shipment to print it and back again is the wrong flow for
        someone working through a stack of parcels.

        The return note is offered only once a return exists; on an ordinary
        delivery it would print an empty reason and confuse the driver.
      */}
      {canPrint ? (
        <div className="flex flex-wrap gap-2">
          <DocumentLink locale={locale} id={shipment.id} type="delivery-note" label={messages.deliveryNote} />
          <DocumentLink locale={locale} id={shipment.id} type="consignment-note" label={messages.consignmentNote} />
          {RETURN_STATUSES.has(shipment.status) ? (
            <DocumentLink locale={locale} id={shipment.id} type="return-note" label={messages.returnNote} />
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={locale === "ar" ? "المستلم" : locale === "fr" ? "Destinataire" : "Recipient"}>
          <InfoRow label={locale === "ar" ? "الاسم" : locale === "fr" ? "Nom" : "Name"} value={shipment.recipientName} />
          <InfoRow label={locale === "ar" ? "الهاتف" : locale === "fr" ? "Téléphone" : "Phone"} value={shipment.recipientPhone} ltr />
          <InfoRow label={locale === "ar" ? "العنوان" : locale === "fr" ? "Adresse" : "Address"} value={shipment.destination.rawInput} />
        </Section>

        <Section title={locale === "ar" ? "التفاصيل" : locale === "fr" ? "Détails" : "Details"}>
          <InfoRow label={locale === "ar" ? "التاجر" : locale === "fr" ? "Commerçant" : "Merchant"} value={shipment.merchantId ?? "—"} />
          <InfoRow label={locale === "ar" ? "الطرود" : locale === "fr" ? "Colis" : "Parcels"} value={String(shipment.parcelCount)} />
          {canReadCod && BigInt(shipment.codAmountMinor) > 0n ? (
            <InfoRow
              label="COD"
              value={`${formatMoney(BigInt(shipment.codAmountMinor), shipment.currencyExponent, locale)} ${shipment.currency}`}
              ltr
            />
          ) : null}
        </Section>
      </div>

      <Section title={locale === "ar" ? "السجل" : locale === "fr" ? "Historique" : "Timeline"}>
        <ol className="space-y-3 border-s-2 border-slate-200 ps-4">
          {events.map((event) => (
            <li key={event.id} className="relative">
              <span className="absolute -start-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand" />
              <div className="flex items-baseline gap-2">
                <StatusBadge status={event.eventType} locale={locale} />
                <span className="text-xs text-slate-500">
                  {formatDateTime(event.occurredAt, locale, tz)}
                </span>
              </div>
              {event.reasonCode !== null ? (
                <p className="mt-1 text-sm text-slate-600">{event.reasonCode}</p>
              ) : null}
            </li>
          ))}
        </ol>
      </Section>

      <AmendmentPanel
        locale={locale}
        shipmentId={id}
        currency={shipment.currency}
        exponent={shipment.currencyExponent}
        canRequest={canAmend}
        appliesImmediately={amendApplies}
        amendments={amendments.map((amendment) => ({
          id: amendment.id,
          status: amendment.status,
          reason: amendment.reason,
          decisionReason: amendment.decisionReason,
          lines: amendmentLines(amendment),
          // Formatted here: the panel is a client component and has no tenant
          // timezone to format against.
          at: formatDateTime(amendment.createdAt, locale, tz),
        }))}
      />

      {canReadNotes ? (
        <NotePanel
          locale={locale}
          subjectType="SHIPMENT"
          subjectId={id}
          canWrite={canWriteNotes}
          notes={notes.map((note) => ({
            id: note.id,
            body: note.body,
            authorName: note.authorName,
            pinned: note.pinned,
            resolvedAt: note.resolvedAt,
            // Formatted here: the panel is a client component and has no
            // tenant timezone to format against.
            writtenAt: formatDateTime(note.createdAt, locale, tz),
          }))}
        />
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-500 uppercase tracking-wider">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function InfoRow({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={`font-medium text-slate-900 ${ltr === true ? "ltr-isolate" : ""}`}>{value}</span>
    </div>
  );
}

/**
 * Statuses where a return note is meaningful.
 *
 * Printing one for a parcel that was delivered normally hands the driver a
 * docket with no return reason on it.
 */
const RETURN_STATUSES: ReadonlySet<string> = new Set(["RETURN_PENDING", "RETURNED"]);

function DocumentLink({
  locale,
  id,
  type,
  label,
}: {
  locale: Locale;
  id: string;
  type: string;
  label: string;
}) {
  return (
    <a
      href={`/${locale}/documents/${id}/${type}`}
      target="_blank"
      rel="noopener"
      className="inline-flex min-h-9 items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:bg-slate-50"
    >
      {label}
    </a>
  );
}
