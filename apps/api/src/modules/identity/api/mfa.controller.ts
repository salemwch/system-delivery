import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { z } from "zod";

import { AppConfigService } from "../../../shared/config/index.js";
import { TenantContext, asTenantId } from "../../../shared/database/index.js";
import { UnauthenticatedError } from "../../../shared/errors/index.js";
import { zodBody } from "../../../shared/http/index.js";
import { toSessionResponse } from "./session-response.js";
import type { SessionResponse } from "./session-response.js";
import { totpQrSvg } from "../domain/totp-qr.js";
import { AuthService } from "../application/auth.service.js";
import { MfaService } from "../application/mfa.service.js";
import { TokenService } from "../application/token.service.js";
import { CurrentPrincipal, Public, RequirePermissions } from "./request-context.js";
import type { Principal } from "../application/token.service.js";

/**
 * Multi-factor authentication (docs/07-security-architecture.md §3, §4.1).
 *
 * Two distinct surfaces, and the split matters:
 *
 *  - **Enrolment** is authenticated. You must already hold a session to add a
 *    second factor to your own account.
 *  - **The challenge** is public by necessity — the caller has passed the
 *    password step but has no session yet. It is protected by the challenge
 *    token, which is short-lived, bound to one user, and carries no permissions.
 */

const confirmSchema = z.strictObject({
  code: z.string().trim().min(6).max(10),
});

const bootstrapEnrolSchema = z.strictObject({
  challenge: z.string().min(1),
});

const bootstrapConfirmSchema = z.strictObject({
  challenge: z.string().min(1),
  code: z.string().trim().min(6).max(10),
});

const challengeSchema = z.strictObject({
  /** Issued by `POST /v1/auth/login` when the password was accepted. */
  challenge: z.string().min(1),
  /** A TOTP code or a recovery code. */
  code: z.string().trim().min(6).max(32),
});

