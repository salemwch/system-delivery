import { Body, Controller, HttpCode, HttpStatus, Post, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { UnauthenticatedError } from "../../../shared/errors/domain-error.js";
import { zodBody } from "../../../shared/http/index.js";
import { AuthService } from "../application/auth.service.js";
import type { AuthResult } from "../application/auth.service.js";
import { MFA_CHALLENGE_TTL_SECONDS } from "../application/token.service.js";
import { CurrentPrincipal, Public, RequirePermissions } from "./request-context.js";
import type { Principal } from "../application/token.service.js";

/**
 * Authentication endpoints (docs/05-api-contracts.md §2).
 *
 * Every CREDENTIAL failure returns one indistinguishable 401. Unknown email,
 * wrong password, disabled account, and lockout must not be tellable apart by a
 * caller — the specific reason is recorded server-side for audit only.
 *
 * The two MFA states are the deliberate exception: they are reachable only
 * after a correct password, so naming them tells the caller nothing they have
 * not already proved. See `MfaChallengeResponse`.
 */

/** `.strict()` rejects unknown properties rather than stripping them. */
const loginSchema = z
  .object({
    tenantId: z.uuid(),
    email: z.email().max(320),
    password: z.string().min(1).max(512),
    deviceId: z.string().max(200).optional(),
    /**
     * The second factor, when the client already holds one.
     *
     * Optional so the two-step flow still works: omit it and a correct password
     * returns a challenge instead of a session. Supplying it collapses both
     * steps into one call, which is what a client that has already prompted for
     * the code wants.
     */
    mfaCode: z.string().trim().min(6).max(32).optional(),
  })
  .strict();

/** E.164 — the driver's identity, matching the format `users.phone` stores. */
const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/u, "must be an E.164 phone number, e.g. +21620123456");

const otpRequestSchema = z
  .object({
    tenantId: z.uuid(),
    phone: e164,
  })
  .strict();

const otpVerifySchema = z
  .object({
    tenantId: z.uuid(),
    phone: e164,
    /** Exactly six digits. Length is validated before any hash comparison. */
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/u, "must be a 6-digit code"),
    deviceId: z.string().max(200).optional(),
  })
  .strict();

const refreshSchema = z
  .object({
    tenantId: z.uuid(),
    refreshToken: z.string().min(1).max(512),
    deviceId: z.string().max(200).optional(),
  })
  .strict();

type LoginBody = z.infer<typeof loginSchema>;
type RefreshBody = z.infer<typeof refreshSchema>;

interface SessionResponse {
  /** Discriminator. A client switches on this, never on which fields are present. */
  readonly status: "AUTHENTICATED";
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken: string;
  readonly user: {
    readonly id: string;
    readonly tenantId: string;
    readonly roles: readonly string[];
    readonly permissions: readonly string[];
  };
}

/**
 * The password was correct and a second factor now stands between the caller
 * and a session.
 *
 * ⚠️ This is NOT one of the indistinguishable failures. Those exist so an
 * attacker cannot probe which emails are real; this state is only ever reached
 * by someone who has ALREADY supplied a correct password, so it discloses
 * nothing they did not just prove they knew. Collapsing it into the blanket 401
 * made the entire MFA subsystem unreachable over HTTP — `/v1/auth/mfa/challenge`
 * and `/v1/auth/mfa/bootstrap/enrol` both require this token, and nothing else
 * issues one, so an enrolled user could not complete a login and a privileged
 * role could not enrol at all.
 */
interface MfaChallengeResponse {
  /**
   * `MFA_REQUIRED` — enrolled; POST the code to `/v1/auth/mfa/challenge`.
   * `MFA_ENROLMENT_REQUIRED` — a role that must have a factor and has none;
   * enrol through `/v1/auth/mfa/bootstrap/enrol` before a session is possible.
   */
  readonly status: "MFA_REQUIRED" | "MFA_ENROLMENT_REQUIRED";
  /** Single-purpose, permissionless, bound to one account. */
  readonly challenge: string;
  readonly expiresIn: number;
}

type LoginResponse = SessionResponse | MfaChallengeResponse;

