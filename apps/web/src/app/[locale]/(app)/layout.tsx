import { redirect } from "next/navigation";

import { Sidebar } from "@/components/sidebar";
import type { NavItem } from "@/components/sidebar";
import { signOut } from "@/lib/actions";
import { courierName } from "@/lib/api";
import { fetchWorkload } from "@/lib/queries";
import { MESSAGES, toLocale } from "@/lib/i18n";
import { NAV_GATES } from "@/lib/permissions";
import { hasPermission, readSession } from "@/lib/session";

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const messages = MESSAGES[locale];
  const session = await readSession();

  if (session === null) {
    redirect(`/${locale}/login`);
  }

  // ⚠️ ONE call for every badge, and it must NEVER break the shell. A failed
  // count is a missing badge; a thrown error would be a blank application on
  // every page, which is a far worse outcome than not knowing a number.
  const [courier, workload] = await Promise.all([
    courierName(),
    fetchWorkload().catch(() => null),
  ]);

  /** Section key → its badge. Sections with no queue are simply absent. */
  const BADGES: Readonly<Record<string, number>> =
    workload === null
      ? {}
      : {
          remarks: workload.remarks,
          applications: workload.applications,
          amendments: workload.amendments,
          support: workload.support,
          inventory: workload.lowStock,
        };
  const base = `/${locale}`;

  const NAV_ICONS: Readonly<Record<string, string>> = {
    dashboard: "◈",
    shipments: "◫",
    amendments: "⇄",
    documents: "▤",
    import: "⇪",
    dispatch: "⊞",
    fleet: "⊟",
    network: "◉",
    merchants: "◧",
    applications: "✚",
    pickups: "◨",
    custody: "⊡",
    inventory: "▣",
    finance: "⊠",
    support: "☎",
    reports: "◱",
    remarks: "✎",
    complaints: "◬",
    users: "◯",
    settings: "⚙",
    audit: "◷",
  };

  const items: NavItem[] = [];

  for (const [key, permission] of Object.entries(NAV_GATES)) {
    if (permission !== null && !hasPermission(session, permission)) {
      continue;
    }
    const label = messages[key as keyof typeof messages];
    if (typeof label !== "string") continue;
    items.push({
      key,
      label,
      href: key === "dashboard" ? base : `${base}/${key}`,
      icon: NAV_ICONS[key] ?? "•",
      ...(BADGES[key] === undefined ? {} : { badge: BADGES[key] }),
    });
  }

  return (
    <div className="flex min-h-dvh">
      <Sidebar locale={locale} courier={courier} items={items} />

      <div className="flex flex-1 flex-col overflow-x-hidden">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <div />
          <form action={signOut.bind(null, locale)}>
            <button
              type="submit"
              className="rounded px-3 py-1.5 text-sm text-slate-500 transition hover:text-slate-800"
            >
              {messages.signOut}
            </button>
          </form>
        </header>

        <main className="flex-1 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
