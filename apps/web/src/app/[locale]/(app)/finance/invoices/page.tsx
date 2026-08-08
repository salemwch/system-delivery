import Link from "next/link";

import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { fetchInvoices } from "@/lib/queries";

/**
 * Factures et avoirs.
 *
 * Both kinds in one list, because they are one legal series in the operator's
 * head even though they number separately. The KIND column is what distinguishes
 * them, and a draft shows an em dash where its number will be — a draft has no
 * number by design, and rendering a blank cell reads as a bug.
 */
export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string; status?: string; kind?: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const query = await searchParams;

  const filters: Record<string, string> = {};
  if (query.status !== undefined) filters["status"] = query.status;
  if (query.kind !== undefined) filters["kind"] = query.kind;

  const result = await fetchInvoices(query.cursor, filters);
  const base = `/${locale}/finance/invoices`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Link href={`/${locale}/finance`} className="text-sm text-brand hover:underline">
          ← {messages.finance}
        </Link>
      </div>

      <PageHeader title={messages.invoices}>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`${base}/settings`}
            className="inline-flex min-h-9 items-center rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            {messages.billingSettings}
          </Link>
          <Link
            href={`${base}/new`}
            className="inline-flex min-h-9 items-center rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white transition hover:opacity-90"
          >
            {messages.newInvoice}
          </Link>
        </div>
      </PageHeader>

      <nav className="flex flex-wrap gap-2" aria-label={messages.status}>
        <FilterLink href={base} label={messages.actions} active={query.status === undefined} />
        {["DRAFT", "ISSUED", "PAID", "CANCELLED"].map((status) => (
          <FilterLink
            key={status}
            href={`${base}?status=${status}`}
            label={status}
            active={query.status === status}
          />
        ))}
      </nav>

      <DataTable
        headers={[
          messages.invoiceNumber,
          messages.merchants,
          messages.period,
          messages.status,
          messages.totalTtc,
        ]}
      >
        {result.data.map((invoice) => (
          <tr key={invoice.id} className="hover:bg-slate-50">
            <td className="px-4 py-3">
              <Link
                href={`${base}/${invoice.id}`}
                className="ltr-isolate font-mono text-sm text-brand hover:underline"
              >
                {/* A draft genuinely has no number; an em dash says so. */}
                {invoice.number ?? "—"}
              </Link>
              {invoice.kind === "CREDIT_NOTE" ? (
                <span className="ms-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                  {messages.creditNote}
                </span>
              ) : null}
            </td>
            <td className="px-4 py-3 text-sm">{invoice.buyerName ?? "—"}</td>
            <td className="px-4 py-3 text-sm text-slate-500">
              <span className="ltr-isolate">
                {invoice.periodFrom} → {invoice.periodTo}
              </span>
            </td>
            <td className="px-4 py-3">
              <StatusBadge status={invoice.status} locale={locale} />
            </td>
            <td className="px-4 py-3 text-end text-sm font-semibold tabular-nums">
              {/* `totalMinor` is a STRING of minor units — BigInt, never Number. */}
              {formatMoney(BigInt(invoice.totalMinor), invoice.currencyExponent, locale)}{" "}
              {invoice.currency}
            </td>
          </tr>
        ))}
      </DataTable>

      {result.cursor === null ? null : (
        <Link
          href={`${base}?${new URLSearchParams({ ...filters, cursor: result.cursor }).toString()}`}
          className="inline-flex min-h-9 items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium transition hover:bg-slate-50"
        >
          {messages.loading}
        </Link>
      )}
    </div>
  );
}

function FilterLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={
        active
          ? "rounded-full bg-brand px-3 py-1 text-xs font-semibold text-white"
          : "rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
      }
    >
      {label}
    </Link>
  );
}
