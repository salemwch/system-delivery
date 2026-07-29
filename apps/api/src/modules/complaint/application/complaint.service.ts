import { Injectable } from "@nestjs/common";
import { and, desc, eq, isNotNull, lt, lte, sql } from "drizzle-orm";

import { AuditService, OutboxService } from "../../platform/index.js";
import { LedgerService } from "../../finance/index.js";
import { ShipmentService } from "../../shipment/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import {
  assignComplaintSchema,
  commentComplaintSchema,
  createComplaintSchema,
  listComplaintsQuerySchema,
  setSlaPolicySchema,
  transitionComplaintSchema,
} from "../domain/dtos.js";
import {
  DEFAULT_COMPLAINT_SLA_HOURS,
  TERMINAL_COMPLAINT_STATUSES,
  canComplaintTransition,
  toComplaintStatus,
  toComplaintType,
} from "../domain/complaint-status.js";
import type { ComplaintStatus, ComplaintType } from "../domain/complaint-status.js";
import { complaintActivity, complaintSlaPolicies, complaints } from "../domain/schema.js";
import type { Complaint, ComplaintActivityRow } from "../domain/schema.js";
import { formatComplaintCode } from "../domain/complaint-code.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** How many times to retry a code collision before giving up. */
const CODE_ALLOCATION_ATTEMPTS = 5;

export interface ComplaintPage {
  readonly items: readonly Complaint[];
  readonly nextCursor: string | null;
}

export interface ComplaintDetail {
  readonly complaint: Complaint;
  readonly activity: readonly ComplaintActivityRow[];
}

/**
 * Who is performing the action.
 *
 * Both fields are optional because they default from the ambient request
 * context. A call site that forgets to pass an actor still records the right
 * person, rather than writing an anonymous entry into a trail whose whole value
 * is saying who decided what.
 */
export interface ComplaintActor {
  readonly userId?: string;
  readonly actorType?: "STAFF" | "MERCHANT" | "RECIPIENT";
}

/**
 * Complaints / réclamations (docs/02-domain-model.md §3.20).
 *
 * Not a support inbox. In a COD market a complaint is frequently a claim on
 * money, and `type = COD_DISPUTE` is the mechanism that answers hotspot H8 —
 * what happens to collected cash when a delivery is later disputed.
 *
 * ⚠️ The answer is a REVERSING ledger transaction, never an edit. The original
 * COD_COLLECTED entries stay exactly as posted; the reversal is a new balanced
 * transaction that moves the money back. An accounting record that can be
 * amended is not a record, and the one moment it will be scrutinised is the
 * dispute itself.
 *
 * Three invariants this service is responsible for, each also backed by the
 * database:
 *
 *  - **No closure without an outcome** (rule 2). Enforced by a CHECK constraint
 *    as well, because a rule that lives only in a service method erodes.
 *  - **The activity trail is append-only** (rule 5). UPDATE and DELETE are
 *    revoked from `dp_app`.
 *  - **A reversal happens at most once.** `reversal_transaction_id` is set in the
 *    same transaction that posts it.
 */
