import type { ZodError } from "zod";

export interface FormState {
  readonly error: string | null;
  readonly fieldErrors: Readonly<Record<string, string>>;
}

export const INITIAL_STATE: FormState = { error: null, fieldErrors: {} };

/**
 * A form result that also carries a credential the server generated.
 *
 * Modelled separately from {@link FormState} because a credential is shown
 * EXACTLY ONCE — it lives in the action's return value and is never fetched
 * again, so it cannot be re-read by reloading the page.
 */
export interface CredentialState extends FormState {
  readonly credential: { readonly email: string; readonly password: string } | null;
}

export const INITIAL_CREDENTIAL_STATE: CredentialState = {
  error: null,
  fieldErrors: {},
  credential: null,
};

/**
 * Flattens Zod issues to one message per field.
 *
 * First issue wins: a field with three problems needs one thing fixed at a
 * time, and rendering all three under the same input is noise.
 */
export function fieldErrorsFrom(error: ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !(field in fieldErrors)) {
      fieldErrors[field] = issue.message;
    }
  }
  return fieldErrors;
}
