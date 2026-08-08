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
export function amendmentLines(amendment: AmendmentSummary): string[] {
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
    // ⚠️ Minor units, shown as minor units. Formatting needs the currency's
    // exponent, which this row does not carry; printing "45000" beside a real
    // amount would be worse than the raw figure a dispatcher can read as
    // millimes.
    const before = previous["codAmountMinor"];
    lines.push(
      typeof before === "string"
        ? `COD: ${before} → ${amendment.codAmountMinor}`
        : `COD: ${amendment.codAmountMinor}`,
    );
  }

  return lines;
}
