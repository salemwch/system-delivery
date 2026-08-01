import Link from "next/link";
import { notFound } from "next/navigation";

import { CancelShipmentForm } from "@/components/cancel-shipment-form";
import { SECONDARY_BUTTON_CLASS, StatusBadge } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { apiBaseUrl, timezone } from "@/lib/config";
import { formatDateTime, formatMoney, formatWeight } from "@/lib/format";
import { EVENT_LABELS, MESSAGES, toLocale } from "@/lib/i18n";
import { fetchBootstrap, fetchShipment, fetchShipmentEvents } from "@/lib/queries";

/** Statuses a merchant may still cancel. Past pickup the courier holds the parcel. */
const CANCELLABLE: ReadonlySet<string> = new Set(["CREATED", "ASSIGNED"]);

export default async function ShipmentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: raw, id } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const query = await searchParams;
  const tz = timezone();

  let shipment;
  try {
    shipment = await fetchShipment(id);
  } catch (error) {
    // A merchant asking for another merchant's parcel gets a not-found, because
    // RLS narrows the row away entirely (invariant I24) — the API cannot tell
    // "yours and missing" from "someone else's", and neither should this page.
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      notFound();
    }
    throw error;
  }

  const [config, events] = await Promise.all([
    fetchBootstrap(),
    fetchShipmentEvents(id).catch(() => []),
  ]);

  const cod = Number(shipment.codAmountMinor);
  const justCreated = query["created"] === "1";

  return (
    <div className="space-y-6">
      {justCreated ? (
        <p
          role="status"
          className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900"
        >
          ✓ {messages.created_success}
        </p>
      ) : null}

      <header>
        <Link href={`/${locale}/shipments`} className="text-sm text-brand">
          ← {messages.back}
        </Link>
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold">{shipment.recipientName}</h1>
            <p className="ltr-isolate font-mono text-sm text-slate-500">
              {shipment.trackingNumber}
            </p>
          </div>
          <StatusBadge status={shipment.status} locale={locale} />
        </div>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-slate-600">{messages.recipient}</dt>
          <dd className="font-medium">{shipment.recipientName}</dd>

          <dt className="text-slate-600">{messages.recipientPhone}</dt>
          <dd className="ltr-isolate font-medium">{shipment.recipientPhone}</dd>

          {cod > 0 ? (
            <>
              <dt className="text-slate-600">{messages.cod}</dt>
              <dd className="ltr-isolate text-base font-bold">
                {formatMoney(cod, config.currency.exponent, locale)} {shipment.currency}
              </dd>
            </>
          ) : null}

          <dt className="text-slate-600">{messages.parcelDetails}</dt>
          <dd className="font-medium">
            {shipment.parcelCount} · {formatWeight(shipment.weightGrams, locale)}
          </dd>

          <dt className="text-slate-600">{messages.created}</dt>
          <dd className="font-medium">{formatDateTime(shipment.createdAt, locale, tz)}</dd>
        </dl>
      </section>

      {/* Documents open in a new tab as print-ready HTML — the browser's own
          Print-to-PDF makes the PDF, which is what renders Arabic correctly. */}
      <section className="flex flex-wrap gap-2">
        <a
          className={SECONDARY_BUTTON_CLASS}
          href={`${apiBaseUrl()}/v1/shipments/${shipment.id}/documents/bon-de-livraison?locale=${locale}`}
          target="_blank"
          rel="noreferrer"
        >
          🖨 {messages.deliveryNote}
        </a>
        <a
          className={SECONDARY_BUTTON_CLASS}
          href={`${apiBaseUrl()}/v1/shipments/${shipment.id}/documents/bon-d-envoi?locale=${locale}`}
          target="_blank"
          rel="noreferrer"
        >
          🖨 {messages.consignmentNote}
        </a>
      </section>

      {events.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-700">{messages.history}</h2>
          <ol className="space-y-3">
            {events.map((event, index) => (
              <li key={event.id} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className={
                    index === events.length - 1
                      ? "mt-1.5 size-2.5 shrink-0 rounded-full border-2 border-brand bg-white"
                      : "mt-1.5 size-2.5 shrink-0 rounded-full bg-brand"
                  }
                />
                <div>
                  <p className="text-sm font-medium">
                    {EVENT_LABELS[locale][event.eventType] ?? event.eventType}
                  </p>
                  <p className="ltr-isolate text-xs text-slate-500">
                    {formatDateTime(event.occurredAt, locale, tz)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {CANCELLABLE.has(shipment.status) ? (
        <CancelShipmentForm locale={locale} shipmentId={shipment.id} />
      ) : null}
    </div>
  );
}
