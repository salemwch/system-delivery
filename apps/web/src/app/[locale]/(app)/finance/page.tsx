import { PageHeader } from "@/components/ui";
import { MESSAGES, toLocale } from "@/lib/i18n";

export default async function FinancePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];

  return (
    <div className="space-y-4">
      <PageHeader title={messages.finance} />

      <div className="grid gap-4 lg:grid-cols-3">
        <FinanceCard title={messages.invoices} href={`/${locale}/finance/invoices`} />
        <FinanceCard title={messages.expenses} href={`/${locale}/finance/expenses`} />
        <FinanceCard
          title={locale === "ar" ? "دفتر الأستاذ" : locale === "fr" ? "Grand livre" : "Ledger"}
          href={`/${locale}/finance/ledger`}
        />
        <FinanceCard
          title={locale === "ar" ? "التحصيل" : locale === "fr" ? "Remises" : "Remittances"}
          href={`/${locale}/finance/remittances`}
        />
        <FinanceCard
          title={locale === "ar" ? "التسويات" : locale === "fr" ? "Règlements" : "Settlements"}
          href={`/${locale}/finance/settlements`}
        />
      </div>
    </div>
  );
}

function FinanceCard({ title, href }: { title: string; href: string }) {
  return (
    <a
      href={href}
      className="block rounded-xl border border-slate-200 bg-white p-6 text-center transition hover:border-brand hover:shadow-sm"
    >
      <p className="text-lg font-semibold">{title}</p>
    </a>
  );
}
