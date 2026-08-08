import Link from "next/link";
import { notFound } from "next/navigation";

import { ExpenseDecision } from "@/components/expense-decision";
import { ExpenseCategoryForm } from "@/components/expense-category-form";
import { ExpenseForm } from "@/components/expense-form";
import { DataTable, PageHeader, StatusBadge } from "@/components/ui";
import { timezone } from "@/lib/config";
import { formatMoney } from "@/lib/format";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import {
  fetchExpenseCategories,
  fetchExpenseSummary,
  fetchExpenses,
  fetchHubs,
  fetchVehicles,
} from "@/lib/queries";
import { hasPermission, requireSession } from "@/lib/session";

const TABS = ["DRAFT", "APPROVED", "REJECTED"] as const;

/**
 * Les dépenses — what the courier spends.
 *
 * The DRAFT tab is a work list: every row carries the buttons that clear it, and
 * approving posts a real ledger transaction. The month's totals sit above,
 * computed from APPROVED rows only — a draft is a claim somebody made, not money
 * that left the business, and including it would make this page disagree with
 * the ledger.
 */
export default async function ExpensesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string; status?: string; from?: string; to?: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const query = await searchParams;

  const session = await requireSession(locale);
  if (!hasPermission(session, P.EXPENSE_READ)) {
    notFound();
  }
  const canRecord = hasPermission(session, P.EXPENSE_RECORD);
  const canApprove = hasPermission(session, P.EXPENSE_APPROVE);

  const status = TABS.find((tab) => tab === query.status) ?? "DRAFT";
  const period = monthBounds(query.from, query.to, timezone());

  const [result, categories, hubs, vehicles, summary] = await Promise.all([
    fetchExpenses(query.cursor, { status }),
    fetchExpenseCategories(true),
    canRecord ? fetchHubs() : Promise.resolve({ data: [], cursor: null }),
    canRecord ? fetchVehicles() : Promise.resolve({ data: [], cursor: null }),
    fetchExpenseSummary(period.from, period.to),
  ]);

  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const base = `/${locale}/finance/expenses`;

  return (
    <div className="space-y-6">
      <Link href={`/${locale}/finance`} className="text-sm text-brand hover:underline">
        ← {messages.finance}
      </Link>

      <PageHeader title={messages.expenses} />

      {/* The month, from APPROVED rows only. */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">
          {messages.spendThisMonth} · {period.from} → {period.to}
        </h2>
        {summary.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">{messages.noResults}</p>
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {summary.map((row) => (
              <li
                key={`${row.categoryId}-${row.currency}`}
                className="flex items-baseline justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2"
              >
                <span className="text-sm text-slate-700">{row.categoryName}</span>
                <span className="ltr-isolate text-sm font-semibold tabular-nums text-slate-900">
                  {formatMoney(BigInt(row.totalMinor), row.currencyExponent, locale)} {row.currency}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab}
            href={tab === "DRAFT" ? base : `${base}?status=${tab}`}
            aria-current={tab === status ? "page" : undefined}
            className={
              tab === status
                ? "rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-white"
                : "rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            }
          >
            {tabLabel(tab, messages)}
          </Link>
        ))}
      </div>

      {canApprove ? (
        <ExpenseCategoryForm locale={locale} hasCategories={categories.length > 0} />
      ) : null}

      {canRecord && categories.length > 0 ? (
        <ExpenseForm
          locale={locale}
          today={period.today}
          currency={summary[0]?.currency ?? "TND"}
          exponent={summary[0]?.currencyExponent ?? 3}
          categories={categories.map((category) => ({
            id: category.id,
            label: `${category.code} — ${category.name}`,
          }))}
          hubs={hubs.data.map((hub) => ({ id: hub.id, label: `${hub.code} — ${hub.name}` }))}
          vehicles={vehicles.data.map((vehicle) => ({
            id: vehicle.id,
            label: vehicle.plateNumber,
          }))}
        />
      ) : null}

      <DataTable
        headers={[
          messages.reference,
          messages.category,
          messages.description,
          messages.amount,
          messages.paidFrom,
          messages.spentOn,
          status === "DRAFT" ? "" : messages.status,
        ]}
      >
        {result.data.map((expense) => (
          <tr key={expense.id} className="align-top hover:bg-slate-50">
            <td className="px-4 py-3">
              <span className="ltr-isolate font-mono text-sm">{expense.reference}</span>
            </td>
            <td className="px-4 py-3 text-sm text-slate-600">
              {categoryNames.get(expense.categoryId) ?? "—"}
            </td>
            <td className="px-4 py-3 max-w-xs text-sm text-slate-800">
              {expense.description}
              {expense.supplierReference === null ? null : (
                <span className="ms-2 ltr-isolate font-mono text-xs text-slate-500">
                  {expense.supplierReference}
                </span>
              )}
            </td>
            <td className="px-4 py-3 text-end text-sm font-semibold tabular-nums ltr-isolate">
              {formatMoney(BigInt(expense.amountMinor), expense.currencyExponent, locale)}{" "}
              {expense.currency}
            </td>
            <td className="px-4 py-3 text-xs">
              {expense.paidFrom === "HUB_CASH" ? (
                <span className="rounded-full bg-amber-50 px-2 py-1 font-medium text-amber-900">
                  {messages.paidFromHubCash}
                </span>
              ) : (
                <span className="text-slate-500">{messages.paidFromBank}</span>
              )}
            </td>
            <td className="px-4 py-3 text-sm text-slate-500">{expense.spentOn}</td>
            <td className="px-4 py-3">
              {status === "DRAFT" ? (
                canApprove ? (
                  <ExpenseDecision
                    expenseId={expense.id}
                    locale={locale}
                    postsToCash={expense.paidFrom === "HUB_CASH"}
                  />
                ) : null
              ) : (
                <div className="text-xs">
                  <StatusBadge status={expense.status} locale={locale} />
                  {expense.decisionReason === null ? null : (
                    <p className="mt-1 max-w-xs text-slate-500">{expense.decisionReason}</p>
                  )}
                </div>
              )}
            </td>
          </tr>
        ))}
      </DataTable>

      {result.cursor === null ? null : (
        <div className="flex justify-center">
          <Link
            href={`${base}?status=${status}&cursor=${encodeURIComponent(result.cursor)}`}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          >
            {messages.loadMore}
          </Link>
        </div>
      )}
    </div>
  );
}

function tabLabel(tab: string, messages: (typeof MESSAGES)["fr"]): string {
  switch (tab) {
    case "APPROVED":
      return messages.approved;
    case "REJECTED":
      return messages.rejected;
    default:
      return messages.pending;
  }
}

/**
 * The reporting window, defaulting to the current month IN THE TENANT'S
 * TIMEZONE.
 *
 * ⚠️ `new Date()` on the server is UTC. For a courier in Africa/Tunis (UTC+1)
 * the first hour of every month would fall in the previous one, so a receipt
 * entered at 00:30 on the 1st would vanish from the month it belongs to.
 * `en-CA` formats as `YYYY-MM-DD`, which is the shape the API takes.
 */
function monthBounds(
  from: string | undefined,
  to: string | undefined,
  tz: string,
): { from: string; to: string; today: string } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const [year = "2026", month = "01"] = today.split("-");
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();

  return {
    from: from ?? `${year}-${month}-01`,
    to: to ?? `${year}-${month}-${String(lastDay).padStart(2, "0")}`,
    today,
  };
}
