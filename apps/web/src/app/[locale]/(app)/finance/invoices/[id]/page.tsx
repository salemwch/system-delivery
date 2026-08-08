import Link from "next/link";

import {
  CancelDraftForm,
  CreditNoteForm,
  IssueInvoiceButton,
  MarkPaidButton,
} from "@/components/invoice-commands";
import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatDateTime, formatMoney } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { fetchInvoice } from "@/lib/queries";

/**
 * One facture or avoir.
 *
 * The action panel renders EXACTLY the transitions this status permits — the
 * same discipline as the pickups page. A button that only ever produces
 * `INVOICE_NOT_DRAFT` teaches the operator to ignore error messages.
 *
 *   DRAFT     → issue, cancel
 *   ISSUED    → mark paid, credit note
 *   PAID      → credit note
 *   CANCELLED → nothing
 */
export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: raw, id } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const tz = timezone();

  const invoice = await fetchInvoice(id);
  const base = `/${locale}/finance/invoices`;
  const money = (minor: string): string =>
    `${formatMoney(BigInt(minor), invoice.currencyExponent, locale)} ${invoice.currency}`;

  const title =
    invoice.kind === "CREDIT_NOTE"
      ? `${messages.creditNote} ${invoice.number ?? ""}`.trim()
      : `${messages.invoice} ${invoice.number ?? ""}`.trim();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Link href={base} className="text-sm text-brand hover:underline">
          ← {messages.invoices}
        </Link>
      </div>

      <PageHeader title={title}>
        <div className="flex items-center gap-3">
          <StatusBadge status={invoice.status} locale={locale} />
          {/*
            The printable document, served by the API as HTML the browser turns
            into a PDF. `target="_blank"` because it replaces the whole page —
            it is a document, not a view of one.
          */}
          <a
            href={`/${locale}/finance/invoices/${invoice.id}/print`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-9 items-center rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            {messages.printInvoice}
          </a>
        </div>
      </PageHeader>

      {invoice.correctsInvoiceId === null ? null : (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          {messages.correctsInvoice}{" "}
          <Link
            href={`${base}/${invoice.correctsInvoiceId}`}
            className="font-semibold underline"
          >
            {messages.details}
          </Link>
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-xl border border-slate-200 bg-white p-4 lg:col-span-2">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label={messages.merchants} value={invoice.buyerName ?? "—"} />
            <Detail
              label={messages.period}
              value={`${invoice.periodFrom} → ${invoice.periodTo}`}
            />
            <Detail
              label={messages.issueDate}
              value={
                invoice.issuedAt === null ? "—" : formatDateTime(invoice.issuedAt, locale, tz)
              }
            />
            <Detail
              label={messages.dueDate}
              value={invoice.dueAt === null ? "—" : formatDateTime(invoice.dueAt, locale, tz)}
            />
            {invoice.sellerTaxId === null ? null : (
              <Detail label={messages.taxIdentifier} value={invoice.sellerTaxId} />
            )}
            {invoice.notes === null ? null : (
              <Detail label={messages.reason} value={invoice.notes} />
            )}
          </dl>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-600">
            {messages.actions}
          </h2>
          <div className="space-y-4">
            {invoice.status === "DRAFT" ? (
              <>
                <IssueInvoiceButton invoiceId={invoice.id} locale={locale} />
                <CancelDraftForm invoiceId={invoice.id} locale={locale} />
              </>
            ) : null}
            {invoice.status === "ISSUED" ? (
              <MarkPaidButton invoiceId={invoice.id} locale={locale} />
            ) : null}
            {/*
              A credit note corrects an ISSUED document. Never offered on a
              draft (edit it) nor on a cancelled one (it never existed legally),
              and `kind` guards against crediting an avoir with an avoir.
            */}
            {invoice.kind === "INVOICE" &&
            (invoice.status === "ISSUED" || invoice.status === "PAID") ? (
              <CreditNoteForm invoiceId={invoice.id} locale={locale} />
            ) : null}
            {invoice.status === "CANCELLED" ? (
              <p className="text-sm text-slate-500">{messages.noResults}</p>
            ) : null}
          </div>
        </section>
      </div>

      <DataTable
        headers={["#", messages.description, messages.quantity, messages.unitPrice, messages.amount]}
      >
        {invoice.lines.map((line) => (
          <tr key={line.id}>
            <td className="px-4 py-3 text-sm text-slate-500">{line.position}</td>
            <td className="px-4 py-3 text-sm">{line.description}</td>
            <td className="px-4 py-3 text-end text-sm tabular-nums">{line.quantity}</td>
            <td className="px-4 py-3 text-end text-sm tabular-nums">
              {money(line.unitPriceMinor)}
            </td>
            <td className="px-4 py-3 text-end text-sm font-medium tabular-nums">
              {money(line.lineTotalMinor)}
            </td>
          </tr>
        ))}
      </DataTable>

      <div className="flex justify-end">
        <dl className="w-full max-w-sm space-y-1 rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <TotalRow label={messages.subtotalHt} value={money(invoice.subtotalMinor)} />
          <TotalRow
            label={`${messages.vat} ${(invoice.vatRateBp / 100).toFixed(2)}%`}
            value={money(invoice.vatAmountMinor)}
          />
          <TotalRow label={messages.stampDuty} value={money(invoice.stampDutyMinor)} />
          <div className="mt-2 flex justify-between border-t-2 border-slate-900 pt-2 text-base font-bold">
            <dt>{messages.totalTtc}</dt>
            <dd className="tabular-nums">{money(invoice.totalMinor)}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-900">{value}</dd>
    </div>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-600">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
