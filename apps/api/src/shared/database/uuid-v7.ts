import { sql } from "drizzle-orm";

import type { TenantTransaction } from "./database.service.js";

/**
 * A UUIDv7 from PostgreSQL's own `uuidv7()` (PG 18, RFC 9562), drawn inside the
 * caller's transaction.
 *
 * For identifiers the application mints before an insert: a ledger
 * `transactionId` grouping several entries, or a delivery `attemptId` published
 * in events. Every table default already uses `uuidv7()`, so this keeps one
 * generator for every persisted id. The alternatives were the `uuid` package
 * (banned by the tool registry without an ADR) or a hand-written RFC 9562
 * implementation. The cost is one round trip, beside inserts the same
 * transaction makes anyway.
 *
 * NOT for opaque security or correlation identifiers (session, refresh family,
 * request id). Those stay `crypto.randomUUID()`: v4's 122 random bits with no
 * embedded creation time is the property they want.
 */
export async function generateUuidV7(tx: TenantTransaction): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`select uuidv7()::text as id`);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("uuidv7() returned no row");
  }
  return row.id;
}
