import { randomInt } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { AuditService, NOTIFICATION_PROVIDER } from "../../platform/index.js";
import type { NotificationProvider } from "../../platform/index.js";
import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { otpCodes } from "../domain/schema.js";
import { PasswordService } from "./password.service.js";

/**
 * Six digits: what a driver can read from a notification and type with gloves
 * on. The brute-force resistance comes from the attempt cap and the short
 * lifetime, not from the code's length — an 8-digit code guessed without limit
 * is weaker than a 6-digit one with five attempts.
 */
const CODE_DIGITS = 6;

/** Long enough to arrive over a slow network, short enough to be useless if seen. */
const CODE_TTL_SECONDS = 300;

/** Wrong guesses per code before it is dead. */
const MAX_ATTEMPTS = 5;

/**
 * Rate limit per phone. SMS costs money and lands on a real person's handset,
 * so an unthrottled endpoint is both a bill and a way to harass a stranger.
 */
const MAX_REQUESTS_PER_WINDOW = 3;
const RATE_WINDOW_SECONDS = 900;

/**
 * A deliberate floor on how often ONE number can be re-sent, independent of the
 * window count. Stops a client that retries on every keystroke.
 */
const RESEND_COOLDOWN_SECONDS = 60;

export type OtpRequestOutcome =
  | { readonly ok: true; readonly expiresInSeconds: number }
  | { readonly ok: false; readonly reason: "RATE_LIMITED"; readonly retryAfterSeconds: number };

export type OtpVerification =
  { readonly ok: true } | { readonly ok: false; readonly reason: OtpFailureReason };

type OtpFailureReason = "NO_CODE" | "EXPIRED" | "BAD_CODE" | "TOO_MANY_ATTEMPTS";

