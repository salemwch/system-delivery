import type { ZodType } from "zod";

import { ValidationError } from "../errors/domain-error.js";
import type { FieldError } from "./problem-details.filter.js";

/**
 * Parses `value` with a Zod schema, throwing a typed {@link ValidationError}
 * (RFC 9457, 422) on failure instead of raising a raw ZodError.
 *
 * The single place ZodError is translated to the domain's validation error, so
 * it is identical whether validation happens at the HTTP boundary (via
 * ZodValidationPipe) or at a module's service boundary (a service validating an
 * input handed to it by another module). Schemas should be strict so unknown
 * properties are rejected, not stripped (docs/07-security-architecture.md §4.5).
 */
export function parseWithZod<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fieldErrors: FieldError[] = result.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join(".") : "(root)",
      code: issue.code.toUpperCase(),
      detail: issue.message,
    }));
    throw new ValidationError(fieldErrors);
  }
  return result.data;
}
