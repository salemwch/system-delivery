"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { Locale } from "@/lib/i18n";

export interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  readonly icon: string;
}

export function Sidebar({
  locale,
  courier,
  items,
}: {
  locale: Locale;
  courier: string;
  items: readonly NavItem[];
}) {
  const pathname = usePathname();

  return (
    <aside className="flex h-dvh w-56 flex-col bg-sidebar text-white">
      <div className="border-b border-white/10 px-4 py-4">
        <p className="truncate text-sm font-bold text-brand-soft">{courier}</p>
      </div>

      <nav className="flex-1 overflow-y-auto p-2 scrollbar-thin">
        <ul className="space-y-0.5">
          {items.map((item) => {
            const active = isActive(pathname, item.href, locale);
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className={
                    active
                      ? "flex items-center gap-3 rounded-lg bg-sidebar-active px-3 py-2 text-sm font-medium text-white"
                      : "flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-300 transition hover:bg-sidebar-hover hover:text-white"
                  }
                  aria-current={active ? "page" : undefined}
                >
                  <span className="w-5 text-center" aria-hidden="true">{item.icon}</span>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-white/10 p-2">
        <div className="flex gap-1">
          {(["ar", "fr", "en"] as const).map((candidate) => (
            <Link
              key={candidate}
              href={pathname.replace(`/${locale}`, `/${candidate}`)}
              hrefLang={candidate}
              className={
                candidate === locale
                  ? "rounded px-2 py-1 text-xs font-bold text-brand-soft"
                  : "rounded px-2 py-1 text-xs text-slate-400 transition hover:text-white"
              }
            >
              {candidate.toUpperCase()}
            </Link>
          ))}
        </div>
      </div>
    </aside>
  );
}

function isActive(pathname: string, href: string, locale: Locale): boolean {
  const base = `/${locale}`;
  if (href === base) {
    return pathname === base || pathname === `${base}/`;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
