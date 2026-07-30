import { fetchTracking } from "@/lib/api";
import { supportPhone, timezone } from "@/lib/config";
import type { TimelineEntry, TrackingFailure, TrackingView } from "@/lib/api";
import { formatDateTime, formatMoney, formatWindow } from "@/lib/format";
import { LOCALES, MESSAGES, TIMELINE_LABELS, toLocale } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * The public tracking page (docs/08-frontend-architecture.md §7).
 *
 * A server component start to finish: there is no client JavaScript on this
 * route at all. The budget is LCP <2.5 s on 3G and <100 KB of JS (docs/08 §9),
 * and it is strict for a reason — this loads once, on whatever phone and
 * connection a recipient happens to have, and a slow load becomes a support call.
 *
 * ⚠️ THE MOST EXPOSED SURFACE IN THE SYSTEM. Anyone holding the link sees it, so
 * it shows a first name and nothing else identifying: no surname, no phone, no
 * address, no driver, no live map (docs/07 §2.2). Everything rendered here comes
 * from an endpoint that returns only those fields — the restraint is enforced
 * server-side, not by this component choosing not to display things.
 */

interface PageProps {
  readonly params: Promise<{ locale: string; tenantSlug: string; trackingNumber: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TrackingPage({ params, searchParams }: PageProps) {
  const { locale: rawLocale, tenantSlug, trackingNumber } = await params;
  const locale = toLocale(rawLocale);
  const query = await searchParams;

  const rawToken = query["token"];
  const token = typeof rawToken === "string" ? rawToken : "";
  if (token === "") {
    return <Failure locale={locale} failure="not-found" />;
  }

  const result = await fetchTracking(tenantSlug, trackingNumber, token);
  if (!result.ok) {
    return <Failure locale={locale} failure={result.failure} />;
  }

  return (
    <Shell
      locale={locale}
      tenantSlug={tenantSlug}
      trackingNumber={trackingNumber}
      token={token}
      courierName={result.view.courierName}
    >
      <Parcel view={result.view} locale={locale} />
    </Shell>
  );
}

/** Page chrome: the courier letterhead and the language switcher. */
function Shell({
  locale,
  tenantSlug,
  trackingNumber,
  token,
  courierName,
  children,
}: {
  locale: Locale;
  tenantSlug: string;
  trackingNumber: string;
  token: string;
  courierName?: string;
  children: React.ReactNode;
}) {
  const messages = MESSAGES[locale];

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-6">
      {courierName !== undefined && courierName !== "" ? (
        <header className="border-b border-slate-200 pb-3">
          <p className="text-lg font-bold">{courierName}</p>
        </header>
      ) : null}

      <div className="flex-1">{children}</div>

      <footer className="mt-8 border-t border-slate-200 pt-4">
        {supportPhone() !== "" ? (
          <p className="mb-4 text-sm text-slate-600">
            {messages.needHelp}{" "}
            <a className="ltr-isolate font-medium text-brand" href={`tel:${supportPhone()}`}>
              {supportPhone()}
            </a>
          </p>
        ) : null}

        {/* Three ordinary links. Visible, not buried (docs/08 §7): the recipient
            arrives from an SMS and their language is unknown. No JavaScript. */}
        <nav aria-label={messages.language} className="flex gap-2">
          {LOCALES.map((candidate) => {
            const href = `/${candidate}/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(
              trackingNumber,
            )}?token=${encodeURIComponent(token)}`;
            const current = candidate === locale;
            return (
              <a
                key={candidate}
                href={href}
                hrefLang={candidate}
                aria-current={current ? "true" : undefined}
                className={
                  current
                    ? "rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white"
                    : "rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700"
                }
              >
                {candidate.toUpperCase()}
              </a>
            );
          })}
        </nav>
      </footer>
    </main>
  );
}

function Parcel({ view, locale }: { view: TrackingView; locale: Locale }) {
  const messages = MESSAGES[locale];
  const status = view.statusLabel[locale] ?? view.status;
  const window = formatWindow(view.promisedFrom, view.promisedTo, locale, timezone());
  const hasCod = view.codAmountMinor > 0;

  return (
    <>
      <p className="ltr-isolate mt-4 font-mono text-sm tracking-wide text-slate-500">
        {view.trackingNumber}
      </p>

      {/* Status as TEXT, never colour alone — docs/08 §10, and colour-blind
          recipients exist. The icon is decorative and hidden from readers. */}
      <p className="mt-4 flex items-center gap-2 text-2xl font-bold">
        <span aria-hidden="true">📦</span>
        {status}
      </p>

      {window !== null ? (
        <section className="mt-6">
          <h2 className="text-sm font-medium text-slate-600">{messages.estimatedArrival}</h2>
          <p className="ltr-isolate mt-1 rounded-lg border border-slate-200 bg-white px-4 py-3 text-xl font-semibold">
            {window}
          </p>
        </section>
      ) : null}

      <Timeline entries={view.timeline} locale={locale} currentStatus={view.status} />

      <section className="mt-8 border-t border-slate-200 pt-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-slate-600">{messages.recipient}</dt>
          {/* First name only. */}
          <dd className="font-medium">{view.recipientFirstName}</dd>

          {hasCod ? (
            <>
              <dt className="text-slate-600">{messages.toPay}</dt>
              <dd className="font-semibold">
                <span className="ltr-isolate">
                  {formatMoney(view.codAmountMinor, view.currencyExponent, locale)} {view.currency}
                </span>
                <span className="ms-2 text-slate-600">💵 {messages.cash}</span>
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      {hasCod ? (
        // A small COD-market touch that measurably reduces INSUFFICIENT_CASH
        // failures (docs/08 §7) — the driver rarely carries change.
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
          ⚠ {messages.prepareExactAmount}
        </p>
      ) : null}
    </>
  );
}

function Timeline({
  entries,
  locale,
  currentStatus,
}: {
  entries: readonly TimelineEntry[];
  locale: Locale;
  currentStatus: string;
}) {
  if (entries.length === 0) {
    return null;
  }
  const labels = TIMELINE_LABELS[locale];
  const messages = MESSAGES[locale];
  const lastIndex = entries.length - 1;

  return (
    <section className="mt-8 border-t border-slate-200 pt-4">
      <h2 className="sr-only">{messages.history}</h2>
      <ol className="space-y-4">
        {entries.map((entry, index) => {
          const done = index < lastIndex || currentStatus === "DELIVERED";
          return (
            <li key={`${entry.type}-${entry.occurredAt}`} className="flex gap-3">
              <span
                aria-hidden="true"
                className={
                  done
                    ? "mt-1 size-3 shrink-0 rounded-full bg-brand"
                    : "mt-1 size-3 shrink-0 rounded-full border-2 border-brand bg-white"
                }
              />
              <div>
                <p className="text-sm font-medium">{labels[entry.type] ?? entry.type}</p>
                <p className="ltr-isolate text-xs text-slate-500">
                  {formatDateTime(entry.occurredAt, locale, timezone())}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * The three ways this page fails, told apart on purpose.
 *
 * An expired link and an unknown one need different advice — "ask your sender
 * for a new link" versus "check the SMS". Collapsing them sends people to the
 * wrong remedy. Neither reveals whether a given parcel exists, because the API
 * answers identically for a wrong token and a wrong tracking number.
 */
function Failure({ locale, failure }: { locale: Locale; failure: TrackingFailure }) {
  const messages = MESSAGES[locale];
  const { title, detail } =
    failure === "expired"
      ? { title: messages.linkExpired, detail: messages.linkExpiredDetail }
      : { title: messages.notFound, detail: messages.notFoundDetail };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-6 text-center">
      <p className="text-5xl" aria-hidden="true">
        📭
      </p>
      <h1 className="mt-4 text-xl font-bold">{title}</h1>
      <p className="mt-2 text-sm text-slate-600">{detail}</p>
    </main>
  );
}
