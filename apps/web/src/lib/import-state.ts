import type { FormState } from "./form-state";

/**
 * The shape of an import result.
 *
 * Its own module because `import-actions.ts` is `"use server"`, and Next allows
 * only async function exports from those — a plain const there is a build
 * error, not a warning.
 */

export interface ImportRowError {
  /** 1-based and counting the header — the line number the user sees in Excel. */
  readonly line: number;
  readonly message: string;
}

export interface ImportState extends FormState {
  readonly succeeded: number;
  readonly failed: number;
  readonly rowErrors: readonly ImportRowError[];
}

export const INITIAL_IMPORT_STATE: ImportState = {
  error: null,
  fieldErrors: {},
  succeeded: 0,
  failed: 0,
  rowErrors: [],
};
