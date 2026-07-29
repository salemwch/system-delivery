import { Injectable } from "@nestjs/common";
import { and, sql } from "drizzle-orm";
import { z } from "zod";

import { DatabaseService } from "../../../shared/database/index.js";
import { ValidationError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { shipments } from "../domain/schema.js";

/**
 * One person a merchant has shipped to.
 *
 * Every field is derived from the merchant's OWN shipments. Nothing here is
 * read from the `recipients` table, so nothing here can disclose a rival's
 * activity — including the counters, which are this merchant's history with
 * this person and not the tenant-wide totals `recipients` maintains.
 */
export interface AddressBookEntry {
  /** E.164. The identity of a person in MENA (docs/02-domain-model.md §3.19). */
  readonly phone: string;
  /** The name as written on the most recent parcel. */
  readonly fullName: string;
  /** The shared Recipient this resolved to, for callers that may read it. */
  readonly recipientId: string | null;
  /** Where the most recent parcel went — the sensible default for the next one. */
  readonly lastDestinationAddressId: string | null;
  readonly totalShipments: number;
  readonly delivered: number;
  /**
   * Parcels that came back. Deliberately not called "failed": ATTEMPT_FAILED is
   * a retry, not an outcome, and counting it would tell a merchant a buyer
   * refuses when in fact the courier is still trying.
   */
  readonly returned: number;
  readonly lastShipmentAt: Date;
}

export interface AddressBookPage {
  readonly items: readonly AddressBookEntry[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const querySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  cursor: z.string().min(1).optional(),
  /** Matches a phone prefix or any part of the name. */
  q: z.string().trim().min(2, "search needs at least 2 characters").max(64).optional(),
});

/**
 * The merchant's address book — the people they have shipped to.
 *
 * Resolves open decision RM-R1 (docs/02-domain-model.md §3.19). A merchant must
 * not read the tenant's shared `recipients` table: it holds every rival's
 * buyers, and it is not merchant-scoped. But "the people I have shipped to" is
 * exactly a projection of my own shipments, and migration 0020 already narrows
 * `shipments` to `merchant_id` inside RLS — so this view is bounded by the
 * database, not by a WHERE clause a future query might forget.
 *
 * Every shipment keeps its own recipient snapshot (§3.19 rule 2), so the
 * projection needs no join back to `recipients`.
 *
 * Callers who are not merchants (a dispatcher, an owner) have no merchant
 * narrowing applied, so they see the tenant's book. That is the same data their
 * `recipient:read` permission already grants them, arranged differently.
 */
@Injectable()
export class AddressBookService {
  constructor(private readonly database: DatabaseService) {}

  async list(input: unknown): Promise<AddressBookPage> {
    const params = parseWithZod(querySchema, input);
    const limit = params.limit ?? DEFAULT_PAGE_SIZE;
    const cursor = params.cursor === undefined ? null : decodeCursor(params.cursor);

    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(params.q === undefined
          ? []
          : [
              sql`(${shipments.recipientPhone} like ${`${params.q}%`}
                   or ${shipments.recipientName} ilike ${`%${params.q}%`})`,
            ]),
      ];

      // Keyset pagination over an aggregate: the ordering key is the group's
      // newest parcel, so the cursor has to be compared in HAVING rather than
      // WHERE. Row-value comparison keeps it a single, correct predicate — the
      // two-column form written as ORs is where these paginators lose rows.
      //
      // The timestamp is bound as text and cast in SQL: a JS Date bound
      // directly into a raw fragment is a documented trap in this codebase.
      const having =
        cursor === null
          ? undefined
          : sql`(max(${shipments.createdAt}), ${shipments.recipientPhone})
                < (${cursor.lastShipmentAt}::timestamptz, ${cursor.phone})`;

      const rows = await tx
        .select({
          phone: shipments.recipientPhone,
          /**
           * The cursor token, kept separate from `lastShipmentAt` on purpose.
           *
           * A JS `Date` holds milliseconds; `timestamptz` holds microseconds.
           * Round-tripping the cursor through `toISOString()` would truncate,
           * and a keyset paginator that truncates its own key silently repeats
           * or skips the row on the boundary.
           *
           * Rendered explicitly as ISO-8601 UTC with microseconds rather than
           * via `::text`, which formats in the SESSION's TimeZone — a replica
           * configured to anything but UTC would emit `+05:30` and hand out
           * cursors this endpoint then rejects.
           */
          cursorAt: sql<string>`to_char(max(${shipments.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          // The name on the newest parcel wins — people correct spellings, and
          // a lexical max() would freeze the first one ever typed.
          fullName: sql<string>`(array_agg(${shipments.recipientName} order by ${shipments.createdAt} desc))[1]`,
          recipientId: sql<
            string | null
          >`(array_agg(${shipments.recipientId} order by ${shipments.createdAt} desc))[1]`,
          lastDestinationAddressId: sql<
            string | null
          >`(array_agg(${shipments.destinationAddressId} order by ${shipments.createdAt} desc))[1]`,
          totalShipments: sql<number>`count(*)::int`,
          delivered: sql<number>`count(*) filter (where ${shipments.status} = 'DELIVERED')::int`,
          returned: sql<number>`count(*) filter (where ${shipments.status} = 'RETURNED')::int`,
          // `.mapWith` runs the driver's own timestamptz mapper. Without it an
          // aggregate comes back as a raw string, and typing it as `Date` would
          // be an assertion that lies — it fails at the first `.toISOString()`.
          lastShipmentAt: sql`max(${shipments.createdAt})`.mapWith(shipments.createdAt),
        })
        .from(shipments)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(shipments.recipientPhone)
        .having(having)
        .orderBy(sql`max(${shipments.createdAt}) desc, ${shipments.recipientPhone} desc`)
        .limit(limit + 1);

      if (rows.length > limit) {
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(toEntry),
          nextCursor: last === undefined ? null : encodeCursor(last.cursorAt, last.phone),
        };
      }
      return { items: rows.map(toEntry), nextCursor: null };
    });
  }
}

/** Drops the internal cursor token — it is not part of the public entry. */
function toEntry(row: AddressBookEntry & { readonly cursorAt: string }): AddressBookEntry {
  const { cursorAt: _cursorAt, ...entry } = row;
  return entry;
}

function malformedCursor(): ValidationError {
  return new ValidationError(
    [{ field: "cursor", code: "invalid", detail: "Cursor is not a value this endpoint issued." }],
    "Malformed cursor.",
  );
}

interface Cursor {
  readonly lastShipmentAt: string;
  readonly phone: string;
}

function encodeCursor(cursorAt: string, phone: string): string {
  return Buffer.from(`${cursorAt}|${phone}`, "utf8").toString("base64url");
}

/**
 * Decodes an opaque cursor.
 *
 * A malformed cursor is a client error, not a server one: without this it would
 * reach the database as a broken timestamp cast and surface as a 500.
 */
function decodeCursor(raw: string): Cursor {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator <= 0) {
    throw malformedCursor();
  }
  const timestamp = decoded.slice(0, separator);
  const phone = decoded.slice(separator + 1);
  // Shape-checked rather than run through `Date.parse`, which would silently
  // discard the microseconds this cursor exists to preserve. The value is bound
  // as a parameter and cast by Postgres — never interpolated into SQL.
  if (phone.length === 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(timestamp)) {
    throw malformedCursor();
  }
  return { lastShipmentAt: timestamp, phone };
}
