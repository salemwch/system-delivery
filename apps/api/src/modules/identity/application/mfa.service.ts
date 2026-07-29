import { randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as OTPAuth from "otpauth";

import { AuditService } from "../../platform/index.js";
import { FIELD_CIPHER, FieldCipher } from "../../../shared/crypto/index.js";
import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, NotFoundError } from "../../../shared/errors/index.js";
import { mfaRecoveryCodes, users } from "../domain/schema.js";
import { PasswordService } from "./password.service.js";

/**
 * TOTP parameters (RFC 6238).
 *
 * SHA-1 and 6 digits are not a security compromise — they are what every
 * authenticator app actually implements. Google Authenticator silently ignores
 * `algorithm` and `digits` in the provisioning URI, so choosing SHA-256 here
 * produces codes that never match on the most widely used client. The security
 * of TOTP rests on the secret's entropy, which is 160 bits below.
 */
const TOTP_ALGORITHM = "SHA1";
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;

/** 20 bytes = 160 bits, the RFC 4226 recommendation. */
const SECRET_BYTES = 20;

/**
 * Accept one step either side of now.
 *
 * ±1 covers ordinary phone clock drift. Wider windows are the common mistake:
 * every extra step multiplies the codes valid at any instant, and combined with
 * replay it widens the window an observed code stays useful.
 */
const DRIFT_WINDOW = 1;

/** Wrong codes tolerated before the account locks. Lower than the password limit. */
const MAX_MFA_ATTEMPTS = 5;

const RECOVERY_CODE_COUNT = 10;
/** 10 bytes → 16 base32 characters. Enough entropy to resist online guessing. */
const RECOVERY_CODE_BYTES = 10;

export interface EnrolmentChallenge {
  /** Base32 seed, for manual entry when a camera is unavailable. */
  readonly secret: string;
  /** `otpauth://totp/...` — what the QR code encodes. */
  readonly provisioningUri: string;
}

export interface EnrolmentResult {
  /** Shown ONCE. Never retrievable again. */
  readonly recoveryCodes: readonly string[];
}

export type MfaVerification =
  | { readonly ok: true; readonly usedRecoveryCode: boolean; readonly remainingCodes: number }
  | { readonly ok: false; readonly reason: MfaFailureReason };

type MfaFailureReason = "NOT_ENROLLED" | "BAD_CODE" | "CODE_ALREADY_USED" | "TOO_MANY_ATTEMPTS";

