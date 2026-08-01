import type { Metadata, Viewport } from "next";

import { MESSAGES, directionOf, toLocale } from "@/lib/i18n";
import "../globals.css";

/**
 * The root layout, under the locale segment.
 *
 * ⚠️ Locale is a PATH segment, not a query parameter. A Next layout cannot read
 * `searchParams`, and `dir`/`lang` must sit on `<html>` for the document to
 * mirror — so `?lang=ar` cannot produce an RTL page at all.
 */
/**
 * ⚠️ `generateMetadata`, not a static `metadata` object, because the title has
 * to follow the locale.
 *
 * A static export cannot see `params`, so every locale shipped the FRENCH title:
 * an Arabic merchant got a fully mirrored, fully translated page whose browser
 * tab, bookmark and share sheet all read "Espace expéditeur". The tab is the one
 * piece of the page that survives being backgrounded, so it is the label they
 * navigate by.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale: raw } = await params;
  return {
    title: MESSAGES[toLocale(raw)].portal,
    // A merchant portal holds commercial data. Nothing here should be indexed.
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Never disable zoom — used on a phone, one-handed, often outdoors.
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
