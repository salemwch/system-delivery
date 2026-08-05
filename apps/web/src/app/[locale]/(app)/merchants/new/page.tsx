import Link from "next/link";
import { notFound } from "next/navigation";

import { MerchantForm } from "@/components/merchant-form";
import { PageHeader } from "@/components/ui";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { hasPermission, requireSession } from "@/lib/session";

/**
 * Registers a new *expéditeur* — the first step of a commercial's sign-up.
 *
 * `notFound()` rather than a "forbidden" page for a caller without the
 * permission: the route's existence is not information anyone without
 * `merchant:create` needs, and the API refuses the write regardless.
 */
export default async function NewMerchantPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const session = await requireSession(locale);

  if (!hasPermission(session, P.MERCHANT_CREATE)) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <Link href={`/${locale}/merchants`} className="text-sm text-brand hover:underline">
        ← {messages.merchants}
      </Link>

      <PageHeader title={messages.newMerchant} />

      <MerchantForm locale={locale} />
    </div>
  );
}
