import { Injectable, Logger } from "@nestjs/common";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { DatabaseService, TenantContext, asTenantId } from "../../../shared/database/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { auditLog } from "../domain/schema.js";
import type { AuditEntry } from "../domain/schema.js";
import type { AuditAction } from "../domain/audit-actions.js";

/** Who performed the action. `ANONYMOUS` covers a failed login — the one that matters most. */
export type AuditActorType =
  "USER" | "DRIVER" | "SYSTEM" | "API_CLIENT" | "ANONYMOUS" | "PLATFORM_ADMIN";

export type AuditOutcome = "SUCCESS" | "FAILURE" | "DENIED";

/** A single field's before/after. `null` on either side is a real value: absent. */
export interface FieldChange {
  readonly from: unknown;
  readonly to: unknown;
}

export interface AuditInput {
  readonly action: AuditAction;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly outcome?: AuditOutcome;
  /**
   * Before/after for the fields that matter, chosen by the caller.
   *
   * Deliberately not a diff of two whole rows: this table is retained for seven
   * years, and dumping every column would drag unrelated PII in with it.
   */
  readonly changes?: Readonly<Record<string, FieldChange>>;
  /** Anything that gives the entry meaning but is not a field change. */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Overrides the ambient actor. Used when recording an action against someone else's session. */
  readonly actorType?: AuditActorType;
  readonly actorId?: string | null;
  readonly actorLabel?: string;
  /**
   * Required on UNAUTHENTICATED paths, where there is no ambient context to
   * read from — a rejected login is the important one, and it is precisely the
   * entry a brute-force investigation depends on.
   */
  readonly tenantId?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

/**
 * Filters for reading the trail.
 *
 * Parsed inside the service rather than at the controller, matching the
 * convention used by every other list endpoint here: the service owns its
 * contract, so a second caller cannot bypass the validation.
 */
const auditQuerySchema = z.strictObject({
  resourceType: z.string().trim().min(1).max(64).optional(),
  resourceId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  action: z.string().trim().min(1).max(64).optional(),
  outcome: z.enum(["SUCCESS", "FAILURE", "DENIED"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AuditPage {
  readonly items: readonly AuditEntry[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Runway created at each boot. Three months absorbs a long gap in deploys. */
const PARTITION_MONTHS_AHEAD = 3;

/**
 * Field names whose VALUES must never reach the audit table.
 *
 * Matched case-insensitively as a substring, so `passwordHash`, `newPassword`
 * and `password_hash` are all caught. Deliberately broad: a false positive
 * costs one redacted value in an audit entry, a false negative writes a
 * credential into append-only storage that is kept for seven years and cannot
 * be edited afterwards.
 */
const REDACTED_FIELD_PATTERNS: readonly string[] = [
  "password",
  "secret",
  "token",
  "otp",
  "code",
  "hash",
  "key",
  "credential",
  "authorization",
  "signature",
];

const REDACTED = "[redacted]";

/**
 * The append-only audit trail (docs/07-security-architecture.md §10).
 *
 * ⚠️ `record` takes the CALLER'S transaction, for the same reason
 * {@link OutboxService.publish} does: the audit entry and the action it
 * describes commit together or not at all. An audit written in its own
 * transaction would survive a rolled-back action and claim something happened
 * that did not — and would be lost for an action that succeeded while the
 * audit write failed. Both are worse than no audit trail, because this one is
 * trusted.
 *
 * `write` exists for the narrow case with no business transaction to join —
 * chiefly a rejected login for an unknown email, where there is no row to
 * update and nothing to roll back.
 */
@Injectable()
export class AuditService implements OnApplicationBootstrap {
  /**
   * Instantiated rather than injected so the service stays constructible with
   * nothing but a database — `main.ts` calls `app.useLogger(app.get(Logger))`,
   * so this still writes through Pino at runtime.
   */
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly database: DatabaseService) {}

  /**
   * Creates the coming months' partitions before the first write.
   *
   * Runs on every boot instead of being scheduled with pg_cron, which is not
   * guaranteed to exist in every deployment target. Idempotent, so a rolling
   * deploy of ten replicas does the work once and the rest are no-ops.
   *
   * A failure here must NOT stop the process: the default partition means
   * writes still land, and refusing to boot over a maintenance task would turn
   * a housekeeping problem into an outage. It is logged loudly instead.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await ensureAuditPartitions(this.database, PARTITION_MONTHS_AHEAD);
    } catch (error) {
      this.logger.error(
        { err: error },
        "Failed to ensure audit_log partitions; writes will fall back to the default partition",
      );
    }
  }

  /**
   * Appends an entry using the caller's transaction.
   *
   * @param tx the SAME transaction that carries the change being recorded.
   */
  async record(tx: TenantTransaction, input: AuditInput): Promise<void> {
    await tx.insert(auditLog).values(this.toRow(input));
  }

  /**
   * Appends an entry in its own transaction.
   *
   * Only for actions with no business transaction of their own. Anything that
   * changes a row must use {@link record} instead, or the trail and the data
   * can disagree.
   */
  async write(input: AuditInput): Promise<void> {
    const row = this.toRow(input);
    // Scoped explicitly to the row's own tenant. On the unauthenticated paths
    // that need this method there is no ambient context to fall back on, and
    // `withTenant` would throw before the entry could be written — losing
    // precisely the failed-login records this exists to capture.
    await this.database.withTenant(async (tx) => {
      await tx.insert(auditLog).values(row);
    }, asTenantId(row.tenantId));
  }

  /**
   * Reads the trail. Gated by `audit:read` at the controller.
   *
   * Keyset pagination on `id`: the column is UUIDv7, so ordering by it
   * descending is chronological without a second sort key, and it stays correct
   * across the monthly partitions the table is split into.
   */
  async query(input: unknown = {}): Promise<AuditPage> {
    const params = parseWithZod(auditQuerySchema, input);
    const limit = clampLimit(params.limit);

    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(params.resourceType === undefined
          ? []
          : [eq(auditLog.resourceType, params.resourceType)]),
        ...(params.resourceId === undefined ? [] : [eq(auditLog.resourceId, params.resourceId)]),
        ...(params.actorId === undefined ? [] : [eq(auditLog.actorId, params.actorId)]),
        ...(params.action === undefined ? [] : [eq(auditLog.action, params.action)]),
        ...(params.outcome === undefined ? [] : [eq(auditLog.outcome, params.outcome)]),
        ...(params.from === undefined ? [] : [gte(auditLog.createdAt, params.from)]),
        ...(params.to === undefined ? [] : [lte(auditLog.createdAt, params.to)]),
        ...(params.cursor === undefined ? [] : [lt(auditLog.id, params.cursor)]),
      ];

      const rows = await tx
        .select()
        .from(auditLog)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(auditLog.id))
        .limit(limit + 1);

      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  /**
   * Builds the row, filling actor and origin from the ambient request context.
   *
   * Taking these from context rather than from the caller is what stops an
   * audit entry naming the wrong person: the values come from the verified
   * token and from Fastify, not from an argument a call site could get wrong.
   */
  private toRow(input: AuditInput): typeof auditLog.$inferInsert {
    const ctx = TenantContext.current();
    // The explicit value wins, because the paths that pass one have no ambient
    // context at all rather than a different one.
    const tenantId = input.tenantId ?? TenantContext.requireTenantId();
    const ipAddress = input.ipAddress ?? ctx?.ipAddress;
    const userAgent = input.userAgent ?? ctx?.userAgent;

    const actorType = input.actorType ?? mapActorType(ctx?.actorType);
    // `null` is meaningful — an explicit "no actor", as on an anonymous
    // failure — so only `undefined` falls through to the ambient value.
    const actorId = input.actorId === undefined ? (ctx?.actorId ?? null) : input.actorId;

    return {
      tenantId,
      actorType,
      actorId,
      ...(input.actorLabel === undefined ? {} : { actorLabel: input.actorLabel }),
      action: input.action,
      outcome: input.outcome ?? "SUCCESS",
      resourceType: input.resourceType,
      ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      changes: redactChanges(input.changes),
      context: redactRecord(input.context ?? {}),
      ...(ipAddress === undefined ? {} : { ipAddress }),
      ...(userAgent === undefined ? {} : { userAgent }),
      ...(ctx?.requestId === undefined ? {} : { correlationId: ctx.requestId }),
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(limit)));
}

function isRedactedField(field: string): boolean {
  const lowered = field.toLowerCase();
  return REDACTED_FIELD_PATTERNS.some((pattern) => lowered.includes(pattern));
}

function redactChanges(
  changes: Readonly<Record<string, FieldChange>> | undefined,
): Record<string, FieldChange> {
  if (changes === undefined) {
    return {};
  }
  const output: Record<string, FieldChange> = {};
  for (const [field, change] of Object.entries(changes)) {
    output[field] = isRedactedField(field)
      ? // The FACT that a credential changed is exactly what an audit trail is
        // for; its value is exactly what must never be in one.
        { from: REDACTED, to: REDACTED }
      : { from: change.from, to: change.to };
  }
  return output;
}

function redactRecord(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    output[key] = isRedactedField(key) ? REDACTED : value;
  }
  return output;
}

/** Maps the lower-case ambient actor type onto the audit vocabulary. */
function mapActorType(actorType: string | undefined): AuditActorType {
  switch (actorType) {
    case "user":
      return "USER";
    case "driver":
      return "DRIVER";
    case "api_client":
      return "API_CLIENT";
    case "system":
      return "SYSTEM";
    default:
      // No bound actor at all. Not an error: background work and rejected
      // logins both legitimately reach here, and both must still be recorded.
      return "SYSTEM";
  }
}

/**
 * Creates the coming months' partitions, idempotently.
 *
 * Called at startup rather than scheduled with pg_cron, which is not guaranteed
 * to exist in every deployment target. Runs unscoped because partitions are
 * DDL, not tenant data.
 *
 * @returns how many partitions were created — 0 on a normal boot.
 */
export async function ensureAuditPartitions(
  database: DatabaseService,
  monthsAhead = 3,
): Promise<number> {
  return database.withoutTenantScope(async (tx) => {
    const rows = await tx.execute(
      sql`select ensure_audit_log_partitions(${monthsAhead}) as created`,
    );
    const first: unknown = rows[0];
    if (typeof first === "object" && first !== null && "created" in first) {
      // `in` has already narrowed the property into existence; the driver types
      // it as unknown because a raw statement has no schema to map from.
      const { created } = first;
      return typeof created === "number" ? created : Number(created);
    }
    return 0;
  });
}