@Controller("v1/auth/mfa")
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Starts enrolment for the CALLER's own account.
   *
   * Scoped to `principal.userId` and not to a path parameter on purpose: nobody
   * enrols a second factor on someone else's behalf, because whoever holds the
   * secret holds the factor.
   */
  @Post("enrol")
  @HttpCode(HttpStatus.OK)
  async enrol(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ secret: string; provisioningUri: string }> {
    return this.mfa.beginEnrolment(principal.userId, this.config.get("MFA_ISSUER"));
  }

  /**
   * Confirms enrolment and returns the recovery codes.
   *
   * ⚠️ The codes in this response are shown ONCE. They are stored as Argon2id
   * hashes and cannot be recovered — losing them means the only way back from a
   * lost phone is an administrator reset.
   */
  @Post("confirm")
  @HttpCode(HttpStatus.OK)
  async confirm(
    @CurrentPrincipal() principal: Principal,
    @Body(zodBody(confirmSchema)) body: z.infer<typeof confirmSchema>,
  ): Promise<{ recoveryCodes: readonly string[] }> {
    const result = await this.mfa.completeEnrolment(principal.userId, body.code);
    return { recoveryCodes: result.recoveryCodes };
  }

  /** How many recovery codes remain, so the UI can prompt before they run out. */
  @Get("recovery-codes/remaining")
  async remaining(@CurrentPrincipal() principal: Principal): Promise<{ remaining: number }> {
    return { remaining: await this.mfa.remainingRecoveryCodes(principal.userId) };
  }

  /**
   * Completes a login by presenting the second factor.
   *
   * Public because the caller holds no session yet — the challenge token IS the
   * authentication for this endpoint. It is verified before anything else
   * happens, and an ordinary access token is rejected here, so an existing
   * session cannot be used to skip the second factor on another account.
   */
  @Post("challenge")
  @Public()
  @HttpCode(HttpStatus.OK)
  async challenge(
    @Body(zodBody(challengeSchema)) body: z.infer<typeof challengeSchema>,
  ): Promise<SessionResponse & { usedRecoveryCode: boolean; remainingRecoveryCodes: number }> {
    const verified = await this.tokens.verifyMfaChallenge(body.challenge);
    if (verified === null) {
      // Expired, tampered, or not a challenge token at all — one answer for all.
      throw new UnauthenticatedError();
    }

    const result = await this.auth.completeMfaLogin(verified.tenantId, verified.userId, body.code);
    if (!result.ok) {
      throw new UnauthenticatedError();
    }

    // The SAME envelope `POST /v1/auth/login` returns, plus the recovery-code
    // accounting. This endpoint completes a login, so a client must be able to
    // read the session out of it exactly as it does there — returning bare
    // tokens with no `user` is what made MFA sign-in impossible in apps/web.
    return {
      ...toSessionResponse(result.session),
      usedRecoveryCode: result.usedRecoveryCode,
      remainingRecoveryCodes: result.remainingRecoveryCodes,
    };
  }

  /**
   * Enrols a factor using a CHALLENGE token instead of a session.
   *
   * ⚠️ This exists to break a genuine deadlock, not as a convenience. A role in
   * `MFA_REQUIRED_ROLES` cannot log in until it has enrolled, and could not
   * enrol without logging in — a freshly provisioned OWNER would be locked out
   * of their own tenant permanently.
   *
   * The challenge token is what makes it safe: it is issued only after a
   * correct password, names one account, lasts five minutes, and authorises
   * nothing but this. It is emphatically not a session.
   */
  @Post("bootstrap/enrol")
  @Public()
  @HttpCode(HttpStatus.OK)
  async bootstrapEnrol(
    @Body(zodBody(bootstrapEnrolSchema)) body: z.infer<typeof bootstrapEnrolSchema>,
  ): Promise<{ secret: string; provisioningUri: string; qrSvg: string }> {
    const verified = await this.tokens.verifyMfaChallenge(body.challenge);
    if (verified === null) {
      throw new UnauthenticatedError();
    }
    const enrolment = await this.runAsChallenger(verified, () =>
      this.mfa.beginEnrolment(verified.userId, this.config.get("MFA_ISSUER")),
    );

    /*
     * The QR is rendered HERE, not in the browser.
     *
     * The provisioning URI contains the shared secret. Handing it to client
     * JavaScript to draw would put the factor in the browser's memory and in
     * any script that shares the page — the whole point of this app is that
     * secrets stay server-side. An inline SVG is a string; it renders under
     * `img-src 'self' data:` without a `data:` URI at all.
     *
     * `secret` is still returned alongside it: authenticator apps all accept
     * manual entry, and a QR that will not scan on a cracked phone screen must
     * not be the only way in.
     */
    return { ...enrolment, qrSvg: await totpQrSvg(enrolment.provisioningUri) };
  }

  /**
   * Runs a bootstrap handler inside the tenant context its challenge names.
   *
   * ⚠️ Without this the bootstrap routes answer **500**, and they are the only
   * way a freshly provisioned OWNER can ever obtain a session.
   *
   * `@Public()` means `AuthGuard` does not run, so `TenantContextInterceptor`
   * has no principal and binds nothing — every `withTenant` call underneath
   * then hits `requireTenantId()` and throws. Establishing the context HERE,
   * rather than passing a tenant id down through each service, is what makes
   * the audit trail and the session issue work too: they read the same ambient
   * context every authenticated request gives them, so nothing downstream needs
   * a second code path for this one caller.
   *
   * Safe because both values come from the token's verified payload — the
   * signature is the authentication — and never from the request body.
   */
  private runAsChallenger<T>(
    verified: { userId: string; tenantId: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    return TenantContext.run(
      {
        tenantId: asTenantId(verified.tenantId),
        actorId: verified.userId,
        actorType: "user",
      },
      fn,
    );
  }

  /**
   * Confirms a bootstrap enrolment and issues the first session.
   *
   * Returns the recovery codes once, and a session — the user has now proved
   * both factors, so making them log in again would serve nothing.
   */
  @Post("bootstrap/confirm")
  @Public()
  @HttpCode(HttpStatus.OK)
  async bootstrapConfirm(
    @Body(zodBody(bootstrapConfirmSchema)) body: z.infer<typeof bootstrapConfirmSchema>,
  ): Promise<SessionResponse & { recoveryCodes: readonly string[] }> {
    const verified = await this.tokens.verifyMfaChallenge(body.challenge);
    if (verified === null) {
      throw new UnauthenticatedError();
    }

    const { enrolment, session } = await this.runAsChallenger(verified, async () => ({
      enrolment: await this.mfa.completeEnrolment(verified.userId, body.code),
      // A fresh code for the session: `completeEnrolment` consumed this step,
      // and the replay guard would rightly refuse the same one again.
      session: await this.auth.issueSessionAfterEnrolment(verified.tenantId, verified.userId),
    }));

    // Same envelope as login, for the same reason as `challenge` above.
    return {
      ...toSessionResponse(session),
      recoveryCodes: enrolment.recoveryCodes,
    };
  }

  /**
   * Clears a user's MFA so they can enrol a new device.
   *
   * The support path for a lost phone with no recovery codes left. Requires
   * `user:manage`, held only by OWNER — resetting someone's second factor is an
   * account-takeover primitive if it is not tightly held, and it is audited.
   */
  @Post(":userId/reset")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("user:manage")
  async reset(
    @Param("userId") userId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ reset: true }> {
    await this.mfa.reset(userId, principal.userId);
    return { reset: true };
  }
}
