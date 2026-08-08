import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { fetchEmailStatus } from "@/lib/queries";
import { hasPermission, requireSession } from "@/lib/session";

/**
 * E-mail — what transport is bound, and where to change it.
 *
 * ⚠️ READ-ONLY, AND THAT IS THE DESIGN. The obvious screen is a form for SMTP
 * host, username and password — and it would mean storing a live SMTP PASSWORD
 * in the database, a credential store this system does not have and should not
 * grow for one integration. Secrets belong in the deployment's secret store.
 *
 * So the page tells an operator exactly two things: whether email works, and
 * which environment variables their administrator must set. A screen that
 * pretends to be editable and silently does nothing would be worse than this.
 */
export default async function EmailSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];

  const session = await requireSession(locale);
  if (!hasPermission(session, P.FEATURE_MANAGE)) {
    notFound();
  }

  const status = await fetchEmailStatus();

  return (
    <div className="space-y-6">
      <Link href={`/${locale}/settings`} className="text-sm text-brand hover:underline">
        ← {messages.settings}
      </Link>

      <PageHeader title={messages.emailSettings} />

      <section className="max-w-xl space-y-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center gap-3">
          <span
            className={
              status.configured
                ? "rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800"
                : "rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900"
            }
          >
            {status.configured ? messages.emailConfigured : messages.emailNotConfigured}
          </span>
          <span className="ltr-isolate font-mono text-xs text-slate-500">{status.provider}</span>
        </div>

        {status.configured ? (
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">{messages.emailFrom}</dt>
              <dd className="ltr-isolate font-mono">
                {status.fromName === "" ? status.fromAddress : `${status.fromName} <${status.fromAddress}>`}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">{messages.emailHost}</dt>
              <dd className="ltr-isolate font-mono">{status.host}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-slate-600">{messages.emailNotConfiguredHint}</p>
        )}
      </section>

      <section className="max-w-xl rounded-xl border border-slate-200 bg-slate-50 p-4">
        <h2 className="text-sm font-semibold text-slate-900">{messages.notEditable}</h2>
        <p className="mt-1 text-sm text-slate-600">{messages.emailSecretsHint}</p>
        {/* Named explicitly: an operator forwarding this page to their host needs
            the variable names, not a description of them. */}
        <ul className="mt-2 space-y-0.5 ltr-isolate font-mono text-xs text-slate-500">
          <li>NOTIFICATION_EMAIL_PROVIDER=smtp</li>
          <li>SMTP_HOST · SMTP_PORT</li>
          <li>SMTP_USERNAME · SMTP_PASSWORD</li>
          <li>SMTP_FROM_ADDRESS · SMTP_FROM_NAME</li>
        </ul>
      </section>
    </div>
  );
}
