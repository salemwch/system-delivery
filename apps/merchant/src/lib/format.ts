import type { Locale } from "./i18n";

/** Display formatting. Pure, so it is testable without a browser or a server. */

/**
 * Formats an integer minor-unit amount using the currency's OWN exponent.
 *
 * ⚠️ The exponent comes from the API, never from an assumption. **TND has three
 * decimal places**: 12500 minor units is 12.500 TND, not 125.00. This portal is
 * where a merchant reads what they are owed, so a factor-of-ten error here is
 * an invoice dispute rather than a cosmetic bug.
 */
export function formatMoney(amountMinor: number, exponent: number, locale: Locale): string {
  const negative = amountMinor < 0;
  const abs = Math.abs(amountMinor);

  if (exponent <= 0) {
    return `${negative ? "-" : ""}${groupDigits(String(abs), locale)}`;
  }

  const divisor = 10 ** exponent;
  const whole = Math.floor(abs / divisor);
  const fraction = String(abs % divisor).padStart(exponent, "0");
  // Comma in French and Arabic Tunisian usage, full stop in English. Reversed,
  // 12,500 reads as twelve thousand five hundred.
  const separator = locale === "en" ? "." : ",";
  return `${negative ? "-" : ""}${groupDigits(String(whole), locale)}${separator}${fraction}`;
}

/**
 * Parses a merchant-typed amount into minor units.
 *
 * ⚠️ Accepts both `,` and `.` as the decimal mark. A Tunisian merchant types
 * "12,500" and an English-speaking one types "12.500" — for the SAME amount.
 * Guessing from the locale would silently mis-read whichever the merchant did
 * not use, so both are accepted and the exponent decides the scale.
 *
 * Returns null for anything unparseable, so the caller shows a field error
 * rather than creating a parcel worth an arbitrary sum.
 */
export function parseMoney(input: string, exponent: number): number | null {
  const trimmed = input.trim().replace(/\s/gu, "");
  if (trimmed === "") {
    return null;
  }
  // One decimal mark, at most, and only digits either side.
  const match = /^(\d+)(?:[.,](\d+))?$/u.exec(trimmed);
  if (match === null) {
    return null;
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) {
    // More precision than the currency has. Rejected rather than rounded: a
    // merchant typing 12.5001 TND meant something, and silently dropping the
    // last digit decides on their behalf.
    return null;
  }
  return Number(`${whole}${fraction.padEnd(exponent, "0")}`);
}

function groupDigits(digits: string, locale: Locale): string {
  const separator = locale === "en" ? "," : " ";
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, separator);
}

const LOCALE_TAGS: Readonly<Record<Locale, string>> = {
  // Latin digits even in Arabic: a tracking number or an amount read back over
  // the phone must not be in Eastern-Arabic numerals.
  ar: "ar-TN-u-nu-latn",
  fr: "fr-TN",
  en: "en-GB",
};

/**
 * A date and time in the courier's own zone.
 *
 * ⚠️ `timeZone` is always explicit. Rendered on the server the default is the
 * SERVER's zone, so a UTC container shows a Tunisian merchant times an hour out
 * — which reads as a parcel being delivered before it was collected.
 */
export function formatDateTime(iso: string, locale: Locale, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone,
    // 24-hour, always. Without this ICU gives en-GB a 12-hour clock, so the same
    // timestamp reads "02:10 PM" in English and "14:10" in French.
    hourCycle: "h23",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Date only — for list rows, where the time is noise. */
export function formatDate(iso: string, locale: Locale, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

/** A percentage from a 0–1 rate, with no decimals — nobody needs 87.3%. */
export function formatRate(rate: number, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale], {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(rate);
}

/** Grams to a readable weight. Metres and grams are the storage units. */
export function formatWeight(grams: number, locale: Locale): string {
  if (grams < 1000) {
    return locale === "ar" ? `${String(grams)} غ` : `${String(grams)} g`;
  }
  const kg = (grams / 1000).toFixed(grams % 1000 === 0 ? 0 : 1);
  return locale === "ar" ? `${kg} كغ` : `${kg} kg`;
}
