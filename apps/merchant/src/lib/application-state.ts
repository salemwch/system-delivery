/**
 * The state of the account-application form.
 *
 * ⚠️ `FormState` deliberately cannot express this. There, `error === null` means
 * "not submitted yet OR submitted successfully", which is fine for a settings
 * form whose fields already show what was saved — and useless here, where the
 * ONLY feedback an applicant gets is whether the thing was received. A form that
 * looks identical before and after submitting gets submitted four times.
 *
 * In its own module because a `"use server"` file may export only async
 * functions: a constant or an interface there breaks the build.
 */
export interface ApplicationState {
  /** `sent` renders the confirmation instead of the form. */
  readonly status: "idle" | "sent";
  readonly error: string | null;
  readonly fieldErrors: Readonly<Record<string, string>>;
}

export const IDLE_APPLICATION: ApplicationState = {
  status: "idle",
  error: null,
  fieldErrors: {},
};
