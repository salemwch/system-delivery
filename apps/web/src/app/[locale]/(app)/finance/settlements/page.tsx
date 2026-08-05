import Link from "next/link";

import { PageHeader } from "@/components/ui";
import { toLocale } from "@/lib/i18n";

export default async function SettlementsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Link href={`/${locale}/finance`} className="text-sm text-brand hover:underline">
          {locale === "ar" ? "← المالية" : locale === "fr" ? "← Finance" : "← Finance"}
        </Link>
      </div>

      <PageHeader
        title={locale === "ar" ? "التسويات" : locale === "fr" ? "Règlements" : "Settlements"}
      />

      <p className="text-sm text-slate-600">
        {locale === "ar"
          ? "إنشاء التسويات وإدارتها من هذه الصفحة."
          : locale === "fr"
            ? "Créez et gérez les règlements marchands depuis cette page."
            : "Create and manage merchant settlements from this page."}
      </p>
    </div>
  );
}
