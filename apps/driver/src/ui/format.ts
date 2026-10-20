import type { Locale, MessageKey } from "../core/i18n";

/** The tag Intl formats with: Tunisian conventions in each language. */
function intlTag(locale: Locale): string {
  return locale === "ar" ? "ar-TN" : `${locale}-TN`;
}

/** "14:05" from an ISO string or epoch ms; Western digits, as Tunisian receipts print them. */
export function clock(value: string | number, locale: Locale): string {
  return new Date(value).toLocaleTimeString(intlTag(locale), {
    hour: "2-digit",
    minute: "2-digit",
    numberingSystem: "latn",
  });
}

export function longDate(now: Date, locale: Locale): string {
  return now.toLocaleDateString(intlTag(locale), {
    weekday: "long",
    day: "numeric",
    month: "long",
    numberingSystem: "latn",
  });
}

export function greetingKey(now: Date): MessageKey {
  const hour = now.getHours();
  return hour < 12 ? "goodMorning" : hour < 18 ? "goodAfternoon" : "goodEvening";
}

/** A ratio (0..1) as a whole percentage. */
const PERCENT = 100;
export function percent(ratio: number): string {
  return `${String(Math.round(ratio * PERCENT))} %`;
}
