import { getLocales } from "expo-localization";
import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

import { MESSAGES, isRtl, pickLocale } from "../core/i18n";
import type { Locale, Messages } from "../core/i18n";

interface I18n {
  readonly locale: Locale;
  readonly rtl: boolean;
  readonly t: Messages;
}

const I18nContext = createContext<I18n | null>(null);

/**
 * The device language, resolved once per launch. Layout direction itself is
 * native: the expo-localization plugin (`supportsRTL`) lets Android mirror
 * the app for Arabic, and every style uses start/end, never left/right.
 */
export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const value = useMemo<I18n>(() => {
    const locale = pickLocale(getLocales().map((l) => l.languageTag));
    return { locale, rtl: isRtl(locale), t: MESSAGES[locale] };
  }, []);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (value === null) {
    throw new Error("useI18n outside I18nProvider");
  }
  return value;
}
