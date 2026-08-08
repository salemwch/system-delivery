import Link from "next/link";
import { notFound } from "next/navigation";

import { StockForms } from "@/components/stock-forms";
import { DataTable, PageHeader } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { fetchHubs, fetchInventoryItems, fetchMovements, fetchStock } from "@/lib/queries";
import { hasPermission, requireSession } from "@/lib/session";

/**
 * Gestion de stock — what each hub has on the shelf.
 *
 * ⚠️ NOT PARCELS. A parcel's location is the custody chain; this is the label
 * rolls, tape and bags a hub runs on — the things a courier discovers it has
 * none of on a Saturday, after which it cannot dispatch.
 *
 * Low shelves lead, because they are the only rows anyone has to act on. The
 * quantity is derived from the movement log, so it cannot disagree with the
 * history shown below it.
 */
export default async function InventoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ hubId?: string; cursor?: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const tz = timezone();
  const query = await searchParams;

  const session = await requireSession(locale);
  if (!hasPermission(session, P.INVENTORY_READ)) {
    notFound();
  }
  const canManage = hasPermission(session, P.INVENTORY_MANAGE);

  const hubFilter = query.hubId === undefined ? {} : { hubId: query.hubId };

  const [stock, items, hubs, movements] = await Promise.all([
    fetchStock(hubFilter),
    fetchInventoryItems(true),
    fetchHubs(),
    fetchMovements(query.cursor, hubFilter),
  ]);

  const hubNames = new Map(hubs.data.map((hub) => [hub.id, hub.code]));
  const itemNames = new Map(items.map((item) => [item.id, item.sku]));

  // Low first: they are the only rows anyone has to act on. Then by SKU, so the
  // list is stable between refreshes.
  const sorted = [...stock].sort((a, b) =>
    a.low === b.low ? a.sku.localeCompare(b.sku) : a.low ? -1 : 1,
  );
  const lowCount = stock.filter((row) => row.low).length;

  const base = `/${locale}/inventory`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <PageHeader title={messages.inventory} />
        {lowCount > 0 ? (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
            {lowCount} · {messages.lowStock}
          </span>
        ) : null}
      </div>

      {/* A plain GET form: the hub filter belongs in the URL so a storeman can
          bookmark their own hub. */}
      <form action={base} method="get" className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="hubId">
          {messages.network}
        </label>
        <select
          id="hubId"
          name="hubId"
          defaultValue={query.hubId ?? ""}
          className="min-h-9 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        >
          <option value="">{messages.allHubs}</option>
          {hubs.data.map((hub) => (
            <option key={hub.id} value={hub.id}>
              {hub.code} — {hub.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
        >
          {messages.search}
        </button>
      </form>

      {canManage ? (
        <StockForms
          locale={locale}
          items={items.map((item) => ({ id: item.id, label: `${item.sku} — ${item.name}` }))}
          hubs={hubs.data.map((hub) => ({ id: hub.id, label: `${hub.code} — ${hub.name}` }))}
        />
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">{messages.onHand}</h2>
        <DataTable
          headers={[
            messages.reference,
            messages.item,
            messages.network,
            messages.quantity,
            messages.reorderLevel,
          ]}
        >
          {sorted.map((row) => (
            <tr
              key={`${row.hubId}-${row.itemId}`}
              className={row.low ? "bg-amber-50" : "hover:bg-slate-50"}
            >
              <td className="px-4 py-3">
                <span className="ltr-isolate font-mono text-sm">{row.sku}</span>
              </td>
              <td className="px-4 py-3 text-sm font-medium text-slate-900">{row.name}</td>
              <td className="px-4 py-3 text-sm text-slate-600">
                {hubNames.get(row.hubId) ?? "—"}
              </td>
              <td className="px-4 py-3 text-end text-sm font-semibold tabular-nums ltr-isolate">
                {row.quantity} {row.unit}
              </td>
              <td className="px-4 py-3 text-end text-sm tabular-nums ltr-isolate text-slate-500">
                {row.reorderLevel ?? "—"}
              </td>
            </tr>
          ))}
        </DataTable>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">{messages.movements}</h2>
        <DataTable
          headers={[
            messages.reference,
            messages.network,
            messages.quantity,
            messages.reason,
            locale === "ar" ? "التاريخ" : locale === "fr" ? "Date" : "Date",
          ]}
        >
          {movements.data.map((movement) => (
            <tr key={movement.id} className="hover:bg-slate-50">
              <td className="px-4 py-3">
                <span className="ltr-isolate font-mono text-sm">
                  {itemNames.get(movement.itemId) ?? "—"}
                </span>
              </td>
              <td className="px-4 py-3 text-sm text-slate-600">
                {hubNames.get(movement.hubId) ?? "—"}
                {movement.counterpartHubId === null ? null : (
                  <span className="ms-1 text-xs text-slate-400">
                    {movement.direction === "OUT" ? "→" : "←"}{" "}
                    {hubNames.get(movement.counterpartHubId) ?? "—"}
                  </span>
                )}
              </td>
              {/* The sign is rendered from the direction, never stored — the
                  quantity column is always positive. */}
              <td
                className={
                  movement.direction === "IN"
                    ? "px-4 py-3 text-end text-sm font-semibold tabular-nums ltr-isolate text-emerald-800"
                    : "px-4 py-3 text-end text-sm font-semibold tabular-nums ltr-isolate text-red-700"
                }
              >
                {movement.direction === "IN" ? "+" : "−"}
                {movement.quantity}
              </td>
              <td className="px-4 py-3 text-xs text-slate-500">
                {movement.reason}
                {movement.note === null ? null : (
                  <span className="ms-2 text-slate-400">{movement.note}</span>
                )}
              </td>
              <td className="px-4 py-3 text-sm text-slate-500">
                {formatDateTime(movement.occurredAt, locale, tz)}
              </td>
            </tr>
          ))}
        </DataTable>

        {movements.cursor === null ? null : (
          <div className="flex justify-center">
            <Link
              href={`${base}?cursor=${encodeURIComponent(movements.cursor)}${
                query.hubId === undefined ? "" : `&hubId=${encodeURIComponent(query.hubId)}`
              }`}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
            >
              {messages.loadMore}
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
