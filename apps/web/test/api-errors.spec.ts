import { describe, expect, it } from "vitest";

import { FIELD_FOR_ERROR, apiErrorMessage, fieldErrorMessage } from "../src/lib/api-errors";
import { MESSAGES } from "../src/lib/i18n";
import type { Locale } from "../src/lib/i18n";

const LOCALES: readonly Locale[] = ["ar", "fr", "en"];

/**
 * Every form used to render one "The request failed" for any non-field error.
 * A registration rejected with MERCHANT_CODE_TAKEN — a one-word fix — looked
 * identical to the database being down, so the user retried the same code and
 * got the same nothing.
 */
describe("apiErrorMessage", () => {
  it("explains a duplicate merchant code instead of saying nothing useful", () => {
    for (const locale of LOCALES) {
      const message = apiErrorMessage("MERCHANT_CODE_TAKEN", locale);
      expect(message).toBe(MESSAGES[locale].errorCodeTaken);
      // The point of the exercise: it must NOT be the generic banner.
      expect(message).not.toBe(MESSAGES[locale].requestFailed);
    }
  });

  it("explains a duplicate email", () => {
    expect(apiErrorMessage("USER_EMAIL_TAKEN", "en")).toBe(MESSAGES.en.errorEmailTaken);
  });

  it("keeps an unmapped code VISIBLE rather than swallowing it", () => {
    // A missing translation must be diagnosable over the phone, and obvious
    // enough that someone adds it.
    const message = apiErrorMessage("SOME_FUTURE_CODE", "en");
    expect(message).toContain("SOME_FUTURE_CODE");
    expect(message).toContain(MESSAGES.en.requestFailed);
  });

  it("has a real translation in every locale for each mapped code", () => {
    for (const locale of LOCALES) {
      for (const code of ["MERCHANT_CODE_TAKEN", "USER_EMAIL_TAKEN", "NOT_FOUND", "FORBIDDEN"]) {
        const message = apiErrorMessage(code, locale);
        expect(message).toBeTruthy();
        expect(message).not.toContain(code);
      }
    }
  });
});

describe("fieldErrorMessage", () => {
  it("translates the client schema's own keys", () => {
    expect(fieldErrorMessage("required", "en")).toBe(MESSAGES.en.errorRequired);
    expect(fieldErrorMessage("phone", "en")).toBe(MESSAGES.en.errorPhone);
    expect(fieldErrorMessage("format", "en")).toBe(MESSAGES.en.errorFormat);
  });

  it("translates an API code routed to a field", () => {
    // Otherwise the box beneath the input reads "MERCHANT_CODE_TAKEN".
    expect(fieldErrorMessage("MERCHANT_CODE_TAKEN", "en")).toBe(MESSAGES.en.errorCodeTaken);
  });

  it("stays undefined when there is no error", () => {
    expect(fieldErrorMessage(undefined, "en")).toBeUndefined();
  });
});

describe("FIELD_FOR_ERROR", () => {
  it("points each mapped error at an input that actually exists on its form", () => {
    expect(FIELD_FOR_ERROR["MERCHANT_CODE_TAKEN"]).toBe("code");
    expect(FIELD_FOR_ERROR["USER_EMAIL_TAKEN"]).toBe("email");
  });
});
