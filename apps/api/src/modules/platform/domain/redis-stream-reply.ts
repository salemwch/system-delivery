/**
 * Typed parsers for the ioredis stream replies the consumer reads.
 *
 * ioredis returns stream commands as deeply-nested `unknown` arrays. Rather than
 * cast with `any`, these helpers narrow each reply shape defensively — a
 * malformed element yields an empty/skipped result, never a crash and never an
 * unchecked access. Everything downstream then works with real types.
 */

/** One stream entry: its id and its field/value pairs flattened into a map. */
export interface StreamEntry {
  readonly id: string;
  readonly fields: ReadonlyMap<string, string>;
}

/** One XPENDING summary row: the entry id and how many times it has been delivered. */
export interface PendingEntry {
  readonly id: string;
  readonly deliveryCount: number;
}

function isStringArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return null;
}

function asCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/** Turns a `[field, value, field, value, …]` array into a map. */
function fieldsToMap(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!isStringArray(raw)) {
    return map;
  }
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const key = asString(raw[i]);
    const value = asString(raw[i + 1]);
    if (key !== null && value !== null) {
      map.set(key, value);
    }
  }
  return map;
}

/** Parses `[[id, [f, v, …]], …]` (XRANGE / XCLAIM / the entries of XREADGROUP). */
export function parseEntries(raw: unknown): StreamEntry[] {
  if (!isStringArray(raw)) {
    return [];
  }
  const entries: StreamEntry[] = [];
  for (const item of raw) {
    if (!isStringArray(item) || item.length < 2) {
      continue;
    }
    const id = asString(item[0]);
    if (id === null) {
      continue;
    }
    entries.push({ id, fields: fieldsToMap(item[1]) });
  }
  return entries;
}

/**
 * Parses an XREADGROUP reply — `[[streamKey, [[id, [f, v, …]], …]], …]` or null —
 * flattening the (single) stream's entries. A blocking read that times out
 * returns null, which yields an empty array.
 */
export function parseReadGroup(raw: unknown): StreamEntry[] {
  if (!isStringArray(raw)) {
    return [];
  }
  const all: StreamEntry[] = [];
  for (const stream of raw) {
    if (!isStringArray(stream) || stream.length < 2) {
      continue;
    }
    all.push(...parseEntries(stream[1]));
  }
  return all;
}

/**
 * Parses the extended XPENDING reply — `[[id, consumer, idleMs, deliveries], …]`
 * — keeping the id and delivery count that decide retry-vs-DLQ.
 */
export function parsePending(raw: unknown): PendingEntry[] {
  if (!isStringArray(raw)) {
    return [];
  }
  const pending: PendingEntry[] = [];
  for (const item of raw) {
    if (!isStringArray(item) || item.length < 4) {
      continue;
    }
    const id = asString(item[0]);
    if (id === null) {
      continue;
    }
    pending.push({ id, deliveryCount: asCount(item[3]) });
  }
  return pending;
}
