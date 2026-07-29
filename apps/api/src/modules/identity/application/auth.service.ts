import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { AuditService } from "../../platform/index.js";
import { DatabaseService, asTenantId } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { isRole, permissionsForRoles } from "../domain/permissions.js";
import type { Role } from "../domain/permissions.js";
import { refreshTokens, userRoles, users } from "../domain/schema.js";
import { PasswordService } from "./password.service.js";
import { TokenService } from "./token.service.js";
import type { Principal } from "./token.service.js";

/**
 * Authentication: credential verification, session issuance, refresh rotation.
 *
 * Every failure path returns the same opaque outcome to the caller. Whether an
 * email is unknown, the password is wrong, the account is disabled, or it is
 * locked out, the client sees one indistinguishable result — anything else is a
 * user-enumeration oracle (docs/07-security-architecture.md §3.1).
 */

/** Why an authentication attempt failed. For audit logs, never for the client. */
export type AuthFailureReason =
  | "UNKNOWN_USER"
  | "BAD_PASSWORD"
  | "ACCOUNT_DISABLED"
  | "ACCOUNT_LOCKED"
  | "TENANT_INACTIVE"
  | "MFA_REQUIRED";

export type AuthResult =
  | { readonly ok: true; readonly session: AuthSession }
  | { readonly ok: false; readonly reason: AuthFailureReason };

export interface AuthSession {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
  readonly principal: Principal;
}

export interface LoginRequest {
  readonly tenantId: string;
  readonly email: string;
  readonly password: string;
  readonly deviceId?: string;
  readonly userAgent?: string;
  readonly ipAddress?: string;
}

