import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { courierName } from "@/lib/api";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { readSession } from "@/lib/session";

export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];

  if ((await readSession()) !== null) {
    redirect(`/${locale}`);
  }

  const courier = await courierName();

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-8">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {courier === "" ? null : (
          <p className="text-sm font-semibold text-brand">{courier}</p>
        )}
        <h1 className="mt-1 text-2xl font-bold">{messages.login}</h1>
        <LoginForm locale={locale} />
      </div>
    </main>
  );
}
