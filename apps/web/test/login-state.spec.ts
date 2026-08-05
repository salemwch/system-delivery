import { describe, expect, it } from "vitest";

import { isMfaState } from "../src/lib/login-state";
import type { LoginState } from "../src/lib/login-state";

describe("isMfaState", () => {
  it("returns true for MFA_REQUIRED state", () => {
    const state: LoginState = {
      kind: "mfa",
      status: "MFA_REQUIRED",
      challenge: "abc",
    };
    expect(isMfaState(state)).toBe(true);
  });

  it("returns true for MFA_ENROLMENT_REQUIRED state", () => {
    const state: LoginState = {
      kind: "mfa",
      status: "MFA_ENROLMENT_REQUIRED",
      challenge: "abc",
      uri: "otpauth://totp/...",
      secret: "JBSWY3DPEHPK3PXP",
    };
    expect(isMfaState(state)).toBe(true);
  });

  it("returns false for FormState", () => {
    const state: LoginState = { error: null, fieldErrors: {} };
    expect(isMfaState(state)).toBe(false);
  });

  it("returns false for FormState with error", () => {
    const state: LoginState = { error: "invalid", fieldErrors: {} };
    expect(isMfaState(state)).toBe(false);
  });
});
