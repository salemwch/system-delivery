import Link from "next/link";

import { StatusBadge } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatDateTime, formatMoney } from "@/lib/format";
import { toLocale } from "@/lib/i18n";
import { hasPermission, readSession } from "@/lib/session";
import { P } from "@/lib/permissions";
import { fetchShipment } from "@/lib/queries";

export default async function ShipmentDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: raw, id } = await params;
  const locale = toLocale(raw);
  const tz = timezone();
  const session = await readSession();
  const canReadCod = session !== null && hasPermission(session, P.COD_READ_AMOUNT);

  const shipment = await fetchShipment(id);

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

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={locale === "ar" ? "المستلم" : locale === "fr" ? "Destinataire" : "Recipient"}>
          <InfoRow label={locale === "ar" ? "الاسم" : locale === "fr" ? "Nom" : "Name"} value={shipment.recipientName} />
          <InfoRow label={locale === "ar" ? "الهاتف" : locale === "fr" ? "Téléphone" : "Phone"} value={shipment.recipientPhone} ltr />
          <InfoRow label={locale === "ar" ? "العنوان" : locale === "fr" ? "Adresse" : "Address"} value={shipment.destination.rawInput} />
        </Section>

        <Section title={locale === "ar" ? "التفاصيل" : locale === "fr" ? "Détails" : "Details"}>
          <InfoRow label={locale === "ar" ? "التاجر" : locale === "fr" ? "Commerçant" : "Merchant"} value={shipment.merchantName} />
          <InfoRow label={locale === "ar" ? "الطرود" : locale === "fr" ? "Colis" : "Parcels"} value={String(shipment.parcelCount)} />
          {canReadCod && shipment.codAmountMinor > 0 ? (
            <InfoRow
              label="COD"
              value={`${formatMoney(shipment.codAmountMinor, 3, locale)} ${shipment.currency}`}
              ltr
            />
          ) : null}
        </Section>
      </div>

      <Section title={locale === "ar" ? "السجل" : locale === "fr" ? "Historique" : "Timeline"}>
        <ol className="space-y-3 border-s-2 border-slate-200 ps-4">
          {shipment.events.map((event) => (
            <li key={event.id} className="relative">
              <span className="absolute -start-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand" />
              <div className="flex items-baseline gap-2">
                <StatusBadge status={event.status} locale={locale} />
                <span className="text-xs text-slate-500">
                  {formatDateTime(event.createdAt, locale, tz)}
                </span>
              </div>
              {event.reason !== null ? (
                <p className="mt-1 text-sm text-slate-600">{event.reason}</p>
              ) : null}
            </li>
          ))}
        </ol>
      </Section>
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