/** Lockout policy: exponential backoff, capped. Permanent lockout is itself a DoS. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_BASE_SECONDS = 30;
const LOCKOUT_MAX_SECONDS = 900;

function lockoutDurationSeconds(failedCount: number): number {
  const excess = Math.max(0, failedCount - MAX_FAILED_ATTEMPTS);
  return Math.min(LOCKOUT_BASE_SECONDS * 2 ** excess, LOCKOUT_MAX_SECONDS);
}

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async login(request: LoginRequest): Promise<AuthResult> {
    const tenantId = asTenantId(request.tenantId);
    const email = request.email.trim().toLowerCase();

    return this.database.withTenant(async (tx) => {
      const found = await tx
        .select()
        .from(users)
        .where(sql`${users.tenantId} = ${tenantId} and lower(${users.email}) = ${email}`)
        .limit(1);

      const user = found[0];

      // Every rejection below is audited before it is returned (§10 makes
      // authentication FAILURE mandatory, not just success). The response
      // itself stays deliberately uniform — the audit trail records the real
      // reason, the caller is never told which one it was.
      const auditFailure = async (
        reason: AuthFailureReason,
        userId: string | null,
      ): Promise<void> => {
        await this.audit.record(tx, {
          action: "auth.login_failed",
          outcome: "FAILURE",
          resourceType: "user",
          ...(userId === null ? {} : { resourceId: userId }),
          actorType: userId === null ? "ANONYMOUS" : "USER",
          actorId: userId,
          // The attempted address, so a spray across many accounts is visible.
          // It is not a secret — the attacker already knows it.
          actorLabel: email,
          tenantId,
          context: { reason },
          ...(request.ipAddress === undefined ? {} : { ipAddress: request.ipAddress }),
          ...(request.userAgent === undefined ? {} : { userAgent: request.userAgent }),
        });
      };

      if (user === undefined) {
        // Burn equivalent CPU so "unknown email" is not measurably faster.
        await this.passwords.verifyDummy(request.password);
        await auditFailure("UNKNOWN_USER", null);
        return { ok: false, reason: "UNKNOWN_USER" };
      }

      if (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now()) {
        await this.passwords.verifyDummy(request.password);
        await auditFailure("ACCOUNT_LOCKED", user.id);
        return { ok: false, reason: "ACCOUNT_LOCKED" };
      }

      if (user.status !== "ACTIVE") {
        await this.passwords.verifyDummy(request.password);
        await auditFailure("ACCOUNT_DISABLED", user.id);
        return { ok: false, reason: "ACCOUNT_DISABLED" };
      }

      const passwordValid = await this.passwords.verify(request.password, user.passwordHash);

      if (!passwordValid) {
        const nextCount = user.failedLoginCount + 1;
        await this.recordFailedAttempt(tx, user.id, nextCount);
        await auditFailure("BAD_PASSWORD", user.id);

        // The lockout itself is its own event: it is the moment access changed,
        // and it is what an operator gets paged about.
        if (nextCount >= MAX_FAILED_ATTEMPTS) {
          await this.audit.record(tx, {
            action: "auth.account_locked",
            outcome: "FAILURE",
            resourceType: "user",
            resourceId: user.id,
            actorType: "SYSTEM",
            actorId: null,
            tenantId,
            context: { failedAttempts: nextCount },
            ...(request.ipAddress === undefined ? {} : { ipAddress: request.ipAddress }),
          });
        }
        return { ok: false, reason: "BAD_PASSWORD" };
      }

      const roles = await this.rolesOf(tx, user.id);

      // MFA is mandatory for privileged roles. Enforced at login, not offered.
      // Until the TOTP challenge endpoint exists, a privileged account without
      // MFA configured cannot authenticate at all — deliberately fail closed
      // rather than silently granting a session that skips the requirement.
      if (this.requiresMfa(roles) && !user.mfaEnabled) {
        await auditFailure("MFA_REQUIRED", user.id);
        return { ok: false, reason: "MFA_REQUIRED" };
      }

      // Transparent upgrade if hashing parameters have strengthened.
      if (this.passwords.needsRehash(user.passwordHash)) {
        const rehashed = await this.passwords.hash(request.password);
        await tx.update(users).set({ passwordHash: rehashed }).where(eq(users.id, user.id));
      }

      await tx
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, user.id));

      const principal: Principal = {
        userId: user.id,
        tenantId,
        actorType: "user",
        roles,
        permissions: permissionsForRoles(roles),
        hubScope: user.hubScope,
        merchantId: user.merchantId,
        sessionId: randomUUID(),
      };

      const session = await this.issueSession(tx, principal, {
        familyId: randomUUID(),
        deviceId: request.deviceId,
        userAgent: request.userAgent,
        ipAddress: request.ipAddress,
      });

      await this.audit.record(tx, {
        action: "auth.login_succeeded",
        resourceType: "user",
        resourceId: user.id,
        actorType: "USER",
        actorId: user.id,
        actorLabel: email,
        tenantId,
        context: { roles, sessionId: principal.sessionId },
        ...(request.ipAddress === undefined ? {} : { ipAddress: request.ipAddress }),
        ...(request.userAgent === undefined ? {} : { userAgent: request.userAgent }),
      });

      return { ok: true, session };
    }, tenantId);
  }

  /**
   * Exchanges a refresh token for a new session, rotating it.
   *
   * Reuse detection: presenting a token that was already rotated means it was
   * captured. The entire family is revoked, forcing re-authentication. This is
   * what turns a stolen token into a detected incident rather than persistent
   * silent access.
   */
  async refresh(
    tenantIdRaw: string,
    presentedToken: string,
    context: { deviceId?: string; userAgent?: string; ipAddress?: string } = {},
  ): Promise<AuthResult> {
    const tenantId = asTenantId(tenantIdRaw);
    const digest = this.tokens.digestRefreshToken(presentedToken);

    return this.database.withTenant(async (tx) => {
      const found = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenDigest, digest))
        .limit(1);

      const stored = found[0];
      if (stored === undefined) {
        return { ok: false, reason: "UNKNOWN_USER" };
      }

      // REUSE DETECTED — this token was already exchanged or revoked.
      if (stored.rotatedAt !== null || stored.revokedAt !== null) {
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date(), revokeReason: "REUSE_DETECTED" })
          .where(
            and(
              eq(refreshTokens.familyId, stored.familyId),
              sql`${refreshTokens.revokedAt} is null`,
            ),
          );

        // A captured token being replayed. This is a security INCIDENT, not a
        // failed request, and it is the single highest-value entry this table
        // holds — it is the only signal that a session was stolen rather than
        // merely expired.
        await this.audit.record(tx, {
          action: "auth.refresh_reuse_detected",
          outcome: "FAILURE",
          resourceType: "user",
          resourceId: stored.userId,
          actorType: "ANONYMOUS",
          actorId: null,
          tenantId,
          context: {
            familyId: stored.familyId,
            alreadyRotated: stored.rotatedAt !== null,
            alreadyRevoked: stored.revokedAt !== null,
          },
          ...(context.ipAddress === undefined ? {} : { ipAddress: context.ipAddress }),
          ...(context.userAgent === undefined ? {} : { userAgent: context.userAgent }),
        });

        return { ok: false, reason: "BAD_PASSWORD" };
      }

      if (stored.expiresAt.getTime() <= Date.now()) {
        return { ok: false, reason: "BAD_PASSWORD" };
      }

      // Device binding: a token presented from a different device is treated as
      // stolen, not as a convenience case.
      if (
        stored.deviceId !== null &&
        context.deviceId !== undefined &&
        stored.deviceId !== context.deviceId
      ) {
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date(), revokeReason: "DEVICE_MISMATCH" })
          .where(eq(refreshTokens.familyId, stored.familyId));
        return { ok: false, reason: "BAD_PASSWORD" };
      }

      const found2 = await tx.select().from(users).where(eq(users.id, stored.userId)).limit(1);
      const user = found2[0];

      if (user === undefined || user.status !== "ACTIVE") {
        return { ok: false, reason: "ACCOUNT_DISABLED" };
      }

      const roles = await this.rolesOf(tx, user.id);

      await tx
        .update(refreshTokens)
        .set({ rotatedAt: new Date() })
        .where(eq(refreshTokens.id, stored.id));

      const principal: Principal = {
        userId: user.id,
        tenantId,
        actorType: stored.actorType === "driver" ? "driver" : "user",
        roles,
        permissions: permissionsForRoles(roles),
        hubScope: user.hubScope,
        merchantId: user.merchantId,
        sessionId: randomUUID(),
      };

      const session = await this.issueSession(tx, principal, {
        familyId: stored.familyId,
        deviceId: context.deviceId ?? stored.deviceId ?? undefined,
        userAgent: context.userAgent,
        ipAddress: context.ipAddress,
      });

      return { ok: true, session };
    }, tenantId);
  }

  /** Revokes every live refresh token for a user. Used on logout-all and incidents. */
  async revokeAllSessions(tenantIdRaw: string, userId: string, reason: string): Promise<number> {
    const tenantId = asTenantId(tenantIdRaw);

    return this.database.withTenant(async (tx) => {
      const revoked = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(), revokeReason: reason })
        .where(and(eq(refreshTokens.userId, userId), sql`${refreshTokens.revokedAt} is null`))
        .returning({ id: refreshTokens.id });
      return revoked.length;
    }, tenantId);
  }

  private requiresMfa(roles: readonly Role[]): boolean {
    return roles.some(
      (role) => role === "OWNER" || role === "FINANCE" || role === "PLATFORM_ADMIN",
    );
  }

  private async rolesOf(tx: TenantTransaction, userId: string): Promise<Role[]> {
    const rows = await tx
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));

    // Narrowed through `isRole`, which derives from ROLES. A hand-written list
    // here silently dropped MERCHANT when that role was added: the account
    // authenticated, but with no roles it resolved to no permissions and was
    // refused by every guard. A role the database knows and this build does not
    // must never be a role that half-works.
    return rows.map((row) => row.role).filter(isRole);
  }

  private async recordFailedAttempt(
    tx: TenantTransaction,
    userId: string,
    failedCount: number,
  ): Promise<void> {
    const lockedUntil =
      failedCount >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + lockoutDurationSeconds(failedCount) * 1000)
        : null;

    await tx
      .update(users)
      .set({ failedLoginCount: failedCount, lockedUntil })
      .where(eq(users.id, userId));
  }

  private async issueSession(
    tx: TenantTransaction,
    principal: Principal,
    context: {
      familyId: string;
      deviceId?: string | undefined;
      userAgent?: string | undefined;
      ipAddress?: string | undefined;
    },
  ): Promise<AuthSession> {
    const { token: accessToken, expiresIn } = await this.tokens.issueAccessToken(principal);
    const refresh = this.tokens.generateRefreshToken();
    const refreshExpiresAt = this.tokens.refreshTokenExpiry(principal.actorType);

    await tx.insert(refreshTokens).values({
      tenantId: principal.tenantId,
      userId: principal.userId,
      familyId: context.familyId,
      tokenDigest: refresh.digest,
      actorType: principal.actorType,
      deviceId: context.deviceId ?? null,
      userAgent: context.userAgent ?? null,
      ipAddress: context.ipAddress ?? null,
      expiresAt: refreshExpiresAt,
    });

    return {
      accessToken,
      expiresIn,
      refreshToken: refresh.token,
      refreshExpiresAt,
      principal,
    };
  }
}
