import Link from "next/link";
import { redirect } from "next/navigation";

import { signOut } from "@/lib/actions";
import { courierName } from "@/lib/api";
import { LOCALES, MESSAGES, toLocale } from "@/lib/i18n";
import { readSession } from "@/lib/session";

/**
 * The signed-in shell: header, navigation, language switcher.
 *
 * ⚠️ The session check lives HERE, in a layout every authenticated page nests
 * under, rather than in each page. A page added later is protected by where it
 * sits in the tree — the failure mode of per-page checks is the page someone
 * forgets.
 *
 * This is defence in depth, not the boundary itself: the API rejects an
 * unauthenticated call regardless, and RLS narrows every row to this merchant.
 * The redirect exists so a signed-out merchant sees a login form instead of an
 * error.
 */
export default async function PortalLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];

  if ((await readSession()) === null) {
    redirect(`/${locale}/login`);
  }

  const courier = await courierName();
  const base = `/${locale}`;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-brand">{courier}</p>
            <p className="text-xs text-slate-500">{messages.portal}</p>
          </div>

          <div className="flex items-center gap-2">
            <nav aria-label={messages.language} className="flex gap-1">
              {LOCALES.map((candidate) => (
                <Link
                  key={candidate}
                  href={`/${candidate}`}
                  hrefLang={candidate}
                  aria-current={candidate === locale ? "true" : undefined}
                  className={
                    candidate === locale
                      ? "rounded px-2 py-1 text-xs font-bold text-brand"
                      : "rounded px-2 py-1 text-xs text-slate-500 hover:text-slate-800"
                  }
                >
                  {candidate.toUpperCase()}
                </Link>
              ))}
            </nav>

            {/* A form, not a link: signing out is a state change and must not be
                reachable by a prefetch or a crawler following an href. */}
            <form action={signOut.bind(null, locale)}>
              <button
                type="submit"
                className="rounded px-2 py-1 text-xs text-slate-500 hover:text-slate-800"
              >
                {messages.signOut}
              </button>
            </form>
          </div>
        </div>

        <nav className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-2 pb-2" aria-label={messages.portal}>
          <NavLink href={base} label={messages.dashboard} />
          <NavLink href={`${base}/shipments`} label={messages.shipments} />
          <NavLink href={`${base}/address-book`} label={messages.addressBook} />
        </nav>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</main>

      {/* A permanent, thumb-reachable primary action. Creating a parcel is why a
          merchant opens this portal; it should never be more than one tap away. */}
      <div className="sticky bottom-0 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto max-w-3xl">
          <Link
            href={`${base}/shipments/new`}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 font-semibold text-white transition hover:bg-brand-dark"
          >
            <span aria-hidden="true">+</span>
            {MESSAGES[locale].newShipment}
          </Link>
        </div>
      </div>
    </div>
  );
}

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
    >
      {label}
    </Link>
  );
}
