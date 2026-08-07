import { MESSAGES } from "./i18n";
import type { Locale } from "./i18n";

/**
 * Turns an API error code into something the person reading it can act on.
 *
 * ⚠️ The forms used to render a single "The request failed" for every non-field
 * error. A merchant registration rejected with `MERCHANT_CODE_TAKEN` — a
 * one-word fix the user could have made instantly — was indistinguishable from
 * the database being down. They retried the same code, got the same nothing,
 * and had no way to learn why.
 *
 * The fallback deliberately INCLUDES the raw code. An unmapped error is still
 * diagnosable over the phone, and the missing translation is visible rather
 * than silently swallowed.
 */

/** Errors whose cause belongs beside a specific input, not at the top of the form. */
export const FIELD_FOR_ERROR: Readonly<Record<string, string>> = {
  MERCHANT_CODE_TAKEN: "code",
  USER_EMAIL_TAKEN: "email",
};

export function apiErrorMessage(code: string, locale: Locale): string {
  const messages = MESSAGES[locale];
  switch (code) {
    case "MERCHANT_CODE_TAKEN":
      return messages.errorCodeTaken;
    case "USER_EMAIL_TAKEN":
      return messages.errorEmailTaken;
    case "NOT_FOUND":
      return messages.errorNotFound;
    case "FORBIDDEN":
    case "PERMISSION_DENIED":
      return messages.errorForbidden;
    case "PICKUP_INVALID_TRANSITION":
      return messages.pickupNotClaimable;
    case "validation":
      return messages.errorValidation;
    default:
      return `${messages.requestFailed} (${code})`;
  }
}

/**
 * The message shown beneath a single input.
 *
 * Handles both sources that land there: the client schema's own keys
 * (`required`, `phone`, `format`) and an API code routed to a field by
 * {@link FIELD_FOR_ERROR}. Without this the box read "MERCHANT_CODE_TAKEN".
 */
export function fieldErrorMessage(
  value: string | undefined,
  locale: Locale,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const messages = MESSAGES[locale];
  switch (value) {
    case "required":
      return messages.errorRequired;
    case "phone":
      return messages.errorPhone;
    case "format":
      return messages.errorFormat;
    default:
      return apiErrorMessage(value, locale);
  }
}
