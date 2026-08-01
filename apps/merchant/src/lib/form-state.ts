/**
 * The shape a server action returns to a form.
 *
 * ⚠️ In its own module because a `"use server"` file may export ONLY async
 * functions — every export there becomes a callable server endpoint, so a
 * constant or an interface breaks the build.
 */

export interface FormState {
  /** `null` means "not submitted yet", not "succeeded". */
  readonly error: string | null;
  /** Field name to message, so an error renders beside the input that caused it. */
  readonly fieldErrors: Readonly<Record<string, string>>;
}

export const EMPTY_FORM_STATE: FormState = { error: null, fieldErrors: {} };
