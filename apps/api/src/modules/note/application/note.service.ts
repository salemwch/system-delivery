import { Injectable } from "@nestjs/common";
import { and, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { DatabaseService, TenantContext, isForeignKeyViolation } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { NotFoundError, ValidationError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { createNoteSchema, listNotesSchema, updateNoteSchema } from "../domain/dtos.js";
import type { SubjectType } from "../domain/dtos.js";
import { notes } from "../domain/schema.js";
import type { Note } from "../domain/schema.js";

/** A note with its subject flattened back into the pair the API speaks. */
export interface NoteView {
  readonly id: string;
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  readonly body: string;
  readonly authorUserId: string;
  readonly authorName: string | null;
  readonly pinned: boolean;
  readonly resolvedAt: Date | null;
  readonly resolvedByUserId: string | null;
  readonly createdAt: Date;
}

export interface NotePage {
  readonly items: readonly NoteView[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * Remarques — what staff record about a parcel, a merchant or a driver.
 *
 * Two properties carry the whole feature:
 *
 *  1. **A written note never changes.** The trigger in migration 0035 refuses an
 *     edit to the body, the subject or the author. The value of the log is that
 *     Tuesday's entry still says what it said on Tuesday.
 *  2. **The subject is a real foreign key.** Three exclusive columns rather than
 *     a polymorphic id, so a note cannot point at a row that does not exist —
 *     and this module never reads the shipment, merchant or driver contexts to
 *     find that out.
 */
@Injectable()
export class NoteService {
  constructor(private readonly database: DatabaseService) {}

  async create(input: unknown, authorUserId: string): Promise<NoteView> {
    const dto = parseWithZod(createNoteSchema, input);

    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        const inserted = await tx
          .insert(notes)
          .values({
            tenantId,
            body: dto.body,
            authorUserId,
            ...columnFor(dto.subjectType, dto.subjectId),
            ...(dto.pinned === undefined ? {} : { pinned: dto.pinned }),
          })
          .returning({ id: notes.id });

        const row = inserted[0];
        if (row === undefined) {
          throw new Error("Note insert returned no row");
        }
        return this.requireById(tx, row.id);
      });
    } catch (error) {
      // A subject id that does not exist — or belongs to another tenant, which
      // the FK sees as the same thing. Reported as a field error, not a 500:
      // the caller sent a bad id and can fix it.
      if (isForeignKeyViolation(error)) {
        throw new ValidationError(
          [{ field: "subjectId", code: "NOT_FOUND", detail: "The subject does not exist." }],
          "The subject of this note does not exist.",
        );
      }
      throw error;
    }
  }

  /**
   * Pin, unpin, resolve or reopen. The body is not editable — see 0035.
   *
   * Resolving stamps both the time and the actor: `notes_resolution_chk` treats
   * them as a pair, because a resolution with no resolver records nothing.
   */
  async update(id: string, input: unknown, actorUserId: string): Promise<NoteView> {
    const dto = parseWithZod(updateNoteSchema, input);

    return this.database.withTenant(async (tx) => {
      const updated = await tx
        .update(notes)
        .set({
          ...(dto.pinned === undefined ? {} : { pinned: dto.pinned }),
          ...(dto.resolved === undefined
            ? {}
            : dto.resolved
              ? { resolvedAt: sql`now()`, resolvedByUserId: actorUserId }
              : { resolvedAt: null, resolvedByUserId: null }),
        })
        .where(eq(notes.id, id))
        .returning({ id: notes.id });

      if (updated[0] === undefined) {
        throw new NotFoundError("Note");
      }
      return this.requireById(tx, id);
    });
  }

  async getById(id: string): Promise<NoteView> {
    return this.database.withTenant((tx) => this.requireById(tx, id));
  }

  /**
   * The queue, or one subject's panel.
   *
   * Defaults to OPEN notes: the sidebar count and this list must be the same
   * set, and "everything ever written" is not a queue.
   */
  async list(input: unknown = {}): Promise<NotePage> {
    const dto = parseWithZod(listNotesSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;

    return this.database.withTenant(async (tx) => {
      const conditions: SQL[] = [
        dto.resolved === true ? isNotNull(notes.resolvedAt) : isNull(notes.resolvedAt),
        ...(dto.authorUserId === undefined ? [] : [eq(notes.authorUserId, dto.authorUserId)]),
        ...subjectFilter(dto.subjectType, dto.subjectId),
        // Keyset on a UUIDv7 id, which orders by time — so `desc` is newest
        // first and the cursor needs no separate timestamp.
        ...(dto.cursor === undefined ? [] : [lt(notes.id, dto.cursor)]),
      ];

      const rows = await selectViews(tx, and(...conditions), limit + 1);
      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  /** How many notes are open, for the sidebar badge. */
  async openCount(): Promise<number> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(notes)
        .where(isNull(notes.resolvedAt));
      return rows[0]?.count ?? 0;
    });
  }

  private async requireById(tx: TenantTransaction, id: string): Promise<NoteView> {
    const rows = await selectViews(tx, eq(notes.id, id), 1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Note");
    }
    return row;
  }
}

/**
 * The author's name, resolved in the SAME query.
 *
 * A note list without names is unreadable, and fetching them per row is the
 * N+1 this join exists to avoid. `users` is joined by raw SQL rather than by
 * importing the identity module's table object: the note context depends on
 * `identity` for its auth decorators only, and reaching for its schema would
 * make that a data dependency too.
 */
async function selectViews(
  tx: TenantTransaction,
  where: SQL | undefined,
  limit: number,
): Promise<NoteView[]> {
  const rows = await tx
    .select({
      id: notes.id,
      shipmentId: notes.shipmentId,
      merchantId: notes.merchantId,
      driverId: notes.driverId,
      body: notes.body,
      authorUserId: notes.authorUserId,
      authorName: sql<
        string | null
      >`(select u.full_name from users u where u.id = ${notes.authorUserId})`,
      pinned: notes.pinned,
      resolvedAt: notes.resolvedAt,
      resolvedByUserId: notes.resolvedByUserId,
      createdAt: notes.createdAt,
    })
    .from(notes)
    .where(where)
    // Pinned first, then newest. The same order the partial indexes are built
    // in, so a subject panel reads straight off the index.
    .orderBy(desc(notes.pinned), desc(notes.id))
    .limit(limit);

  return rows.map((row) => {
    const subject = subjectOf(row);
    return {
      id: row.id,
      subjectType: subject.type,
      subjectId: subject.id,
      body: row.body,
      authorUserId: row.authorUserId,
      authorName: row.authorName,
      pinned: row.pinned,
      resolvedAt: row.resolvedAt,
      resolvedByUserId: row.resolvedByUserId,
      createdAt: row.createdAt,
    };
  });
}

/** DTO subject → the one column that holds it. */
function columnFor(type: SubjectType, id: string): Partial<Pick<Note, "shipmentId" | "merchantId" | "driverId">> {
  switch (type) {
    case "SHIPMENT":
      return { shipmentId: id };
    case "MERCHANT":
      return { merchantId: id };
    case "DRIVER":
      return { driverId: id };
  }
}

/** Row → the subject pair. Exhaustive because the CHECK guarantees one is set. */
function subjectOf(row: {
  shipmentId: string | null;
  merchantId: string | null;
  driverId: string | null;
}): { type: SubjectType; id: string } {
  if (row.shipmentId !== null) {
    return { type: "SHIPMENT", id: row.shipmentId };
  }
  if (row.merchantId !== null) {
    return { type: "MERCHANT", id: row.merchantId };
  }
  if (row.driverId !== null) {
    return { type: "DRIVER", id: row.driverId };
  }
  // Unreachable while `notes_one_subject_chk` exists. Thrown rather than
  // defaulted: a note with no subject is corrupt data, and hiding it behind a
  // placeholder would put it in every queue at once.
  throw new Error("Note row has no subject");
}

/**
 * Filtering by subject needs BOTH halves or neither.
 *
 * A type without an id would list every note about any shipment, which on a
 * subject panel means showing another parcel's remarks. Rejected at the DTO
 * level would be better still, but the pair is optional as a whole — so the one
 * place that can see both enforces it.
 */
function subjectFilter(type: SubjectType | undefined, id: string | undefined): SQL[] {
  if (type === undefined || id === undefined) {
    if (type !== undefined || id !== undefined) {
      throw new ValidationError(
        [
          {
            field: "subjectId",
            code: "REQUIRED",
            detail: "subjectType and subjectId must be given together.",
          },
        ],
        "An incomplete subject filter would list another subject's notes.",
      );
    }
    return [];
  }
  switch (type) {
    case "SHIPMENT":
      return [eq(notes.shipmentId, id)];
    case "MERCHANT":
      return [eq(notes.merchantId, id)];
    case "DRIVER":
      return [eq(notes.driverId, id)];
  }
}
