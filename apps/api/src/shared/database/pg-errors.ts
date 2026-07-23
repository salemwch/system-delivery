/**
 * Narrow reads of a driver error's fields, without asserting a concrete class.
 *
 * postgres.js throws a `PostgresError` carrying SQLSTATE `code` and, for
 * constraint violations, `constraint_name`. We read those defensively rather
 * than importing and instanceof-checking the driver's error type, so the check
 * survives a driver swap.
 */
function pgErrorFields(error: unknown): { code?: string; constraint?: string } {
  // Drizzle wraps the driver error and exposes the original PostgresError (which
  // actually carries `code` / `constraint_name`) as `.cause`, so walk the chain.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    // Safe object→record narrowing to read optional string fields.
    const record = current as Record<string, unknown>;
    const code = typeof record["code"] === "string" ? record["code"] : undefined;
    if (code !== undefined) {
      const constraint =
        typeof record["constraint_name"] === "string" ? record["constraint_name"] : undefined;
      return { code, ...(constraint === undefined ? {} : { constraint }) };
    }
    current = record["cause"];
  }
  return {};
}

/**
 * Whether `error` is a unique-constraint violation (SQLSTATE 23505), optionally
 * for a specific named constraint — so a caller can turn a race-safe DB
 * constraint into a typed `ConflictError` instead of pre-checking with a SELECT
 * (which has a TOCTOU gap).
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const fields = pgErrorFields(error);
  if (fields.code !== "23505") {
    return false;
  }
  return constraint === undefined || fields.constraint === constraint;
}
