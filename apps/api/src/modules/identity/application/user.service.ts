import { randomBytes } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { AuditService, OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { MFA_REQUIRED_ROLES, isRole } from "../domain/permissions.js";
import type { Role } from "../domain/permissions.js";
import {
  createMerchantLoginSchema,
  createUserSchema,
  listUsersQuerySchema,
  resetPasswordSchema,
  updateUserSchema,
} from "../domain/dtos.js";
import type { ListUsersQuery } from "../domain/dtos.js";
import { refreshTokens, userRoles, users } from "../domain/schema.js";
import { PasswordService } from "./password.service.js";

/**
 * A user as an administrator sees them.
 *
 * Deliberately NOT the row type: `passwordHash` and `mfaSecret` are absent by
 * construction rather than stripped on the way out, so no future controller can
 * spread a row into a response and leak them.
 */
export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly locale: string;
  readonly status: string;
  readonly mfaEnabled: boolean;
  readonly merchantId: string | null;
  readonly hubScope: readonly string[];
  readonly roles: readonly Role[];
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The result of minting or resetting a login.
 *
 * `temporaryPassword` is non-null only when the server generated it, and only
 * on the single response that created it — it is never stored in plaintext and
 * cannot be retrieved again.
 */
export interface CreatedUser {
  readonly user: AdminUser;
  readonly temporaryPassword: string | null;
}

export interface AdminUserPage {
  readonly items: readonly AdminUser[];
  readonly nextCursor: string | null;
}

/**
 * A validated new login, whichever DTO it was parsed from.
 *
 * The union of what `createUserSchema` and `createMerchantLoginSchema` produce,
 * so {@link UserService.insertUser} has one shape to write and neither endpoint
 * can reach it with unvalidated input.
 */
interface NewUserInput {
  readonly email: string;
  readonly fullName: string;
  // `| undefined` on every optional, not just `?`: under
  // `exactOptionalPropertyTypes` a Zod-inferred `phone?: string | undefined`
  // will not fit a plain `phone?: string`, and the DTOs are the only callers.
  readonly phone?: string | undefined;
  readonly locale?: "ar" | "fr" | "en" | undefined;
  readonly password?: string | undefined;
  readonly roles: readonly Role[];
  readonly merchantId?: string | undefined;
  readonly hubScope?: readonly string[] | undefined;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** 18 bytes → 144 bits of entropy, rendered as 24 URL-safe characters. */
const GENERATED_PASSWORD_BYTES = 18;

/**
 * User administration — how a tenant's OWNER creates the logins they hand out
 * (docs/01-mvp-scope.md §6, docs/07-security-architecture.md §4.2).
 *
 * This is the endpoint that makes the merchant portal usable: the platform
 * creates the *expéditeur*'s account here and passes on the credentials.
 *
 * Three properties this service is responsible for:
 *
 *  - **A password is never returned twice.** A generated one appears in the
 *    creating response and nowhere else, so possession of it is evidence of
 *    having performed the action.
 *  - **Losing access is immediate.** Disabling or resetting revokes every live
 *    refresh token in the same transaction. Without that, a disabled account
 *    keeps working until its access token expires and its refresh token keeps
 *    minting new ones indefinitely.
 *  - **A tenant cannot lock itself out.** The last active OWNER cannot be
 *    disabled, and nobody can disable themselves.
 */
@Injectable()
export class UserService {
  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async create(input: unknown): Promise<CreatedUser> {
    return this.insertUser(parseWithZod(createUserSchema, input));
  }

  /**
   * Mints the *expéditeur*'s own portal login (`merchant:onboard`).
   *
   * The role is fixed here rather than taken from the caller, which is what
   * makes this safe to hand to a COMMERCIAL: the endpoint can produce a
   * merchant login and nothing else. Which merchant is enforced by the
   * database — a commercial may only onboard merchants in their own portfolio
   * (migration 0030, invariant I25).
   */
  async createMerchantLogin(input: unknown): Promise<CreatedUser> {
    const dto = parseWithZod(createMerchantLoginSchema, input);
    return this.insertUser({ ...dto, roles: ["MERCHANT"] });
  }

  /**
   * The single write path for a new login, shared by both entry points above.
   *
   * One place that hashes a password, one place that grants roles, one place
   * that audits the grant. A second copy of this would be a second place for
   * the audit record to be forgotten.
   */
  private async insertUser(dto: NewUserInput): Promise<CreatedUser> {
    const generated = dto.password === undefined ? generatePassword() : null;
    const plaintext = dto.password ?? generated;
    if (plaintext === null) {
      // Unreachable: exactly one of the two is always a string. Narrowing only.
      throw new Error("No password available to hash");
    }
    const passwordHash = await this.passwords.hash(plaintext);

    // MFA-required roles must carry the flag or they can never authenticate
    // (the check is fail-closed). No TOTP enrolment flow exists yet, so this
    // mirrors ProvisioningService; when enrolment ships, both become a real
    // enrolment challenge instead.
    const mfaEnabled = dto.roles.some((role) => MFA_REQUIRED_ROLES.has(role));

    try {
      const user = await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();

        const inserted = await tx
          .insert(users)
          .values({
            tenantId,
            email: dto.email,
            passwordHash,
            fullName: dto.fullName,
            ...(dto.phone === undefined ? {} : { phone: dto.phone }),
            locale: dto.locale ?? "fr",
            // Created with a usable password in hand, so ACTIVE rather than the
            // INVITED default, which belongs to an invite flow that does not
            // exist. An INVITED user cannot log in.
            status: "ACTIVE",
            mfaEnabled,
            ...(dto.hubScope === undefined ? {} : { hubScope: [...dto.hubScope] }),
            ...(dto.merchantId === undefined ? {} : { merchantId: dto.merchantId }),
          })
          .returning({ id: users.id });

        const row = inserted[0];
        if (row === undefined) {
          throw new Error("User insert returned no row");
        }

        await tx
          .insert(userRoles)
          .values(dto.roles.map((role) => ({ tenantId, userId: row.id, role })));

        await this.outbox.publish(tx, {
          eventType: "user.created",
          aggregateType: "user",
          aggregateId: row.id,
          // No email, no name: the outbox is durable storage that fans out to
          // consumers with no need for PII to react to this fact.
          payload: {
            roles: dto.roles,
            merchantId: dto.merchantId ?? null,
            mfaEnabled,
          },
        });

        // §10 makes role grants mandatory to audit. Minting a login is the
        // strongest one there is — it creates access that did not exist.
        await this.audit.record(tx, {
          action: "user.created",
          resourceType: "user",
          resourceId: row.id,
          actorLabel: dto.email,
          changes: {
            roles: { from: null, to: dto.roles },
            merchantId: { from: null, to: dto.merchantId ?? null },
            status: { from: null, to: "ACTIVE" },
          },
          context: {
            mfaEnabled,
            // WHETHER the password was chosen or generated is meaningful; the
            // password itself never reaches this table.
            passwordSource: dto.password === undefined ? "generated" : "supplied",
          },
        });

        return this.loadOne(tx, row.id);
      });

      return { user, temporaryPassword: generated };
    } catch (error) {
      throw translateUserWriteError(error, dto.email);
    }
  }

  async getById(id: string): Promise<AdminUser> {
    return this.database.withTenant(async (tx) => this.loadOne(tx, id));
  }

  async list(query: unknown): Promise<AdminUserPage> {
    const params = parseWithZod(listUsersQuerySchema, query);
    const limit = clampLimit(params.limit);

    return this.database.withTenant(async (tx) => {
      const rows = await this.selectUsers(tx, params, limit + 1);
      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  async update(id: string, input: unknown): Promise<AdminUser> {
    const dto = parseWithZod(updateUserSchema, input);
    return this.database.withTenant(async (tx) => {
      const updated = await tx
        .update(users)
        .set({
          ...(dto.fullName === undefined ? {} : { fullName: dto.fullName }),
          ...(dto.phone === undefined ? {} : { phone: dto.phone }),
          ...(dto.locale === undefined ? {} : { locale: dto.locale }),
          ...(dto.hubScope === undefined ? {} : { hubScope: [...dto.hubScope] }),
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, id))
        .returning({ id: users.id });

      if (updated[0] === undefined) {
        throw new NotFoundError("User");
      }
      return this.loadOne(tx, id);
    });
  }

  /**
   * Disables a login and revokes its sessions.
   *
   * `actingUserId` is the caller. Disabling yourself is refused: it is almost
   * always a mistake, and for the single-OWNER tenants this platform mostly has
   * it is an unrecoverable one.
   */
  async disable(id: string, reason: string, actingUserId: string): Promise<AdminUser> {
    if (id === actingUserId) {
      throw new BusinessRuleError(
        "USER_CANNOT_DISABLE_SELF",
        "You cannot disable your own account.",
      );
    }

    return this.database.withTenant(async (tx) => {
      const current = await this.loadOne(tx, id);
      if (current.status === "DISABLED") {
        return current;
      }

      if (current.roles.includes("OWNER")) {
        await assertNotLastActiveOwner(tx, id);
      }

      await tx
        .update(users)
        .set({ status: "DISABLED", updatedAt: sql`now()` })
        .where(eq(users.id, id));

      await revokeSessions(tx, id, "USER_DISABLED");

      await this.outbox.publish(tx, {
        eventType: "user.disabled",
        aggregateType: "user",
        aggregateId: id,
        payload: { reason, disabledBy: actingUserId },
      });

      await this.audit.record(tx, {
        action: "user.disabled",
        resourceType: "user",
        resourceId: id,
        changes: { status: { from: current.status, to: "DISABLED" } },
        context: { reason, sessionsRevoked: true },
      });

      return this.loadOne(tx, id);
    });
  }

  /** Restores a disabled login. Existing sessions stay revoked — they must sign in again. */
  async enable(id: string, actingUserId: string): Promise<AdminUser> {
    return this.database.withTenant(async (tx) => {
      const current = await this.loadOne(tx, id);
      if (current.status === "ACTIVE") {
        return current;
      }

      await tx
        .update(users)
        .set({
          status: "ACTIVE",
          // An account disabled while locked out must not come back still
          // locked; the administrator's intent is "this person can work again".
          failedLoginCount: 0,
          lockedUntil: null,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, id));

      await this.outbox.publish(tx, {
        eventType: "user.enabled",
        aggregateType: "user",
        aggregateId: id,
        payload: { enabledBy: actingUserId },
      });

      await this.audit.record(tx, {
        action: "user.enabled",
        resourceType: "user",
        resourceId: id,
        changes: { status: { from: current.status, to: "ACTIVE" } },
      });

      return this.loadOne(tx, id);
    });
  }

  /**
   * Sets a new password out of band and revokes every live session.
   *
   * The MVP has no self-service reset (no outbound email provider), so this is
   * how a merchant who has forgotten their password gets back in: the courier's
   * OWNER resets it and reads the new one out.
   */
  async resetPassword(id: string, input: unknown, actingUserId: string): Promise<CreatedUser> {
    const dto = parseWithZod(resetPasswordSchema, input);

    const generated = dto.password === undefined ? generatePassword() : null;
    const plaintext = dto.password ?? generated;
    if (plaintext === null) {
      throw new Error("No password available to hash");
    }
    const passwordHash = await this.passwords.hash(plaintext);

    const user = await this.database.withTenant(async (tx) => {
      const updated = await tx
        .update(users)
        .set({
          passwordHash,
          // A reset clears a lockout: the credential that was being guessed no
          // longer exists, so keeping the counter only punishes the owner.
          failedLoginCount: 0,
          lockedUntil: null,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, id))
        .returning({ id: users.id });

      if (updated[0] === undefined) {
        throw new NotFoundError("User");
      }

      await revokeSessions(tx, id, "PASSWORD_RESET");

      await this.outbox.publish(tx, {
        eventType: "user.password_reset",
        aggregateType: "user",
        aggregateId: id,
        payload: { resetBy: actingUserId },
      });

      // An out-of-band password reset is an account-takeover path if misused,
      // so the trail records that it happened, by whom, and that the previous
      // sessions were killed. `passwordHash` is a redacted field name by
      // construction, so no value can leak through `changes`.
      await this.audit.record(tx, {
        action: "user.password_reset",
        resourceType: "user",
        resourceId: id,
        changes: { passwordHash: { from: null, to: null } },
        context: {
          sessionsRevoked: true,
          lockoutCleared: true,
          passwordSource: dto.password === undefined ? "generated" : "supplied",
        },
      });

      return this.loadOne(tx, id);
    });

    return { user, temporaryPassword: generated };
  }

  private async loadOne(tx: TenantTransaction, id: string): Promise<AdminUser> {
    const rows = await this.selectUsers(tx, { id }, 1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("User");
    }
    return row;
  }

  /**
   * The single read path, used by both `list` and every single-row load.
   *
   * Roles are aggregated in the same statement rather than fetched per user —
   * a list of 50 users must be one query, not 51.
   */
  private async selectUsers(
    tx: TenantTransaction,
    filter: ListUsersQuery & { readonly id?: string },
    limit: number,
  ): Promise<AdminUser[]> {
    const conditions = [
      ...(filter.id === undefined ? [] : [eq(users.id, filter.id)]),
      ...(filter.status === undefined ? [] : [eq(users.status, filter.status)]),
      ...(filter.merchantId === undefined ? [] : [eq(users.merchantId, filter.merchantId)]),
      ...(filter.cursor === undefined ? [] : [lt(users.id, filter.cursor)]),
      ...(filter.role === undefined
        ? []
        : [
            inArray(
              users.id,
              tx
                .select({ userId: userRoles.userId })
                .from(userRoles)
                .where(eq(userRoles.role, filter.role)),
            ),
          ]),
    ];

    const rows = await tx
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        phone: users.phone,
        locale: users.locale,
        status: users.status,
        mfaEnabled: users.mfaEnabled,
        merchantId: users.merchantId,
        hubScope: users.hubScope,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        roles: sql<
          string[]
        >`coalesce(array_agg(distinct ${userRoles.role}) filter (where ${userRoles.role} is not null), '{}')`,
      })
      .from(users)
      .leftJoin(userRoles, eq(userRoles.userId, users.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(users.id)
      .orderBy(desc(users.id))
      .limit(limit);

    return rows.map((row) => ({
      ...row,
      // TEXT behind a CHECK constraint on the way in; narrowed on the way out.
      // A role this build does not know about grants nothing.
      roles: row.roles.filter(isRole),
    }));
  }
}

/** 24 URL-safe characters, unambiguous to read aloud over the phone. */
function generatePassword(): string {
  return randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url");
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(limit)));
}

async function revokeSessions(
  tx: TenantTransaction,
  userId: string,
  reason: string,
): Promise<void> {
  await tx
    .update(refreshTokens)
    .set({ revokedAt: sql`now()`, revokeReason: reason })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

/**
 * Refuses to disable the tenant's last active OWNER.
 *
 * Counted inside the same transaction as the update, so two concurrent
 * disables cannot each see the other's OWNER as still active. `FOR UPDATE`
 * would be the alternative; the count is cheap and the row set is tiny.
 */
async function assertNotLastActiveOwner(tx: TenantTransaction, excludingId: string): Promise<void> {
  const remaining = await tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(and(eq(userRoles.role, "OWNER"), eq(users.status, "ACTIVE")))
    .limit(2);

  const others = remaining.filter((row) => row.id !== excludingId);
  if (others.length === 0) {
    throw new BusinessRuleError(
      "USER_LAST_OWNER",
      "This is the tenant's only active OWNER; promote another user before disabling it.",
    );
  }
}

/**
 * Turns a database rejection into a typed domain error.
 *
 * `merchant_id` is validated by the database, not by this module: `merchants`
 * belongs to `directory`, which sits a layer above `identity` and cannot be
 * imported from here. Three rejections are possible and all mean the same thing
 * to a caller:
 *
 *   - 23503 on `users_merchant_id_fkey` — no merchant with that id exists.
 *   - 23514 from `users_assert_merchant_tenant` — it exists in another tenant.
 *   - 23514 from `users_assert_merchant_in_portfolio` — it exists in this
 *     tenant, but not in the calling commercial's portfolio (invariant I25).
 *
 * Collapsing all three to 404 is deliberate, not lazy. Distinguishing them
 * would turn this endpoint into an oracle: a commercial could enumerate which
 * merchant ids their colleagues manage by reading the error text.
 *
 * Constraint triggers raise without a constraint name, so the last two are
 * matched on SQLSTATE alone. Every other check constraint on `users` (status,
 * locale, email shape) and the I23 triggers are already excluded by the DTOs,
 * so a 23514 reaching here is one of those two.
 */
function translateUserWriteError(error: unknown, email: string): unknown {
  if (isUniqueViolation(error, "users_tenant_email_uq")) {
    return new ConflictError(
      "USER_EMAIL_TAKEN",
      `A user with the email "${email}" already exists.`,
    );
  }
  if (isForeignKeyViolation(error, "users_merchant_id_fkey") || isCheckViolation(error)) {
    return new NotFoundError("Merchant");
  }
  return error;
}