/**
 * One-time codes for driver phone login (docs/07-security-architecture.md §3.2).
 *
 * ⚠️ AN OTP IS A CREDENTIAL, and this class treats it as one:
 *
 *  - **Hashed at rest** with Argon2id, like a password. A database read must not
 *    yield a working login.
 *  - **Single-use.** Consumed atomically, so two requests presenting the same
 *    code cannot both succeed.
 *  - **Attempt-capped.** Five wrong guesses kill the code. A 6-digit code is
 *    one-in-a-million per guess, which is only meaningful if guesses are finite.
 *  - **Rate-limited per phone**, with a resend cooldown.
 *
 * ⚠️ It also never reveals whether a phone belongs to a real driver. `request`
 * returns the same shape for a known and an unknown number, and only SENDS for a
 * known one. Anything else is a driver-enumeration oracle: the fleet roster of a
 * courier is competitive information, and the phone numbers are personal data.
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    @Inject(NOTIFICATION_PROVIDER) private readonly notifications: NotificationProvider,
  ) {}

  /**
   * Issues a code and sends it, if the phone belongs to an active driver.
   *
   * @param deliver whether a driver actually exists. Resolved by the caller,
   *   which owns the `drivers` lookup; passing it keeps this service free of a
   *   dependency on `fleet` (a higher layer).
   */
  async request(
    phone: string,
    options: { readonly deliver: boolean; readonly ipAddress?: string; readonly locale?: string },
  ): Promise<OtpRequestOutcome> {
    const tenantId = TenantContext.requireTenantId();

    // Generated OUTSIDE the transaction: Argon2id is ~50 ms of deliberate CPU
    // and holding a write transaction open for it serves nothing.
    const code = generateCode();
    const codeHash = await this.passwords.hash(code);

    const outcome = await this.database.withTenant(async (tx) => {
      const limit = await this.checkRateLimit(tx, phone);
      if (limit !== null) {
        await this.audit.record(tx, {
          action: "auth.login_failed",
          outcome: "DENIED",
          resourceType: "otp",
          actorType: "ANONYMOUS",
          actorId: null,
          tenantId,
          context: { reason: "OTP_RATE_LIMITED", retryAfterSeconds: limit },
          ...(options.ipAddress === undefined ? {} : { ipAddress: options.ipAddress }),
        });
        return { ok: false as const, reason: "RATE_LIMITED" as const, retryAfterSeconds: limit };
      }

      // Any earlier live code for this phone is retired. Two valid codes at once
      // doubles the guessing surface and confuses a driver who requested a
      // second because the first was slow.
      await tx
        .update(otpCodes)
        .set({ consumedAt: sql`now()` })
        .where(and(eq(otpCodes.phone, phone), isNull(otpCodes.consumedAt)));

      await tx.insert(otpCodes).values({
        tenantId,
        phone,
        codeHash,
        expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
        ...(options.ipAddress === undefined ? {} : { requestedIp: options.ipAddress }),
      });

      return { ok: true as const, expiresInSeconds: CODE_TTL_SECONDS };
    });

    // Sent outside the transaction, and only when the driver exists. A provider
    // that hangs must not hold a database write open, and a send failure must
    // not roll back a code the driver may still receive.
    if (outcome.ok && options.deliver) {
      await this.deliver(phone, code, options.locale);
    }

    return outcome;
  }

  /**
   * Checks a code and consumes it.
   *
   * Runs in the CALLER's transaction so consumption, the attempt counter and the
   * session all commit together — a verification that succeeded while its
   * consumption rolled back would leave a working code in circulation.
   */
  async verify(tx: TenantTransaction, phone: string, code: string): Promise<OtpVerification> {
    const rows = await tx
      .select()
      .from(otpCodes)
      .where(and(eq(otpCodes.phone, phone), isNull(otpCodes.consumedAt)))
      .orderBy(desc(otpCodes.createdAt))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      // Burn comparable CPU so "no code outstanding" is not measurably faster
      // than a wrong code — the timing would otherwise say whether this number
      // has an account.
      await this.passwords.verifyDummy(code);
      return { ok: false, reason: "NO_CODE" };
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      await this.passwords.verifyDummy(code);
      return { ok: false, reason: "EXPIRED" };
    }

    if (row.attemptCount >= MAX_ATTEMPTS) {
      await this.passwords.verifyDummy(code);
      return { ok: false, reason: "TOO_MANY_ATTEMPTS" };
    }

    const matches = await this.passwords.verify(code.trim(), row.codeHash);

    if (!matches) {
      const nextCount = row.attemptCount + 1;
      await tx
        .update(otpCodes)
        .set({
          attemptCount: nextCount,
          // Exhausting the attempts kills the code outright rather than leaving
          // it to expire — otherwise it stays a candidate for the next guess.
          ...(nextCount >= MAX_ATTEMPTS ? { consumedAt: sql`now()` } : {}),
        })
        .where(eq(otpCodes.id, row.id));

      return {
        ok: false,
        reason: nextCount >= MAX_ATTEMPTS ? "TOO_MANY_ATTEMPTS" : "BAD_CODE",
      };
    }

    // Consumed with `consumed_at IS NULL` still in the predicate, so two
    // concurrent logins presenting the same code cannot both win — the second
    // updates zero rows and is refused.
    const consumed = await tx
      .update(otpCodes)
      .set({ consumedAt: sql`now()` })
      .where(and(eq(otpCodes.id, row.id), isNull(otpCodes.consumedAt)))
      .returning({ id: otpCodes.id });

    if (consumed.length === 0) {
      return { ok: false, reason: "BAD_CODE" };
    }

    return { ok: true };
  }

  /**
   * Returns how long the caller must wait, or null when they may proceed.
   *
   * Two limits: a burst cooldown so a retrying client cannot spam one handset,
   * and a window count so a determined caller cannot drip-feed messages at the
   * cooldown interval indefinitely.
   */
  private async checkRateLimit(tx: TenantTransaction, phone: string): Promise<number | null> {
    const windowStart = new Date(Date.now() - RATE_WINDOW_SECONDS * 1000);

    const recent = await tx
      .select({ createdAt: otpCodes.createdAt })
      .from(otpCodes)
      .where(and(eq(otpCodes.phone, phone), gt(otpCodes.createdAt, windowStart)))
      .orderBy(desc(otpCodes.createdAt));

    const latest = recent[0];
    if (latest !== undefined) {
      const sinceLast = (Date.now() - latest.createdAt.getTime()) / 1000;
      if (sinceLast < RESEND_COOLDOWN_SECONDS) {
        return Math.ceil(RESEND_COOLDOWN_SECONDS - sinceLast);
      }
    }

    if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
      const oldest = recent[recent.length - 1];
      if (oldest !== undefined) {
        const elapsed = (Date.now() - oldest.createdAt.getTime()) / 1000;
        return Math.max(1, Math.ceil(RATE_WINDOW_SECONDS - elapsed));
      }
    }

    return null;
  }

  /**
   * Hands the code to the transport.
   *
   * A provider failure is swallowed on purpose: the code is already stored and
   * the caller has already been told "if that number is registered, a code is on
   * its way". Throwing here would turn an SMS outage into a login error that
   * also reveals the number exists.
   */
  private async deliver(phone: string, code: string, locale?: string): Promise<void> {
    try {
      await this.notifications.send({
        to: phone,
        channel: "SMS",
        body: renderOtpMessage(code, locale),
      });
    } catch {
      // Logged by the provider itself. Nothing here can recover it, and the
      // driver can request another code once the cooldown passes.
    }
  }
}

/**
 * A uniformly distributed 6-digit code.
 *
 * `randomInt` is the CSPRNG, not `Math.random`: this is a credential, and a
 * predictable one is no credential at all. Zero-padded so every code is the same
 * length and no digit position leaks information.
 */
function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
}

/**
 * The message body.
 *
 * Arabic and French are the languages a Tunisian driver actually reads; English
 * is the fallback. Deliberately says nothing about the platform or the account —
 * a message read on a lock screen should not identify the employer.
 */
function renderOtpMessage(code: string, locale?: string): string {
  switch (locale) {
    case "ar":
      return `${code} — رمز الدخول. صالح لمدة 5 دقائق. لا تشاركه مع أحد.`;
    case "en":
      return `${code} is your login code. Valid for 5 minutes. Do not share it.`;
    default:
      return `${code} est votre code de connexion. Valable 5 minutes. Ne le partagez pas.`;
  }
}
