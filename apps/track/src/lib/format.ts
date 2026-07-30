import type { Locale } from "./i18n.js";

/**
 * Display formatting. Pure, so it is testable without a browser or a server.
 */

/**
 * Formats an integer minor-unit amount using the currency's OWN exponent.
 *
 * ⚠️ The exponent comes from the API, never from an assumption. **TND has three
 * decimal places**: 12500 minor units is 12.500 TND, not 125.00. Hardcoding 2
 * here would misprice every amount on the one page a recipient reads before
 * handing over cash — and it would be wrong in the direction that starts an
 * argument on a doorstep.
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
  // A comma is the decimal separator in French and Arabic Tunisian usage; a full
  // stop in English. Getting this backwards makes 12,500 look like twelve
  // thousand five hundred.
  const separator = locale === "en" ? "." : ",";
  return `${negative ? "-" : ""}${groupDigits(String(whole), locale)}${separator}${fraction}`;
}

/** Thousands separators, using a narrow no-break space as French typography does. */
function groupDigits(digits: string, locale: Locale): string {
  const separator = locale === "en" ? "," : " ";
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, separator);
}

const LOCALE_TAGS: Readonly<Record<Locale, string>> = {
  // Latin digits even in Arabic: a tracking reference and a time are read back
  // to a call centre, and Eastern-Arabic numerals are a transcription error
  // waiting to happen.
  ar: "ar-TN-u-nu-latn",
  fr: "fr-TN",
  en: "en-GB",
};

/**
 * A date and time in the courier's own zone.
 *
 * ⚠️ `timeZone` is explicit and always passed. Rendered on the server, the
 * default would be the SERVER's zone — so a UTC container would show a Tunisian
 * recipient times an hour out, which reads as the parcel arriving before it was
 * collected.
 */
export function formatDateTime(iso: string, locale: Locale, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone,
    hourCycle: "h23",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Just the clock time — for the estimated-arrival window. */
function formatTime(iso: string, locale: Locale, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone,
    // 24-hour, always. ICU gives en-GB a 12-hour clock here otherwise, so an
    // arrival window would read "02:10 PM" in English and "14:10" in French.
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * The promised window as a single range, or null when there is no promise.
 *
 * Null rather than an empty range: a shipment with no SLA template has no
 * promised date (that is a real state), and printing "—" invites a recipient to
 * call and ask what it means.
 */
export function formatWindow(
  from: string | null,
  to: string | null,
  locale: Locale,
  timeZone: string,
): string | null {
  if (to === null) {
    return null;
  }
  if (from === null) {
    return formatTime(to, locale, timeZone);
  }
  return `${formatTime(from, locale, timeZone)} – ${formatTime(to, locale, timeZone)}`;
}
