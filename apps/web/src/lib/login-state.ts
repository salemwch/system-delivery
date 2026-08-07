import type { FormState } from "./form-state";

export interface MfaState {
  readonly kind: "mfa";
  readonly status: "MFA_REQUIRED" | "MFA_ENROLMENT_REQUIRED";
  readonly challenge: string;
  readonly uri?: string;
  readonly secret?: string;
  /** Inline SVG rendered by the API. The secret never reaches client JS as a URI. */
  readonly qrSvg?: string;
}

export type LoginState = FormState | MfaState;

export function isMfaState(state: LoginState): state is MfaState {
  return "kind" in state && state.kind === "mfa";
}
