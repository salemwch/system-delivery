import Link from "next/link";

import { InvoiceForm } from "@/components/invoice-form";
import { PageHeader } from "@/components/ui";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { fetchMerchants } from "@/lib/queries";

/**
 * Draft a new facture.
 *
 * The period defaults to LAST month, not this one. A courier invoices a merchant
 * for a closed period; defaulting to the current month produces an invoice for
 * work still in progress, which is the one thing an operator must never be
 * nudged into.
 *
 * The currency and its exponent are fixed to the tenant's own here (TND at three
 * decimals). Multi-currency invoicing is a real requirement but not one that
 * exists yet — when it does, this becomes a select and the hidden `exponent`
 * field already carries the right value through.
 */
const TENANT_CURRENCY = "TND";
const TENANT_CURRENCY_EXPONENT = 3;

export default async function NewInvoicePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];

  // 100 is the whole merchant list for a courier of any realistic size; a
  // select with a cursor would be worse than a long list.
  const merchants = await fetchMerchants(null, 100);
  const { from, to } = lastMonth();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Link href={`/${locale}/finance/invoices`} className="text-sm text-brand hover:underline">
          ← {messages.invoices}
        </Link>
      </div>

      <PageHeader title={messages.newInvoice} />

      <InvoiceForm
        locale={locale}
        merchants={merchants.data.map((merchant) => ({
          id: merchant.id,
          name: merchant.name,
        }))}
        currency={TENANT_CURRENCY}
        exponent={TENANT_CURRENCY_EXPONENT}
        defaultPeriodFrom={from}
        defaultPeriodTo={to}
      />
    </div>
  );
}

/**
 * The first and last day of the previous calendar month, as ISO dates.
 *
 * `Date.UTC` with day 0 of the following month gives the last day without any
 * knowledge of month lengths or leap years. UTC throughout: these are calendar
 * dates on a document, not instants, and a local-time construction shifts them
 * by a day for anyone east of Greenwich at the wrong hour.
 */
function lastMonth(): { from: string; to: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  return { from: isoDate(first), to: isoDate(last) };
}

function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}