@Controller("v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(zodBody(loginSchema)) body: LoginBody,
    @Req() request: FastifyRequest,
  ): Promise<LoginResponse> {
    const result = await this.auth.login({
      tenantId: body.tenantId,
      email: body.email,
      password: body.password,
      ...(body.deviceId === undefined ? {} : { deviceId: body.deviceId }),
      ...(body.mfaCode === undefined ? {} : { mfaCode: body.mfaCode }),
      ...(request.headers["user-agent"] === undefined
        ? {}
        : { userAgent: request.headers["user-agent"] }),
      ...(request.ip === undefined ? {} : { ipAddress: request.ip }),
    });

    // The two MFA states carry a challenge and are reported as themselves.
    // Everything else stays one indistinguishable 401.
    if (
      !result.ok &&
      (result.reason === "MFA_REQUIRED" || result.reason === "MFA_ENROLMENT_REQUIRED") &&
      result.challenge !== undefined
    ) {
      return {
        status: result.reason,
        challenge: result.challenge,
        expiresIn: MFA_CHALLENGE_TTL_SECONDS,
      };
    }

    return this.toResponse(result);
  }

  @Public()
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body(zodBody(refreshSchema)) body: RefreshBody,
    @Req() request: FastifyRequest,
  ): Promise<SessionResponse> {
    const result = await this.auth.refresh(body.tenantId, body.refreshToken, {
      ...(body.deviceId === undefined ? {} : { deviceId: body.deviceId }),
      ...(request.headers["user-agent"] === undefined
        ? {}
        : { userAgent: request.headers["user-agent"] }),
      ...(request.ip === undefined ? {} : { ipAddress: request.ip }),
    });

    return this.toResponse(result);
  }

  /**
   * Revokes every live session for the caller.
   *
   * Requires no special permission — any authenticated principal may sign
   * themselves out everywhere, which is the correct response to a suspected
   * compromise.
   */
  @Post("logout-all")
  @HttpCode(HttpStatus.OK)
  async logoutAll(@CurrentPrincipal() principal: Principal): Promise<{ revokedSessions: number }> {
    const revoked = await this.auth.revokeAllSessions(
      principal.tenantId,
      principal.userId,
      "USER_LOGOUT_ALL",
    );
    return { revokedSessions: revoked };
  }

  /** Returns the caller's own identity. Useful for bootstrapping a client. */
  @Post("me")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("user:read")
  me(@CurrentPrincipal() principal: Principal): SessionResponse["user"] {
    return {
      id: principal.userId,
      tenantId: principal.tenantId,
      roles: principal.roles,
      permissions: [...principal.permissions],
    };
  }

  /**
   * Collapses every authentication failure into one opaque 401.
   *
   * The discriminated `reason` exists for audit logging, never for the client:
   * distinguishing "unknown email" from "wrong password" is a user-enumeration
   * oracle (docs/07-security-architecture.md §3.1).
   */
  /**
   * Step one of driver login: send a one-time code to a phone.
   *
   * ⚠️ The response is IDENTICAL whether or not the number belongs to a driver,
   * and deliberately so — a different answer would let anyone enumerate a
   * courier's fleet one number at a time. Only the SMS is conditional.
   *
   * `retryAfterSeconds` on a rate-limited response is not a leak: it describes
   * the caller's own request history, which they already know.
   */
  @Public()
  @Post("driver/otp/request")
  @HttpCode(HttpStatus.ACCEPTED)
  async requestDriverOtp(
    @Body(zodBody(otpRequestSchema)) body: z.infer<typeof otpRequestSchema>,
    @Req() request: FastifyRequest,
  ): Promise<{ sent: true; expiresInSeconds?: number; retryAfterSeconds?: number }> {
    const outcome = await this.auth.requestDriverOtp(body.tenantId, body.phone, {
      ...(request.ip === undefined ? {} : { ipAddress: request.ip }),
    });

    if (!outcome.ok) {
      return { sent: true, retryAfterSeconds: outcome.retryAfterSeconds };
    }
    return { sent: true, expiresInSeconds: outcome.expiresInSeconds };
  }

  /** Step two: exchange the code for a driver session. */
  @Public()
  @Post("driver/otp/verify")
  @HttpCode(HttpStatus.OK)
  async verifyDriverOtp(
    @Body(zodBody(otpVerifySchema)) body: z.infer<typeof otpVerifySchema>,
    @Req() request: FastifyRequest,
  ): Promise<SessionResponse> {
    const result = await this.auth.verifyDriverOtp(body.tenantId, body.phone, body.code, {
      ...(body.deviceId === undefined ? {} : { deviceId: body.deviceId }),
      ...(request.headers["user-agent"] === undefined
        ? {}
        : { userAgent: request.headers["user-agent"] }),
      ...(request.ip === undefined ? {} : { ipAddress: request.ip }),
    });

    return this.toResponse(result);
  }

  private toResponse(result: AuthResult): SessionResponse {
    if (!result.ok) {
      throw new UnauthenticatedError("Invalid credentials");
    }

    const { session } = result;
    return {
      status: "AUTHENTICATED",
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      refreshToken: session.refreshToken,
      user: {
        id: session.principal.userId,
        tenantId: session.principal.tenantId,
        roles: session.principal.roles,
        permissions: [...session.principal.permissions],
      },
    };
  }
}
