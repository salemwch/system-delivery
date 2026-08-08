import { formatMoney } from "./format";
import type { Locale } from "./i18n";
import type { AmendmentSummary } from "./queries";

/**
 * A requested change rendered as `field: old → new` lines.
 *
 * Pure, and in its own module rather than inside either component, because both
 * the queue and the parcel panel show the same thing and a second copy would
 * eventually disagree with the first about which fields exist.
 *
 * `previous` is null until an amendment is applied, so a pending row shows the
 * requested value alone. That is honest: the old value is on the parcel page
 * the row links to, and inventing an arrow from nothing would suggest the change
 * had already happened.
 */
export function amendmentLines(amendment: AmendmentSummary, locale: Locale): string[] {
  const previous = amendment.previous ?? {};
  const lines: string[] = [];

  const push = (label: string, key: string, next: string): void => {
    const before = previous[key];
    lines.push(typeof before === "string" ? `${label}: ${before} → ${next}` : `${label}: ${next}`);
  };

  if (amendment.recipientName !== null) {
    push("name", "recipientName", amendment.recipientName);
  }
  if (amendment.recipientPhone !== null) {
    push("phone", "recipientPhone", amendment.recipientPhone);
  }
  if (amendment.recipientPhoneAlt !== null) {
    push("phone2", "recipientPhoneAlt", amendment.recipientPhoneAlt);
  }
  if (amendment.destinationRawInput !== null) {
    // The snapshot holds the old ADDRESS ID, not its text — an id tells a
    // dispatcher nothing, so only the new address is shown. The parcel page
    // beside it still displays where the parcel is currently going.
    const city = amendment.destinationCity === null ? "" : `, ${amendment.destinationCity}`;
    lines.push(`address: ${amendment.destinationRawInput}${city}`);
  }
  if (amendment.codAmountMinor !== null) {
    // ⚠️ Formatted against the parcel's OWN exponent, which the API sends with
    // every amendment. TND has THREE decimals: a hardcoded ÷100 would show
    // 45.000 TND as "450.00" on the screen a dispatcher approves cash from.
    const money = (minor: string): string =>
      `${formatMoney(BigInt(minor), amendment.currencyExponent, locale)} ${amendment.currency}`;

    const before = previous["codAmountMinor"];
    lines.push(
      typeof before === "string"
        ? `COD: ${money(before)} → ${money(amendment.codAmountMinor)}`
        : `COD: ${money(amendment.codAmountMinor)}`,
    );
  }

  return lines;
}
