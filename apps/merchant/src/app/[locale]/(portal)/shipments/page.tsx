import Link from "next/link";

import { EmptyState, StatusBadge, SECONDARY_BUTTON_CLASS } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatDate, formatMoney } from "@/lib/format";
import { MESSAGES, STATUS_LABELS, toLocale } from "@/lib/i18n";
import { fetchBootstrap, fetchShipments } from "@/lib/queries";

/**
 * The parcel list.
 *
 * ⚠️ Filter and pagination live in the URL, not in component state. A merchant
 * can bookmark "my failed parcels", the back button behaves, and the whole page
 * stays a server component with no client JavaScript. Cursor pagination rather
 * than offset, because offset pages drift as new parcels arrive at the top.
 */

/** The statuses worth filtering by. Every status would be a wall of options. */
const FILTERS = [
  "",
  "CREATED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "ATTEMPT_FAILED",
  "RETURN_PENDING",
] as const;

export default async function ShipmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const query = await searchParams;
  const tz = timezone();

  const status = typeof query["status"] === "string" ? query["status"] : "";
  const cursor = typeof query["cursor"] === "string" ? query["cursor"] : "";

  const config = await fetchBootstrap();
  const page = await fetchShipments({ status, cursor, limit: 20 });

  return (
    <div className="space-y-4">
      {/* Links, not a <select> — no JavaScript, and each filter is a real URL a
          merchant can bookmark or share with their own staff. */}
      <nav aria-label={messages.status} className="flex flex-wrap gap-2">
        {FILTERS.map((candidate) => {
          const href =
            candidate === ""
              ? `/${locale}/shipments`
              : `/${locale}/shipments?status=${candidate}`;
          const active = candidate === status;
          return (
            <Link
              key={candidate || "all"}
              href={href}
              aria-current={active ? "true" : undefined}
              className={
                active
                  ? "rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-white"
                  : "rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:border-brand"
              }
            >
              {candidate === "" ? messages.allStatuses : STATUS_LABELS[locale][candidate]}
            </Link>
          );
        })}
      </nav>

      {page.data.length === 0 ? (
        <EmptyState title={messages.noResults} hint={messages.noResultsHint} />
      ) : (
        <ul className="space-y-2">
          {page.data.map((shipment) => {
            const cod = Number(shipment.codAmountMinor);
            return (
              <li key={shipment.id}>
                <Link
                  href={`/${locale}/shipments/${shipment.id}`}
                  className="block rounded-xl border border-slate-200 bg-white p-3 transition hover:border-brand"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{shipment.recipientName}</p>
                      <p className="ltr-isolate truncate font-mono text-xs text-slate-500">
                        {shipment.trackingNumber}
                      </p>
                    </div>
                    <StatusBadge status={shipment.status} locale={locale} />
                  </div>

                  <div className="mt-2 flex items-center justify-between text-xs text-slate-600">
                    <span>{formatDate(shipment.createdAt, locale, tz)}</span>
                    {cod > 0 ? (
                      <span className="ltr-isolate font-semibold text-slate-900">
                        {formatMoney(cod, config.currency.exponent, locale)}{" "}
                        {shipment.currency}
                      </span>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {page.page.hasMore && page.page.nextCursor !== null ? (
        <Link
          href={`/${locale}/shipments?${new URLSearchParams({
            ...(status === "" ? {} : { status }),
            cursor: page.page.nextCursor,
          }).toString()}`}
          className={`${SECONDARY_BUTTON_CLASS} w-full`}
        >
          {messages.loadMore}
        </Link>
      ) : null}
    </div>
  );
}