/**
 * Multi-factor authentication (docs/07-security-architecture.md §3, §4.1).
 *
 * ⚠️ This service exists because the `mfa_enabled` flag previously LIED. It was
 * set to true at provisioning so privileged accounts could log in at all, with
 * no enrolment and no challenge behind it — OWNER, FINANCE and PLATFORM_ADMIN
 * were password-only while the system reported multi-factor.
 *
 * Three defences that TOTP implementations commonly omit, all of them here:
 *
 *  1. **Every code is single-use.** A code stays valid for its whole 30-second
 *     step plus drift, so one observed over the shoulder or captured by a
 *     phishing proxy is replayable within that window. `mfa_last_step` records
 *     the highest step accepted and anything at or below it is refused.
 *  2. **The secret is encrypted at rest** with `FieldCipher` (AES-256-GCM).
 *     docs/07 §7 classes MFA secrets as CRITICAL; a database read must not
 *     yield a working authenticator.
 *  3. **Enrolment is two-phase.** The secret is stored but MFA is not active
 *     until a code proves the authenticator holds it. Otherwise a mis-scanned
 *     QR locks the user out of their own account.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
  ) {}

  /**
   * Phase one: generate a secret and hand back the provisioning URI.
   *
   * Deliberately does NOT set `mfa_enabled`. The user has not yet proved their
   * authenticator can produce a matching code, and enabling here would lock out
   * anyone whose scan failed.
   *
   * Re-enrolling overwrites an unverified secret, which is what a user retrying
   * a failed scan needs. It refuses to overwrite a VERIFIED one — that path is
   * `reset`, which is privileged and audited, because silently replacing a
   * working second factor is an account-takeover primitive.
   */
  async beginEnrolment(userId: string, issuer: string): Promise<EnrolmentChallenge> {
    return this.database.withTenant(async (tx) => {
      const user = await this.loadUser(tx, userId);

      if (user.mfaEnrolledAt !== null) {
        throw new BusinessRuleError(
          "MFA_ALREADY_ENROLLED",
          "MFA is already active for this account. Reset it before enrolling again.",
        );
      }

      const secret = new OTPAuth.Secret({ size: SECRET_BYTES });
      const totp = this.buildTotp(secret.base32, issuer, user.email);

      await tx
        .update(users)
        .set({
          // Encrypted before it reaches the column. The database never holds a
          // usable seed.
          mfaSecret: this.cipher.encrypt(secret.base32),
          mfaEnrolledAt: null,
          mfaEnabled: false,
          mfaLastStep: null,
          mfaFailedCount: 0,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, userId));

      return { secret: secret.base32, provisioningUri: totp.toString() };
    });
  }

  /**
   * Phase two: prove the authenticator holds the secret, then activate.
   *
   * Returns the recovery codes, which are shown once and never again.
   */
  async completeEnrolment(userId: string, code: string): Promise<EnrolmentResult> {
    const plaintextCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateRecoveryCode(),
    );
    // Hashing is deliberately outside the transaction: ten Argon2id hashes at
    // ~50 ms each would hold a write transaction open for half a second.
    const hashes = await Promise.all(plaintextCodes.map((c) => this.passwords.hash(c)));

    await this.database.withTenant(async (tx) => {
      const user = await this.loadUser(tx, userId);

      if (user.mfaSecret === null) {
        throw new BusinessRuleError("MFA_NOT_STARTED", "Start enrolment before confirming a code.");
      }
      if (user.mfaEnrolledAt !== null) {
        throw new BusinessRuleError("MFA_ALREADY_ENROLLED", "MFA is already active.");
      }

      const step = this.validateCode(this.cipher.decrypt(user.mfaSecret), code, null);
      if (step === null) {
        // No audit entry and no counter here: nothing is active yet, so a wrong
        // code during enrolment is a mis-typed digit, not an attack on a
        // protected account.
        throw new BusinessRuleError(
          "MFA_BAD_CODE",
          "That code is not valid. Check your authenticator and try again.",
        );
      }

      await tx
        .update(users)
        .set({
          mfaEnabled: true,
          mfaEnrolledAt: sql`now()`,
          mfaLastStep: step,
          mfaFailedCount: 0,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, userId));

      const tenantId = TenantContext.requireTenantId();
      await tx.insert(mfaRecoveryCodes).values(
        hashes.map((codeHash) => ({
          tenantId,
          userId,
          codeHash,
        })),
      );

      await this.audit.record(tx, {
        action: "auth.mfa_enrolled",
        resourceType: "user",
        resourceId: userId,
        changes: { mfaEnabled: { from: false, to: true } },
        context: { recoveryCodesIssued: RECOVERY_CODE_COUNT },
      });
    });

    return { recoveryCodes: plaintextCodes };
  }

  /**
   * Verifies a challenge at login. Accepts a TOTP code OR a recovery code.
   *
   * Runs in the caller's transaction so the attempt counter, the replay marker
   * and the session all commit together — a verification that succeeded while
   * its counter reset rolled back would let an attacker retry indefinitely.
   */
  async verifyChallenge(
    tx: TenantTransaction,
    userId: string,
    code: string,
    ipAddress?: string,
  ): Promise<MfaVerification> {
    const user = await this.loadUser(tx, userId);

    if (!user.mfaEnabled || user.mfaSecret === null) {
      return { ok: false, reason: "NOT_ENROLLED" };
    }

    if (user.mfaFailedCount >= MAX_MFA_ATTEMPTS) {
      return { ok: false, reason: "TOO_MANY_ATTEMPTS" };
    }

    const step = this.validateCode(this.cipher.decrypt(user.mfaSecret), code, user.mfaLastStep);

    if (step !== null) {
      await tx
        .update(users)
        .set({ mfaLastStep: step, mfaFailedCount: 0, updatedAt: sql`now()` })
        .where(eq(users.id, userId));

      const remaining = await this.countUnusedCodes(tx, userId);
      return { ok: true, usedRecoveryCode: false, remainingCodes: remaining };
    }

    // Not a valid TOTP code — it may still be a recovery code.
    const consumed = await this.consumeRecoveryCode(tx, userId, code, ipAddress);
    if (consumed) {
      await tx
        .update(users)
        .set({ mfaFailedCount: 0, updatedAt: sql`now()` })
        .where(eq(users.id, userId));

      const remaining = await this.countUnusedCodes(tx, userId);
      await this.audit.record(tx, {
        action: "auth.mfa_challenge_failed",
        outcome: "SUCCESS",
        tenantId: user.tenantId,
        resourceType: "user",
        resourceId: userId,
        actorType: "USER",
        actorId: userId,
        // A recovery code means the second factor was unavailable. Worth
        // surfacing: it is both a support signal and, in volume, an attack one.
        context: { recoveryCodeUsed: true, remainingCodes: remaining },
      });
      return { ok: true, usedRecoveryCode: true, remainingCodes: remaining };
    }

    const nextCount = user.mfaFailedCount + 1;
    await tx
      .update(users)
      .set({ mfaFailedCount: nextCount, updatedAt: sql`now()` })
      .where(eq(users.id, userId));

    await this.audit.record(tx, {
      action: "auth.mfa_challenge_failed",
      outcome: "FAILURE",
      tenantId: user.tenantId,
      resourceType: "user",
      resourceId: userId,
      actorType: "USER",
      actorId: userId,
      // The password was already correct to reach this point, so this is a
      // materially different signal from a failed password: someone HAS the
      // password and is working on the second factor.
      context: { attempt: nextCount, limit: MAX_MFA_ATTEMPTS },
      ...(ipAddress === undefined ? {} : { ipAddress }),
    });

    return {
      ok: false,
      reason: nextCount >= MAX_MFA_ATTEMPTS ? "TOO_MANY_ATTEMPTS" : "BAD_CODE",
    };
  }

  /**
   * Clears MFA so the user can enrol a new device. Privileged and audited.
   *
   * The support path for a lost phone with no recovery codes left. It is
   * deliberately a separate, permissioned operation rather than a side effect of
   * `beginEnrolment`: an attacker with a session must not be able to silently
   * swap the second factor for one they control.
   */
  async reset(userId: string, actingUserId: string): Promise<void> {
    await this.database.withTenant(async (tx) => {
      const user = await this.loadUser(tx, userId);

      await tx
        .update(users)
        .set({
          mfaEnabled: false,
          mfaSecret: null,
          mfaEnrolledAt: null,
          mfaLastStep: null,
          mfaFailedCount: 0,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, userId));

      // Outstanding codes are burned, not deleted: DELETE is revoked on this
      // table so the evidence of what was issued survives.
      await tx
        .update(mfaRecoveryCodes)
        .set({ usedAt: sql`now()` })
        .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));

      await this.audit.record(tx, {
        action: "auth.mfa_reset",
        resourceType: "user",
        resourceId: userId,
        changes: { mfaEnabled: { from: user.mfaEnabled, to: false } },
        context: { resetBy: actingUserId },
      });
    });
  }

  /** How many recovery codes remain. Surfaced so a user can be prompted to regenerate. */
  async remainingRecoveryCodes(userId: string): Promise<number> {
    return this.database.withTenant(async (tx) => this.countUnusedCodes(tx, userId));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private buildTotp(secretBase32: string, issuer: string, label: string): OTPAuth.TOTP {
    return new OTPAuth.TOTP({
      issuer,
      label,
      algorithm: TOTP_ALGORITHM,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
  }

  /**
   * Validates a code and returns the time-step it belongs to, or null.
   *
   * `lastStep` is the replay guard: a code from a step already accepted is
   * rejected even though it is still cryptographically valid, which is what
   * makes each code single-use.
   */
  private validateCode(secretBase32: string, code: string, lastStep: number | null): number | null {
    const normalised = code.replace(/\s+/gu, "");
    if (!/^\d{6}$/u.test(normalised)) {
      return null;
    }

    const totp = this.buildTotp(secretBase32, "validation", "validation");
    // `delta` is how many steps away the match was: 0 = current, -1 = previous.
    const delta = totp.validate({ token: normalised, window: DRIFT_WINDOW });
    if (delta === null) {
      return null;
    }

    const step = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS) + delta;
    if (lastStep !== null && step <= lastStep) {
      // Cryptographically correct, but already spent.
      return null;
    }
    return step;
  }

  /**
   * Marks a matching recovery code used, atomically.
   *
   * Every unused code is compared even after a match, so the work is constant
   * regardless of which code was supplied or whether any matched — a loop that
   * returned early would leak, by timing, roughly where in the list a code sat.
   */
  private async consumeRecoveryCode(
    tx: TenantTransaction,
    userId: string,
    candidate: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const normalised = candidate.replace(/[\s-]/gu, "").toUpperCase();
    if (normalised.length === 0) {
      return false;
    }

    const rows = await tx
      .select({ id: mfaRecoveryCodes.id, codeHash: mfaRecoveryCodes.codeHash })
      .from(mfaRecoveryCodes)
      .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));

    let matchedId: string | null = null;
    for (const row of rows) {
      const matches = await this.passwords.verify(normalised, row.codeHash);
      if (matches && matchedId === null) {
        matchedId = row.id;
      }
    }

    if (matchedId === null) {
      return false;
    }

    // The WHERE re-checks `used_at IS NULL`, so two concurrent logins presenting
    // the same code cannot both succeed — the second updates zero rows.
    const updated = await tx
      .update(mfaRecoveryCodes)
      .set({
        usedAt: sql`now()`,
        ...(ipAddress === undefined ? {} : { usedIp: ipAddress }),
      })
      .where(and(eq(mfaRecoveryCodes.id, matchedId), isNull(mfaRecoveryCodes.usedAt)))
      .returning({ id: mfaRecoveryCodes.id });

    return updated.length > 0;
  }

  private async countUnusedCodes(tx: TenantTransaction, userId: string): Promise<number> {
    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(mfaRecoveryCodes)
      .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
    return rows[0]?.count ?? 0;
  }

  private async loadUser(tx: TenantTransaction, userId: string) {
    const rows = await tx
      .select({
        id: users.id,
        email: users.email,
        tenantId: users.tenantId,
        mfaEnabled: users.mfaEnabled,
        mfaSecret: users.mfaSecret,
        mfaEnrolledAt: users.mfaEnrolledAt,
        mfaLastStep: users.mfaLastStep,
        mfaFailedCount: users.mfaFailedCount,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = rows[0];
    if (user === undefined) {
      throw new NotFoundError("User");
    }
    return user;
  }
}

/**
 * A recovery code: base32, grouped for readability when read aloud.
 *
 * Crockford-style alphabet without I, L, O, U — the characters people confuse
 * with 1, 0 and each other when transcribing from paper, which is exactly how
 * these are used.
 */
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_BYTES);
  let out = "";
  for (const byte of bytes) {
    out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    out += RECOVERY_ALPHABET[(byte >> 3) % RECOVERY_ALPHABET.length];
  }
  return out;
}
