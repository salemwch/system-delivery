import Link from "next/link";

import { RegisterForm } from "@/components/register-form";
import { courierName } from "@/lib/api";
import { MESSAGES, toLocale } from "@/lib/i18n";

/**
 * The account application.
 *
 * Unauthenticated by design — this is how a shipper with no login asks for one,
 * so `proxy.ts` lets `/register` through alongside `/login`.
 *
 * ⚠️ Deliberately NOT redirected away for a signed-in merchant, unlike the login
 * page. Someone already holding an account who lands here is far more likely to
 * be applying on behalf of a second business than to be lost, and bouncing them
 * to a dashboard would silently discard what they came to do.
 */
export default async function RegisterPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];

  const courier = await courierName();

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-8">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {courier === "" ? null : <p className="text-sm font-semibold text-brand">{courier}</p>}
        <h1 className="mt-1 text-2xl font-bold">{messages.registerTitle}</h1>
        <p className="mt-1 text-sm text-slate-600">{messages.registerSubtitle}</p>

        <RegisterForm locale={locale} />
      </div>

      <div className="mt-4 flex justify-center gap-2">
        {(["ar", "fr", "en"] as const).map((candidate) => (
          <Link
            key={candidate}
            href={`/${candidate}/register`}
            hrefLang={candidate}
            className={
              candidate === locale
                ? "rounded px-2 py-1 text-xs font-bold text-brand"
                : "rounded px-2 py-1 text-xs text-slate-400 transition hover:text-slate-700"
            }
          >
            {candidate.toUpperCase()}
          </Link>
        ))}
      </div>
    </main>
  );
}