@Injectable()
export class ComplaintService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly shipments: ShipmentService,
  ) {}

  async create(input: unknown, rawActor: ComplaintActor = {}): Promise<Complaint> {
    const dto = parseWithZod(createComplaintSchema, input);
    const actor = this.resolveActor(rawActor);

    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();

      // Idempotency first: the driver app and the merchant portal both retry, and
      // a duplicated complaint splits one dispute into two half-investigations.
      // The UNIQUE index is the real guarantee — this fast path just avoids the
      // wasted work of a doomed insert.
      const replay = await this.findByIdempotencyKey(tx, dto.idempotencyKey);
      if (replay !== null) {
        return replay;
      }

      // A shipment named by a complaint must be one this caller can see. RLS
      // already narrows the read, so a merchant naming a rival's parcel gets a
      // NotFoundError rather than a leak (rule 1).
      let resolvedMerchantId = dto.merchantId;
      if (dto.shipmentId !== undefined) {
        const shipment = await this.shipments.getById(dto.shipmentId);
        // Inherited rather than trusted from the request: it is what the RLS
        // merchant narrowing keys on, so a caller must not be able to set it to
        // someone else's merchant and hide the complaint from the right party.
        resolvedMerchantId = shipment.merchantId ?? dto.merchantId;
      }

      const slaHours = await this.slaHoursFor(tx, dto.type);

      const row = await this.insertWithCode(tx, {
        tenantId,
        idempotencyKey: dto.idempotencyKey,
        type: dto.type,
        severity: dto.severity ?? "MEDIUM",
        description: dto.description,
        raisedByType: dto.raisedByType,
        status: "OPEN",
        slaDueAt: new Date(Date.now() + slaHours * 3_600_000),
        ...(dto.shipmentId === undefined ? {} : { shipmentId: dto.shipmentId }),
        ...(resolvedMerchantId === undefined ? {} : { merchantId: resolvedMerchantId }),
        ...(dto.recipientId === undefined ? {} : { recipientId: dto.recipientId }),
        ...(dto.driverId === undefined ? {} : { driverId: dto.driverId }),
        ...(actor.userId === undefined ? {} : { raisedById: actor.userId }),
        ...(dto.attachmentKeys === undefined ? {} : { attachmentKeys: [...dto.attachmentKeys] }),
      });

      await this.appendActivity(tx, row, {
        kind: "STATUS_CHANGED",
        toStatus: "OPEN",
        note: `Complaint raised (${dto.type})`,
        actor,
      });

      await this.outbox.publish(tx, {
        eventType: "complaint.raised",
        aggregateType: "complaint",
        aggregateId: row.id,
        payload: {
          code: row.code,
          type: row.type,
          severity: row.severity,
          shipmentId: row.shipmentId,
          merchantId: row.merchantId,
          recipientId: row.recipientId,
          driverId: row.driverId,
          raisedByType: row.raisedByType,
          slaDueAt: row.slaDueAt?.toISOString() ?? null,
        },
      });

      return row;
    });
  }

  /**
   * Moves a complaint through its lifecycle, and — for a COD_DISPUTE resolved in
   * the complainant's favour — reverses the collected cash.
   *
   * The status change, the activity entry, the reversal and the event all commit
   * in ONE transaction. A reversal that survived a rolled-back resolution would
   * move money for a dispute the record says is still open.
   */
  async transition(id: string, input: unknown, rawActor: ComplaintActor = {}): Promise<Complaint> {
    const dto = parseWithZod(transitionComplaintSchema, input);
    const actor = this.resolveActor(rawActor);

    return this.database.withTenant(async (tx) => {
      const current = await this.loadForUpdate(tx, id);
      const from = toComplaintStatus(current.status);

      // Idempotent replay: the same key against this complaint is the caller
      // retrying, not a second decision. Critical for `reverseCod` — a retried
      // resolution must not move the money twice.
      const replayed = await this.findActivityByKey(tx, id, dto.idempotencyKey);
      if (replayed !== null) {
        return current;
      }

      // ⚠️ The terminal check comes BEFORE the same-status short-circuit, and the
      // order is the point. A second `RESOLVED` under a NEW key is not a retry —
      // it is a fresh decision on a closed case, and treating it as a harmless
      // no-op would silently swallow a request to reverse the money again.
      if (TERMINAL_COMPLAINT_STATUSES.has(from)) {
        throw new BusinessRuleError(
          "COMPLAINT_ALREADY_CLOSED",
          `Complaint ${current.code} is ${from} and cannot be reopened. Raise a new complaint referencing it.`,
        );
      }

      // Re-requesting a non-terminal status the complaint already holds is a
      // genuine no-op: nothing changed and nothing is owed.
      if (from === dto.status) {
        return current;
      }

      if (!canComplaintTransition(from, dto.status)) {
        throw new BusinessRuleError(
          "COMPLAINT_INVALID_TRANSITION",
          `Cannot move a complaint from ${from} to ${dto.status}.`,
        );
      }

      const closing = dto.status === "RESOLVED" || dto.status === "REJECTED";

      let reversalTransactionId: string | null = null;
      if (dto.reverseCod === true) {
        reversalTransactionId = await this.reverseCod(tx, current, actor);
      }

      const updated = await tx
        .update(complaints)
        .set({
          status: dto.status,
          ...(dto.resolution === undefined ? {} : { resolution: dto.resolution }),
          ...(closing
            ? {
                resolvedAt: sql`now()`,
                ...(actor.userId === undefined ? {} : { resolvedByUserId: actor.userId }),
              }
            : {}),
          ...(reversalTransactionId === null ? {} : { reversalTransactionId }),
          updatedAt: sql`now()`,
        })
        .where(eq(complaints.id, id))
        .returning();

      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError("Complaint");
      }

      await this.appendActivity(tx, row, {
        kind: "STATUS_CHANGED",
        fromStatus: from,
        toStatus: dto.status,
        ...(dto.note === undefined ? {} : { note: dto.note }),
        idempotencyKey: dto.idempotencyKey,
        actor,
      });

      if (reversalTransactionId !== null) {
        await this.appendActivity(tx, row, {
          kind: "REVERSAL_POSTED",
          note: `COD reversed — ledger transaction ${reversalTransactionId}`,
          actor,
        });
      }

      if (closing) {
        await this.outbox.publish(tx, {
          eventType: "complaint.resolved",
          aggregateType: "complaint",
          aggregateId: row.id,
          payload: {
            code: row.code,
            type: row.type,
            status: row.status,
            shipmentId: row.shipmentId,
            merchantId: row.merchantId,
            codReversed: reversalTransactionId !== null,
            // Whether the promise was kept. Cheaper to record here than to
            // recompute across a partitioned history later.
            slaBreached: row.slaDueAt !== null && row.slaDueAt.getTime() < Date.now(),
          },
        });
      }

      return row;
    });
  }

  async assign(id: string, input: unknown, rawActor: ComplaintActor = {}): Promise<Complaint> {
    const dto = parseWithZod(assignComplaintSchema, input);
    const actor = this.resolveActor(rawActor);

    return this.database.withTenant(async (tx) => {
      const current = await this.loadForUpdate(tx, id);
      if (TERMINAL_COMPLAINT_STATUSES.has(toComplaintStatus(current.status))) {
        throw new BusinessRuleError(
          "COMPLAINT_ALREADY_CLOSED",
          "A closed complaint cannot be reassigned.",
        );
      }

      const updated = await tx
        .update(complaints)
        .set({ assignedToUserId: dto.assignedToUserId, updatedAt: sql`now()` })
        .where(eq(complaints.id, id))
        .returning();

      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError("Complaint");
      }

      await this.appendActivity(tx, row, {
        kind: "ASSIGNED",
        note: dto.note ?? `Assigned to ${dto.assignedToUserId}`,
        actor,
      });

      return row;
    });
  }

  /** Adds a comment. Comments are entries, never edits to the description. */
  async comment(id: string, input: unknown, rawActor: ComplaintActor = {}): Promise<void> {
    const dto = parseWithZod(commentComplaintSchema, input);
    const actor = this.resolveActor(rawActor);

    await this.database.withTenant(async (tx) => {
      const current = await this.loadForUpdate(tx, id);
      await this.appendActivity(tx, current, {
        kind: "COMMENT",
        note: dto.note,
        actor,
      });
    });
  }

  async getById(id: string): Promise<ComplaintDetail> {
    return this.database.withTenant(async (tx) => {
      const complaint = await this.loadForUpdate(tx, id, false);
      const activity = await tx
        .select()
        .from(complaintActivity)
        .where(eq(complaintActivity.complaintId, id))
        .orderBy(complaintActivity.createdAt);
      return { complaint, activity };
    });
  }

  async list(query: unknown): Promise<ComplaintPage> {
    const params = parseWithZod(listComplaintsQuerySchema, query);
    const limit = clampLimit(params.limit);

    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(params.status === undefined ? [] : [eq(complaints.status, params.status)]),
        ...(params.type === undefined ? [] : [eq(complaints.type, params.type)]),
        ...(params.severity === undefined ? [] : [eq(complaints.severity, params.severity)]),
        ...(params.shipmentId === undefined ? [] : [eq(complaints.shipmentId, params.shipmentId)]),
        ...(params.merchantId === undefined ? [] : [eq(complaints.merchantId, params.merchantId)]),
        ...(params.assignedToUserId === undefined
          ? []
          : [eq(complaints.assignedToUserId, params.assignedToUserId)]),
        ...(params.overdueOnly === true
          ? [
              isNotNull(complaints.slaDueAt),
              lte(complaints.slaDueAt, new Date()),
              sql`${complaints.status} not in ('RESOLVED','REJECTED')`,
            ]
          : []),
        ...(params.cursor === undefined ? [] : [lt(complaints.id, params.cursor)]),
      ];

      const rows = await tx
        .select()
        .from(complaints)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        // UUIDv7, so id descending is chronological with no second sort key.
        .orderBy(desc(complaints.id))
        .limit(limit + 1);

      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  /** Sets the SLA hours for a complaint type. Config as data (rule 6). */
  async setSlaPolicy(input: unknown): Promise<void> {
    const dto = parseWithZod(setSlaPolicySchema, input);

    await this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      await tx
        .insert(complaintSlaPolicies)
        .values({ tenantId, type: dto.type, dueHours: dto.dueHours })
        .onConflictDoUpdate({
          target: [complaintSlaPolicies.tenantId, complaintSlaPolicies.type],
          set: { dueHours: dto.dueHours, updatedAt: sql`now()` },
        });
    });
  }

  /**
   * Resolves the acting user, preferring the explicit argument and falling back
   * to the ambient request context — the same source AuditService reads, so the
   * two never disagree about who acted.
   */
  private resolveActor(actor: ComplaintActor): ComplaintActor {
    const ctx = TenantContext.current();
    const userId = actor.userId ?? ctx?.actorId;
    return {
      ...(userId === undefined ? {} : { userId }),
      // A merchant scope in the context means the caller IS a merchant — the
      // trail must say that, not "STAFF", when the case is reviewed.
      actorType: actor.actorType ?? (ctx?.merchantId === undefined ? "STAFF" : "MERCHANT"),
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Posts the reversing transaction for a COD dispute.
   *
   * ⚠️ Reads the ORIGINAL COD_COLLECTED entries and mirrors them with the
   * directions swapped, rather than recomputing from the shipment's COD amount.
   * The amount actually collected may differ from the amount ordered — a partial
   * collection, a later adjustment — and reversing a figure that was never
   * posted leaves the ledger unbalanced against reality.
   *
   * Idempotent by `reversal_transaction_id`: a second attempt is refused rather
   * than posting the money back twice.
   */
  private async reverseCod(
    tx: TenantTransaction,
    complaint: Complaint,
    actor: ComplaintActor,
  ): Promise<string> {
    if (toComplaintType(complaint.type) !== "COD_DISPUTE") {
      throw new BusinessRuleError(
        "COMPLAINT_NOT_COD_DISPUTE",
        "Only a COD_DISPUTE can reverse collected cash.",
      );
    }
    if (complaint.reversalTransactionId !== null) {
      throw new ConflictError(
        "COMPLAINT_ALREADY_REVERSED",
        `Complaint ${complaint.code} has already reversed its COD.`,
      );
    }
    if (complaint.shipmentId === null) {
      throw new BusinessRuleError(
        "COMPLAINT_NO_SHIPMENT",
        "A COD reversal needs the shipment whose cash is being returned.",
      );
    }

    const original = await this.ledger.entriesFor(tx, {
      shipmentId: complaint.shipmentId,
      entryType: "COD_COLLECTED",
    });

    if (original.length === 0) {
      throw new BusinessRuleError(
        "COMPLAINT_NO_COD_TO_REVERSE",
        "No COD was collected for this shipment, so there is nothing to reverse.",
      );
    }

    const tenantId = TenantContext.requireTenantId();
    const currency = original[0]?.currency;
    if (currency === undefined) {
      throw new BusinessRuleError(
        "COMPLAINT_NO_COD_TO_REVERSE",
        "Original entries have no currency.",
      );
    }

    return this.ledger.postTransaction(tx, {
      tenantId,
      entryType: "REVERSAL",
      currency,
      shipmentId: complaint.shipmentId,
      description: `COD reversed — complaint ${complaint.code}`,
      ...(actor.userId === undefined ? {} : { createdByUserId: actor.userId }),
      // Every original line, mirrored. Balanced by construction: the original
      // was balanced, and swapping every direction preserves that.
      lines: original.map((entry) => ({
        account: entry.account,
        direction: entry.direction === "DEBIT" ? ("CREDIT" as const) : ("DEBIT" as const),
        amountMinor: entry.amountMinor,
      })),
    });
  }

  /**
   * Inserts with a generated code, retrying on collision.
   *
   * The code embeds the date and a per-tenant-per-day ordinal, so two
   * simultaneous complaints can race for the same one. A unique violation is the
   * race resolving itself — retry rather than pre-checking, which has a TOCTOU
   * gap of its own.
   */
  private async insertWithCode(
    tx: TenantTransaction,
    values: Omit<typeof complaints.$inferInsert, "code">,
  ): Promise<Complaint> {
    for (let attempt = 0; attempt < CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
      const ordinal = await this.nextOrdinal(tx);
      const code = formatComplaintCode(new Date(), ordinal + attempt);
      try {
        const inserted = await tx
          .insert(complaints)
          .values({ ...values, code })
          .returning();
        const row = inserted[0];
        if (row === undefined) {
          throw new Error("Complaint insert returned no row");
        }
        return row;
      } catch (error) {
        // A code collision is the race resolving itself — retry with the next
        // ordinal. An idempotency collision is a concurrent retry of the SAME
        // request, so return what the winner created.
        if (isUniqueViolation(error, "complaints_tenant_idempotency_uq")) {
          const winner = await this.findByIdempotencyKey(tx, values.idempotencyKey);
          if (winner !== null) {
            return winner;
          }
        }
        if (!isUniqueViolation(error, "complaints_tenant_code_uq")) {
          throw error;
        }
      }
    }
    throw new ConflictError(
      "COMPLAINT_CODE_ALLOCATION_FAILED",
      "Could not allocate a unique complaint code; please retry.",
    );
  }

  private async findByIdempotencyKey(
    tx: TenantTransaction,
    idempotencyKey: string,
  ): Promise<Complaint | null> {
    const rows = await tx
      .select()
      .from(complaints)
      .where(eq(complaints.idempotencyKey, idempotencyKey))
      .limit(1);
    return rows[0] ?? null;
  }

  /** How many complaints this tenant has raised today. */
  private async nextOrdinal(tx: TenantTransaction): Promise<number> {
    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(complaints)
      .where(sql`${complaints.createdAt} >= date_trunc('day', now())`);
    return (rows[0]?.count ?? 0) + 1;
  }

  private async slaHoursFor(tx: TenantTransaction, type: ComplaintType): Promise<number> {
    const rows = await tx
      .select({ dueHours: complaintSlaPolicies.dueHours })
      .from(complaintSlaPolicies)
      .where(eq(complaintSlaPolicies.type, type))
      .limit(1);
    return rows[0]?.dueHours ?? DEFAULT_COMPLAINT_SLA_HOURS[type];
  }

  /**
   * Loads a complaint, optionally locking it.
   *
   * `FOR UPDATE` on every mutation: two dispatchers resolving the same complaint
   * at once would otherwise both read OPEN, both pass the transition check, and
   * both append a closing entry — and if both set `reverseCod`, the money would
   * move twice.
   */
  private async loadForUpdate(tx: TenantTransaction, id: string, lock = true): Promise<Complaint> {
    const query = tx.select().from(complaints).where(eq(complaints.id, id)).limit(1);
    const rows = await (lock ? query.for("update") : query);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Complaint");
    }
    return row;
  }

  private async findActivityByKey(
    tx: TenantTransaction,
    complaintId: string,
    idempotencyKey: string,
  ): Promise<ComplaintActivityRow | null> {
    const rows = await tx
      .select()
      .from(complaintActivity)
      .where(
        and(
          eq(complaintActivity.complaintId, complaintId),
          eq(complaintActivity.note, `idempotency:${idempotencyKey}`),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async appendActivity(
    tx: TenantTransaction,
    complaint: Complaint,
    entry: {
      kind: string;
      fromStatus?: ComplaintStatus;
      toStatus?: ComplaintStatus;
      note?: string;
      idempotencyKey?: string;
      actor: ComplaintActor;
    },
  ): Promise<void> {
    await tx.insert(complaintActivity).values({
      tenantId: complaint.tenantId,
      complaintId: complaint.id,
      kind: entry.kind,
      ...(entry.fromStatus === undefined ? {} : { fromStatus: entry.fromStatus }),
      ...(entry.toStatus === undefined ? {} : { toStatus: entry.toStatus }),
      ...(entry.note === undefined ? {} : { note: entry.note }),
      actorType: entry.actor.actorType ?? "STAFF",
      ...(entry.actor.userId === undefined ? {} : { actorId: entry.actor.userId }),
    });

    if (entry.idempotencyKey !== undefined) {
      await tx.insert(complaintActivity).values({
        tenantId: complaint.tenantId,
        complaintId: complaint.id,
        kind: "COMMENT",
        note: `idempotency:${entry.idempotencyKey}`,
        actorType: entry.actor.actorType ?? "STAFF",
      });
    }

    // Status changes and reversals are audited; ordinary comments are not. The
    // audit trail is for actions that change what is true, and it stays useful
    // only if it is not diluted with chatter.
    if (entry.kind === "STATUS_CHANGED" || entry.kind === "REVERSAL_POSTED") {
      await this.audit.record(tx, {
        action: entry.kind === "REVERSAL_POSTED" ? "ledger.adjusted" : "shipment.status_overridden",
        resourceType: "complaint",
        resourceId: complaint.id,
        ...(entry.fromStatus === undefined || entry.toStatus === undefined
          ? {}
          : { changes: { status: { from: entry.fromStatus, to: entry.toStatus } } }),
        context: {
          code: complaint.code,
          type: complaint.type,
          ...(entry.note === undefined ? {} : { note: entry.note }),
        },
      });
    }
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(limit)));
}
