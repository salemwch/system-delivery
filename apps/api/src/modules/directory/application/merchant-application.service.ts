import { Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { AuditService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import {
  approveApplicationSchema,
  listApplicationsSchema,
  rejectApplicationSchema,
  submitApplicationSchema,
} from "../domain/dtos.js";
import { merchantApplications } from "../domain/schema.js";
import type { MerchantApplication } from "../domain/schema.js";
import { MerchantService } from "./merchant.service.js";

export interface ApplicationPage {
  readonly items: readonly MerchantApplication[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * How many applications one tenant accepts per hour from the public form.
 *
 * The per-phone unique index already stops the same applicant resubmitting; this
 * is the second wall, against someone iterating phone numbers. Set well above
 * any plausible real rate — a courier signing thirty new shippers in one hour is
 * having an extraordinary day, not being attacked — because the cost of a false
 * positive is a lost customer.
 */
const PUBLIC_SUBMISSIONS_PER_HOUR = 30;

/**
 * Nouveaux clients — the queue of shippers asking to be taken on.
 *
 * ⚠️ `submit` IS REACHABLE WITHOUT AUTHENTICATION. Three things make that
 * acceptable, and removing any one of them makes it not:
 *
 *  1. The row can only land in the tenant the request resolved to — RLS
 *     `WITH CHECK`, not application code.
 *  2. One PENDING application per phone per tenant, enforced by a partial unique
 *     index. A duplicate is reported to the caller as SUCCESS: an anonymous
 *     endpoint that says "you already applied" is an oracle for testing whether
 *     a phone number is known to this courier.
 *  3. A per-tenant hourly cap, against someone iterating numbers.
 *
 * Nothing here reads back. `submit` returns void by design — there is no
 * identifier, no status, and no confirmation of anything the caller did not
 * already know.
 */
@Injectable()
export class MerchantApplicationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly merchants: MerchantService,
  ) {}

  /**
   * Records an application. Unauthenticated when it comes from the public form.
   *
   * @param source PUBLIC_FORM applies the hourly cap; STAFF does not — a
   *   commercial logging ten leads after a market visit is the intended use.
   */
  async submit(input: unknown, source: "PUBLIC_FORM" | "STAFF" = "PUBLIC_FORM"): Promise<void> {
    const dto = parseWithZod(submitApplicationSchema, input);

    try {
      await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();

        if (source === "PUBLIC_FORM") {
          await this.assertUnderHourlyCap(tx);
        }

        await tx.insert(merchantApplications).values({
          tenantId,
          source,
          businessName: dto.businessName,
          contactName: dto.contactName,
          contactPhone: dto.contactPhone,
          ...(dto.contactEmail === undefined ? {} : { contactEmail: dto.contactEmail }),
          ...(dto.city === undefined ? {} : { city: dto.city }),
          ...(dto.addressLine === undefined ? {} : { addressLine: dto.addressLine }),
          ...(dto.expectedVolume === undefined ? {} : { expectedVolume: dto.expectedVolume }),
          ...(dto.message === undefined ? {} : { message: dto.message }),
        });
      });
    } catch (error) {
      // ⚠️ SWALLOWED ON PURPOSE, and only this one constraint. A second
      // application from a phone that already has one pending is indistinguishable
      // to the caller from the first — otherwise the endpoint answers "is this
      // number known to you?" for anyone who asks.
      if (isUniqueViolation(error, "merchant_applications_pending_phone_uq")) {
        return;
      }
      throw error;
    }
  }

  async list(input: unknown = {}): Promise<ApplicationPage> {
    const dto = parseWithZod(listApplicationsSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    // The queue reads oldest-first — the one waiting longest is the one to
    // answer — while history reads newest-first. The cursor comparison has to
    // follow the sort, or paging skips rows.
    const oldestFirst = (dto.status ?? "PENDING") === "PENDING";

    return this.database.withTenant(async (tx) => {
      const conditions: SQL[] = [
        ...(dto.status === undefined ? [] : [eq(merchantApplications.status, dto.status)]),
        ...(dto.cursor === undefined
          ? []
          : [
              oldestFirst
                ? gt(merchantApplications.id, dto.cursor)
                : lt(merchantApplications.id, dto.cursor),
            ]),
      ];

      const rows = await tx
        .select()
        .from(merchantApplications)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(oldestFirst ? asc(merchantApplications.id) : desc(merchantApplications.id))
        .limit(limit + 1);

      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  async getById(id: string): Promise<MerchantApplication> {
    return this.database.withTenant((tx) => this.requirePending(tx, id, false));
  }

  /** How many are waiting, for the sidebar badge. */
  async pendingCount(): Promise<number> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ pending: count() })
        .from(merchantApplications)
        .where(eq(merchantApplications.status, "PENDING"));
      return Number(rows[0]?.pending ?? 0);
    });
  }

  /**
   * Approve: the application becomes a merchant.
   *
   * ⚠️ NOT in one transaction with the merchant insert, and that is deliberate.
   * `MerchantService.create` opens its own `withTenant` and publishes
   * `merchant.created` to the outbox inside it; wrapping it here would nest a
   * transaction and the outbox row would commit under a different boundary than
   * the row it describes.
   *
   * The consequence is a window where the merchant exists and the application
   * still says PENDING. That is the SAFE direction to fail: a retried approval
   * finds the application still pending and creates a second merchant, which an
   * operator can see and merge — whereas the reverse would mark an application
   * approved with no merchant behind it, which nothing in the UI could explain.
   * The `merchants_tenant_code_uq` index makes the retry fail loudly whenever a
   * code was supplied.
   */
  async approve(id: string, input: unknown, actorUserId: string): Promise<MerchantApplication> {
    const dto = parseWithZod(approveApplicationSchema, input);

    const application = await this.database.withTenant((tx) => this.requirePending(tx, id, true));

    const merchant = await this.merchants.create({
      name: dto.name ?? application.businessName,
      ...(dto.code === undefined ? {} : { code: dto.code }),
      contactName: application.contactName,
      contactPhone: application.contactPhone,
      ...(application.contactEmail === null ? {} : { contactEmail: application.contactEmail }),
    });

    return this.database.withTenant(async (tx) => {
      const updated = await tx
        .update(merchantApplications)
        .set({
          status: "APPROVED",
          merchantId: merchant.id,
          decidedAt: sql`now()`,
          decidedByUserId: actorUserId,
          updatedAt: sql`now()`,
        })
        // Re-check the status inside the UPDATE: two operators approving the
        // same lead at the same moment both passed the read above, and only the
        // one that finds it still PENDING may write.
        .where(
          and(eq(merchantApplications.id, id), eq(merchantApplications.status, "PENDING")),
        )
        .returning();

      const row = updated[0];
      if (row === undefined) {
        throw new BusinessRuleError(
          "APPLICATION_ALREADY_DECIDED",
          "This application was decided by someone else while you were reviewing it.",
        );
      }

      await this.audit.record(tx, {
        action: "merchant.application_approved",
        resourceType: "merchant_application",
        resourceId: id,
        changes: { status: { from: "PENDING", to: "APPROVED" } },
        context: {
          merchantId: merchant.id,
          businessName: application.businessName,
          source: application.source,
        },
      });

      return row;
    });
  }

  /** Reject, with a reason the applicant could be read back. */
  async reject(id: string, input: unknown, actorUserId: string): Promise<MerchantApplication> {
    const dto = parseWithZod(rejectApplicationSchema, input);

    return this.database.withTenant(async (tx) => {
      const application = await this.requirePending(tx, id, true);

      const updated = await tx
        .update(merchantApplications)
        .set({
          status: "REJECTED",
          decidedAt: sql`now()`,
          decidedByUserId: actorUserId,
          decisionReason: dto.reason,
          updatedAt: sql`now()`,
        })
        .where(and(eq(merchantApplications.id, id), eq(merchantApplications.status, "PENDING")))
        .returning();

      const row = updated[0];
      if (row === undefined) {
        throw new BusinessRuleError(
          "APPLICATION_ALREADY_DECIDED",
          "This application was decided by someone else while you were reviewing it.",
        );
      }

      await this.audit.record(tx, {
        action: "merchant.application_rejected",
        resourceType: "merchant_application",
        resourceId: id,
        changes: { status: { from: "PENDING", to: "REJECTED" } },
        context: { reason: dto.reason, businessName: application.businessName },
      });

      return row;
    });
  }

  private async requirePending(
    tx: TenantTransaction,
    id: string,
    mustBePending: boolean,
  ): Promise<MerchantApplication> {
    const rows = await tx
      .select()
      .from(merchantApplications)
      .where(eq(merchantApplications.id, id))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Merchant application");
    }
    if (mustBePending && row.status !== "PENDING") {
      throw new BusinessRuleError(
        "APPLICATION_ALREADY_DECIDED",
        `This application is already ${row.status.toLowerCase()}.`,
      );
    }
    return row;
  }

  /** The second wall on the public form: a per-tenant ceiling per hour. */
  private async assertUnderHourlyCap(tx: TenantTransaction): Promise<void> {
    const rows = await tx
      .select({ recent: count() })
      .from(merchantApplications)
      .where(
        and(
          eq(merchantApplications.source, "PUBLIC_FORM"),
          gte(merchantApplications.createdAt, sql`now() - interval '1 hour'`),
        ),
      );

    if (Number(rows[0]?.recent ?? 0) >= PUBLIC_SUBMISSIONS_PER_HOUR) {
      // A real error, unlike the duplicate case: this one is not about a
      // specific applicant, so saying so leaks nothing about who has applied.
      throw new BusinessRuleError(
        "APPLICATIONS_RATE_LIMITED",
        "Too many applications have been received recently. Please try again later.",
      );
    }
  }
}
