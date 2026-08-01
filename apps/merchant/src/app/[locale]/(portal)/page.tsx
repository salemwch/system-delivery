import Link from "next/link";

import { EmptyState, StatCard, StatusBadge, BUTTON_CLASS } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatDate, formatMoney, formatRate } from "@/lib/format";
import { ACTIVE_STATUSES, ATTENTION_STATUSES, MESSAGES, toLocale } from "@/lib/i18n";
import { fetchBootstrap, fetchDashboard, fetchShipments } from "@/lib/queries";

/**
 * The dashboard.
 *
 * Four numbers and a short list, because a merchant opens this to answer three
 * questions: where are my parcels, how much am I owed, and is anything stuck.
 * Everything else is a click away rather than on the first screen.
 *
 * Server-rendered: the whole page is a read, so no client JavaScript is involved
 * in producing it.
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const tz = timezone();

  const config = await fetchBootstrap();
  // Fetched together: two independent reads, and a dashboard that waits for one
  // then the other is twice as slow for no reason.
  const [stats, recent] = await Promise.all([
    fetchDashboard(config.currency.code),
    fetchShipments({ limit: 5 }),
  ]);

  const byStatus = new Map(stats.byStatus.map((entry) => [entry.status, entry.count]));
  const active = sumOf(byStatus, ACTIVE_STATUSES);
  const attention = sumOf(byStatus, ATTENTION_STATUSES);
  const delivered = byStatus.get("DELIVERED") ?? 0;

  const money = (minor: string): string =>
    `${formatMoney(Number(minor), config.currency.exponent, locale)} ${config.currency.code}`;

  if (stats.totalShipments === 0) {
    return (
      <EmptyState
        title={messages.noShipmentsYet}
        hint={messages.createFirst}
        action={
          <Link href={`/${locale}/shipments/new`} className={BUTTON_CLASS}>
            {messages.newShipment}
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3">
        <StatCard
          label={messages.inProgress}
          value={String(active)}
          href={`/${locale}/shipments`}
        />
        {/* Money first among equals — it is the question merchants ask most. */}
        <StatCard label={messages.codOutstanding} value={money(stats.codPendingMinor)} tone="money" />
        <StatCard label={messages.deliveredThisMonth} value={String(delivered)} />
        <StatCard
          label={messages.deliveryRate}
          value={formatRate(stats.deliveryRate, locale)}
          hint={`${String(stats.todayDelivered)} / ${String(stats.todayCreated)}`}
        />
      </section>

      {attention > 0 ? (
        // Surfaced separately because these need a DECISION from the merchant —
        // a failed attempt or a parcel coming back is not just a number.
        <Link
          href={`/${locale}/shipments?status=ATTEMPT_FAILED`}
          className="flex items-center justify-between rounded-xl border border-amber-300 bg-amber-50 p-4 transition hover:border-amber-400"
        >
          <span className="text-sm font-semibold text-amber-900">
            ⚠ {messages.needsAttention}
          </span>
          <span className="text-lg font-bold tabular-nums text-amber-900">{attention}</span>
        </Link>
      ) : null}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">{messages.shipments}</h2>
          <Link href={`/${locale}/shipments`} className="text-sm font-medium text-brand">
            {messages.loadMore}
          </Link>
        </div>

        <ul className="space-y-2">
          {recent.data.map((shipment) => (
            <li key={shipment.id}>
              <Link
                href={`/${locale}/shipments/${shipment.id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 transition hover:border-brand"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{shipment.recipientName}</p>
                  <p className="ltr-isolate truncate font-mono text-xs text-slate-500">
                    {shipment.trackingNumber}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusBadge status={shipment.status} locale={locale} />
                  <span className="text-xs text-slate-500">
                    {formatDate(shipment.createdAt, locale, tz)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function sumOf(counts: ReadonlyMap<string, number>, statuses: ReadonlySet<string>): number {
  let total = 0;
  for (const [status, count] of counts) {
    if (statuses.has(status)) {
      total += count;
    }
  }
  return total;
}
