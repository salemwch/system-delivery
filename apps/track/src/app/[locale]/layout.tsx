import type { Metadata, Viewport } from "next";

import { directionOf, toLocale } from "@/lib/i18n";
import "../globals.css";

/**
 * The root layout, under the locale segment.
 *
 * ⚠️ Locale is a PATH segment, not a query parameter, and that is what makes
 * `lang`/`dir` settable at all: a layout cannot read `searchParams`, and `dir`
 * has to be on `<html>` for the whole document to mirror. It also means the
 * language switcher is three ordinary links — no JavaScript, which matters
 * against a <100 KB budget (docs/08 §9).
 */
export const metadata: Metadata = {
  title: "Suivi de colis",
  // ⚠️ A tracking URL carries a token granting access to a real person's parcel.
  // A search engine that indexes one publishes it.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Never disable zoom — read on a phone, outdoors, by people of every age.
  maximumScale: 5,
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);

  return (
    <html lang={locale} dir={directionOf(locale)}>
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
