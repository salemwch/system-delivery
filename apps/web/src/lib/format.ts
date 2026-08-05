import type { Locale } from "./i18n";

/**
 * Renders minor units with the currency's OWN exponent.
 *
 * Accepts `bigint` as well as `number` because some endpoints return COD totals
 * as decimal STRINGS — sums that can exceed `Number.MAX_SAFE_INTEGER` in a
 * three-decimal currency and would silently round if parsed as floats. The
 * arithmetic below is integer division on BigInt, so it is exact either way.
 *
 * ⚠️ `exponent` is always supplied by the API. TND has THREE decimals; a
 * hardcoded ÷100 misprices every Tunisian amount by a factor of ten.
 */
export function formatMoney(
  amountMinor: number | bigint,
  exponent: number,
  locale: Locale,
): string {
  const value = typeof amountMinor === "bigint" ? amountMinor : BigInt(Math.trunc(amountMinor));
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const sign = negative ? "-" : "";

  if (exponent <= 0) {
    return `${sign}${groupDigits(abs.toString(), locale)}`;
  }

  const divisor = 10n ** BigInt(exponent);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(exponent, "0");
  const separator = locale === "en" ? "." : ",";
  return `${sign}${groupDigits(whole.toString(), locale)}${separator}${fraction}`;
}

function groupDigits(digits: string, locale: Locale): string {
  const separator = locale === "en" ? "," : " ";
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, separator);
}

const LOCALE_TAGS: Readonly<Record<Locale, string>> = {
  ar: "ar-TN-u-nu-latn",
  fr: "fr-TN",
  en: "en-GB",
};

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

export function formatRate(rate: number, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale], {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(rate);
}
