import { notFound } from "next/navigation";

import { DataTable, PageHeader } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatMoney, formatRate } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { fetchMerchants, fetchParcelState } from "@/lib/queries";
import { hasPermission, requireSession } from "@/lib/session";

/**
 * État Colis (Entreprise) — every merchant's parcels by status, over a period.
 *
 * The month-end report: who is shipping, how much arrived, and how much cash is
 * still in the field against each account.
 *
 * ⚠️ Only the statuses that MATTER are shown as columns. The API returns all
 * eleven — a stable shape the CSV depends on — but a screen with eleven numeric
 * columns is a screen nobody reads. The export carries the full breakdown.
 */
const SHOWN_STATUSES = [
  "CREATED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "ATTEMPT_FAILED",
  "RETURNED",
] as const;

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ from?: string; to?: string; merchantId?: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const query = await searchParams;

  const session = await requireSession(locale);
  if (!hasPermission(session, P.SHIPMENT_READ)) {
    notFound();
  }

  const period = monthBounds(query.from, query.to, timezone());

  const [report, merchants] = await Promise.all([
    fetchParcelState(period.from, period.to, query.merchantId),
    fetchMerchants(null, 200),
  ]);

  const totals = report.rows.reduce(
    (sum, row) => ({
      parcels: sum.parcels + row.total,
      delivered: sum.delivered + (row.byStatus["DELIVERED"] ?? 0),
    }),
    { parcels: 0, delivered: 0 },
  );

  const exportQuery = new URLSearchParams({ from: period.from, to: period.to });
  if (query.merchantId !== undefined && query.merchantId !== "") {
    exportQuery.set("merchantId", query.merchantId);
  }

  return (
    <div className="space-y-6">
      <PageHeader title={messages.parcelStateReport} />

      {/* A plain GET form: the period belongs in the URL so a report is a link
          an operator can bookmark and send to their accountant. */}
      <form
        action={`/${locale}/reports`}
        method="get"
        className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4"
      >
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{messages.period}</span>
          <input
            type="date"
            name="from"
            defaultValue={period.from}
            className="min-h-9 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">→</span>
          <input
            type="date"
            name="to"
            defaultValue={period.to}
            className="min-h-9 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{messages.merchants}</span>
          <select
            name="merchantId"
            defaultValue={query.merchantId ?? ""}
            className="min-h-9 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          >
            <option value="">{messages.allMerchants}</option>
            {merchants.data.map((merchant) => (
              <option key={merchant.id} value={merchant.id}>
                {merchant.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="min-h-9 rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
        >
          {messages.search}
        </button>

        {/*
          A plain link, not a fetch: the browser downloads it straight from our
          own origin, and the Route Handler adds the bearer token server-side.
        */}
        <a
          href={`/${locale}/reports/export?${exportQuery.toString()}`}
          className="min-h-9 rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-white transition hover:opacity-90"
        >
          {messages.exportCsv}
        </a>
      </form>

      <div className="flex flex-wrap gap-4 text-sm">
        <span className="rounded-lg border border-slate-200 bg-white px-3 py-2">
          {messages.parcels}: <strong className="tabular-nums">{totals.parcels}</strong>
        </span>
        <span className="rounded-lg border border-slate-200 bg-white px-3 py-2">
          {messages.deliveryRate}:{" "}
          <strong className="tabular-nums">
            {totals.parcels === 0
              ? "—"
              : formatRate(totals.delivered / totals.parcels, locale, 1)}
          </strong>
        </span>
      </div>

      <DataTable
        headers={[
          messages.merchants,
          messages.parcels,
          ...SHOWN_STATUSES.map((status) => statusLabel(status, locale)),
          messages.deliveryRate,
          messages.codCollected,
          messages.codPending,
        ]}
      >
        {report.rows.map((row) => (
          <tr key={row.merchantId} className="hover:bg-slate-50">
            <td className="px-4 py-3 text-sm font-medium text-slate-900">{row.merchantName}</td>
            <td className="px-4 py-3 text-end text-sm font-semibold tabular-nums">{row.total}</td>
            {SHOWN_STATUSES.map((status) => (
              <td key={status} className="px-4 py-3 text-end text-sm tabular-nums text-slate-600">
                {row.byStatus[status] ?? 0}
              </td>
            ))}
            <td className="px-4 py-3 text-end text-sm tabular-nums">
              {formatRate(row.deliveryRate, locale, 1)}
            </td>
            <td className="px-4 py-3 text-end text-sm tabular-nums ltr-isolate">
              {formatMoney(BigInt(row.codCollectedMinor), row.currencyExponent, locale)}
            </td>
            <td className="px-4 py-3 text-end text-sm tabular-nums ltr-isolate text-amber-900">
              {formatMoney(BigInt(row.codPendingMinor), row.currencyExponent, locale)}
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

function statusLabel(status: string, locale: "ar" | "fr" | "en"): string {
  const labels: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    CREATED: { ar: "أُنشئ", fr: "Créés", en: "Created" },
    OUT_FOR_DELIVERY: { ar: "قيد التوصيل", fr: "En livraison", en: "Out" },
    DELIVERED: { ar: "سُلّم", fr: "Livrés", en: "Delivered" },
    ATTEMPT_FAILED: { ar: "محاولة فاشلة", fr: "Échecs", en: "Failed" },
    RETURNED: { ar: "أُرجع", fr: "Retournés", en: "Returned" },
  };
  return labels[status]?.[locale] ?? status;
}

/**
 * The reporting window, defaulting to the current month IN THE TENANT'S
 * TIMEZONE.
 *
 * ⚠️ `new Date()` on the server is UTC. For a courier in Africa/Tunis (UTC+1)
 * the first hour of every month falls in the previous one, so a parcel created
 * at 00:30 on the 1st would be missing from the month it belongs to.
 */
function monthBounds(
  from: string | undefined,
  to: string | undefined,
  tz: string,
): { from: string; to: string } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const [year = "2026", month = "01"] = today.split("-");
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();

  return {
    from: from ?? `${year}-${month}-01`,
    to: to ?? `${year}-${month}-${String(lastDay).padStart(2, "0")}`,
  };
}
