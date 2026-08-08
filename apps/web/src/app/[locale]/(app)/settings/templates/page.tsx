import Link from "next/link";
import { notFound } from "next/navigation";

import { TemplateEditor } from "@/components/template-editor";
import { PageHeader } from "@/components/ui";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { P } from "@/lib/permissions";
import { hasPermission, requireSession } from "@/lib/session";
import { fetchTemplates } from "@/lib/queries";

/**
 * The notification copy, grouped by event.
 *
 * Grouped rather than listed flat because the three locales of one event are
 * what an operator compares — changing the French wording of
 * `shipment.delivered` without looking at the Arabic beside it is how the two
 * drift apart.
 */
export default async function TemplatesPage({
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

  const templates = await fetchTemplates();

  // A Map preserves the order the API sent, which is the event order rather
  // than alphabetical — `shipment.created` before `shipment.delivered` reads
  // as the lifecycle it is.
  const byKey = new Map<string, typeof templates>();
  for (const template of templates) {
    byKey.set(template.key, [...(byKey.get(template.key) ?? []), template]);
  }

  return (
    <div className="space-y-6">
      <Link href={`/${locale}/settings`} className="text-sm text-brand hover:underline">
        ← {messages.settings}
      </Link>

      <PageHeader title={messages.smsTemplates} />

      {byKey.size === 0 ? (
        <p className="text-sm text-slate-500">{messages.noResults}</p>
      ) : (
        [...byKey.entries()].map(([key, group]) => (
          <section key={key} className="space-y-3">
            <h2 className="ltr-isolate font-mono text-sm font-semibold text-slate-700">{key}</h2>
            <div className="grid gap-3 lg:grid-cols-3">
              {group.map((template) => (
                <TemplateEditor
                  key={`${template.key}:${template.locale}:${template.channel}`}
                  template={template}
                  locale={locale}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
