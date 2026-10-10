import { createHash } from "node:crypto";

/**
 * A stable SHA-256 fingerprint of a validated command request (invariant I29).
 *
 * Two requests carry the same fingerprint exactly when they ask for the same
 * thing, whatever order the client happened to serialise the fields in. The
 * idempotency key itself is excluded: it names the request, it is not part of
 * what is being asked for.
 *
 * Canonical form:
 *   - object keys sorted; keys whose value is `undefined` dropped (an absent
 *     optional field and an explicitly undefined one are the same request);
 *   - arrays kept in order (order is meaningful: photo keys, scan batches);
 *   - Date → ISO-8601, bigint → decimal string, so the hash never depends on
 *     how a runtime chooses to print them.
 */
export function requestFingerprint(request: Readonly<Record<string, unknown>>): string {
  const { idempotencyKey: _key, ...asked } = request;
  return createHash("sha256").update(canonical(asked)).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
