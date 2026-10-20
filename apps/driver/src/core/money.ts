import type { Locale } from "./i18n";

/**
 * Money on the wire (docs/05 §1.3): minor units as a decimal STRING, with the
 * ISO 4217 exponent the server read from `currencies`. TND has THREE decimals;
 * nothing here assumes two, and nothing here touches a float: 12.500 TND is
 * the string "12500" with exponent 3, formatted by string arithmetic.
 */
export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
  readonly currencyExponent: number;
}

/** How each language writes the dinar on a Tunisian receipt; the ISO code otherwise. */
const CURRENCY_LABEL: Readonly<Record<string, Readonly<Record<Locale, string>>>> = {
  TND: { ar: "د.ت", fr: "DT", en: "TND" },
};

const DIGITS = /^\d+$/u;
/** A narrow no-break space (U+202F): thousands never split across a line break. */
export const GROUP_SEPARATOR = String.fromCharCode(0x202f);

/** "12500", 3 → "12.500" (fr: "12,500"); thousands grouped with a thin space. */
export function formatMoney(money: Money, locale: Locale): string {
  const label = CURRENCY_LABEL[money.currency]?.[locale] ?? money.currency;
  return `${formatAmount(money.amountMinor, money.currencyExponent, locale)} ${label}`;
}

export function formatAmount(amountMinor: string, exponent: number, locale: Locale): string {
  const negative = amountMinor.startsWith("-");
  const digits = negative ? amountMinor.slice(1) : amountMinor;
  if (!DIGITS.test(digits)) {
    return amountMinor;
  }
  const padded = digits.padStart(exponent + 1, "0");
  const whole = padded.slice(0, padded.length - exponent).replace(/^0+(?=\d)/u, "");
  const fraction = padded.slice(padded.length - exponent);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, GROUP_SEPARATOR);
  const separator = locale === "fr" ? "," : ".";
  return `${negative ? "-" : ""}${grouped}${exponent > 0 ? separator + fraction : ""}`;
}

export function isZero(money: Money): boolean {
  return /^-?0+$/u.test(money.amountMinor);
}

/** Totals per currency (amounts in different currencies are never summed). */
export function sumByCurrency(items: readonly Money[]): Money[] {
  const totals = new Map<string, { sum: bigint; exponent: number }>();
  for (const item of items) {
    if (!/^-?\d+$/u.test(item.amountMinor)) continue;
    const current = totals.get(item.currency);
    totals.set(item.currency, {
      sum: (current?.sum ?? 0n) + BigInt(item.amountMinor),
      exponent: item.currencyExponent,
    });
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, { sum, exponent }]) => ({
      amountMinor: sum.toString(),
      currency,
      currencyExponent: exponent,
    }));
}

/**
 * What a driver types ("12.5", "12,500", "12") to minor units, or null when
 * it is not an amount in this currency (too many decimals, letters, empty).
 * String arithmetic only: `4.005 * 1000` is 4004.999… in floating point.
 */
export function parseAmount(input: string, exponent: number): string | null {
  // `\s` covers the no-break and narrow no-break spaces a pasted amount carries.
  const normalised = input.trim().replace(/\s/gu, "").replace(",", ".");
  const match = /^(\d+)(?:\.(\d*))?$/u.exec(normalised);
  if (match === null) {
    return null;
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) {
    return null;
  }
  const minor = `${whole}${fraction.padEnd(exponent, "0")}`.replace(/^0+(?=\d)/u, "");
  return minor;
}

/**
 * What is left to hand over, per currency: collected minus already declared,
 * never below zero (an over-declaration is the hub's variance, not a debt the
 * app invents).
 */
export function remaining(collected: readonly Money[], handed: readonly Money[]): Money[] {
  return collected
    .map((money) => {
      const paid = handed
        .filter((h) => h.currency === money.currency)
        .reduce((sum, h) => sum + BigInt(h.amountMinor), 0n);
      const left = BigInt(money.amountMinor) - paid;
      return { ...money, amountMinor: (left > 0n ? left : 0n).toString() };
    })
    .filter((money) => !isZero(money));
}
