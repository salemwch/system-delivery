/**
 * Turns what a Tunisian actually types into the E.164 the API demands.
 *
 * Nobody in Sousse writes `+21624201314`. They write `24201314`, or
 * `24 201 314`, or `+216 24 201 314`. The API accepts only E.164, so a form
 * that merely validates rejects the natural input and the user has no idea
 * why — which is exactly what happened: a merchant registration silently
 * failed on a correctly-typed phone number.
 *
 * Normalising is the right layer for this. The API stays strict (one canonical
 * format in the database, invariant across every client) and the UI meets the
 * person where they are.
 */

/** Tunisia. The only country this platform ships in at MVP. */
const DEFAULT_DIALLING_CODE = "216";

/** Tunisian subscriber numbers are 8 digits. */
const NATIONAL_LENGTH = 8;

/** E.164: a leading '+', a non-zero country digit, then 7–15 digits total. */
const E164 = /^\+[1-9]\d{6,14}$/u;

/**
 * Returns E.164, or null when the input cannot be one.
 *
 * Null is a validation failure the caller reports; it never guesses a country
 * for a number that is not plausibly Tunisian.
 */
export function toE164(input: string): string | null {
  const trimmed = input.trim();

  // Strip every non-digit rather than listing separators. Spaces, dots, dashes,
  // brackets and the non-breaking spaces that arrive when a number is pasted
  // from a browser all go, and no literal whitespace character has to appear in
  // this source file to do it.
  const digits = trimmed.replace(/\D/gu, "");
  if (digits === "") {
    return null;
  }

  // Already international: an explicit '+', or the '00' a landline user dials.
  if (trimmed.startsWith("+")) {
    return check(`+${digits}`);
  }
  if (digits.startsWith("00")) {
    return check(`+${digits.slice(2)}`);
  }

  // A bare national number. Only assume Tunisia when the length matches, so a
  // half-typed or foreign number is refused rather than silently mangled into
  // a plausible-looking wrong one.
  if (digits.length === NATIONAL_LENGTH) {
    return check(`+${DEFAULT_DIALLING_CODE}${digits}`);
  }
  return null;
}

function check(candidate: string): string | null {
  return E164.test(candidate) ? candidate : null;
}
