import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";

import { AppConfigService } from "../../../shared/config/index.js";
import { ROLES, permissionsForRoles } from "../domain/permissions.js";
import type { Permission, Role } from "../domain/permissions.js";

/**
 * Access and refresh token issuance.
 *
 * Uses `jose` directly rather than a Passport strategy: one JWT library, no
 * additional auth framework layered on top (see the "one tool per job"
 * registry in CLAUDE.md).
 */

/** Who an authenticated caller is. Derived only from a verified token. */
export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly actorType: "user" | "driver";
  readonly roles: readonly Role[];
  readonly permissions: ReadonlySet<Permission>;
  /** Restricts a Dispatcher or Hub Operator to specific hubs. Empty = all. */
  readonly hubScope: readonly string[];
  /**
   * Set if and only if the caller holds the `MERCHANT` role (invariant I23).
   *
   * The only sub-tenant scope in the system: every other role sees the whole
   * tenant, so RLS alone isolates them. A merchant must see only their own rows
   * inside a tenant that also holds their competitors' parcels.
   */
  readonly merchantId: string | null;
  readonly sessionId: string;
}

interface AccessTokenClaims {
  readonly sub: string;
  readonly tid: string;
  readonly typ: "user" | "driver";
  readonly rol: readonly string[];
  readonly hub: readonly string[];
  /** The merchant a MERCHANT user is scoped to. Absent for every other role. */
  readonly mid?: string;
  readonly sid: string;
}

const ALGORITHM = "HS256";

/**
 * Roles a token may name. Derived from ROLES rather than restated, so adding a
 * role cannot leave an allow-list quietly behind.
 */
const KNOWN_ROLES: ReadonlySet<string> = new Set<string>(ROLES);

/** A generated refresh token and the digest to persist for it. */
export interface RefreshTokenPair {
  /** Returned to the client exactly once. Never stored in this form. */
  readonly token: string;
  /** SHA-256 of the token. This is what goes in the database. */
  readonly digest: string;
}

@Injectable()
export class TokenService {
  private readonly accessSecret: Uint8Array;

  constructor(private readonly config: AppConfigService) {
    this.accessSecret = new TextEncoder().encode(config.get("JWT_ACCESS_SECRET"));
  }

  /** Signs a short-lived access token. */
  async issueAccessToken(principal: Principal): Promise<{ token: string; expiresIn: number }> {
    const expiresIn =
      principal.actorType === "driver"
        ? this.config.get("DRIVER_ACCESS_TTL_SECONDS")
        : this.config.get("JWT_ACCESS_TTL_SECONDS");

    const token = await new SignJWT({
      tid: principal.tenantId,
      typ: principal.actorType,
      rol: [...principal.roles],
      hub: [...principal.hubScope],
      // Carried in the token so every request is scoped without a lookup. The
      // token is signed, so a merchant cannot widen their own scope by editing it.
      ...(principal.merchantId === null ? {} : { mid: principal.merchantId }),
      sid: principal.sessionId,
    })
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(principal.userId)
      .setIssuedAt()
      .setExpirationTime(`${String(expiresIn)}s`)
      .sign(this.accessSecret);

    return { token, expiresIn };
  }

  /**
   * Verifies an access token and returns its claims.
   *
   * Returns null on ANY failure — expired, tampered, wrong algorithm, malformed.
   * Callers must treat null as unauthenticated and must not distinguish the
   * reason to the client, which would leak information about token handling.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.accessSecret, {
        // Pinning the algorithm prevents `alg: none` and HS/RS confusion attacks.
        algorithms: [ALGORITHM],
      });

      const { sub, tid, typ, rol, hub, mid, sid } = payload as Record<string, unknown>;

      if (
        typeof sub !== "string" ||
        typeof tid !== "string" ||
        (typ !== "user" && typ !== "driver") ||
        typeof sid !== "string" ||
        !Array.isArray(rol) ||
        !Array.isArray(hub)
      ) {
        return null;
      }

      const roles = rol.filter((value): value is string => typeof value === "string");

      // Fail closed on a token whose scope contradicts its role (invariant I23).
      // A MERCHANT claim without `mid` would otherwise be read as "no narrowing"
      // and see the entire tenant — the exact escalation this role must not have.
      const isMerchant = roles.includes("MERCHANT");
      if (isMerchant !== (typeof mid === "string" && mid.length > 0)) {
        return null;
      }

      return {
        sub,
        tid,
        typ,
        sid,
        rol: roles,
        hub: hub.filter((value): value is string => typeof value === "string"),
        ...(typeof mid === "string" ? { mid } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * Verifies a token and resolves the caller it represents.
   *
   * The single implementation of "bearer token → Principal". Both the HTTP
   * AuthGuard and the WebSocket handshake go through here, so a socket and a
   * request cannot end up disagreeing about who someone is or what they may do
   * — which is exactly the drift that makes a realtime channel the soft spot in
   * an otherwise well-guarded API.
   *
   * Returns null for anything not provably valid. Expired, tampered, malformed,
   * and carrying an unknown role are all indistinguishable to the caller.
   */
  async authenticate(token: string): Promise<Principal | null> {
    const claims = await this.verifyAccessToken(token);
    if (claims === null) {
      return null;
    }
    const roles = claims.rol.filter((role): role is Role => KNOWN_ROLES.has(role));
    return {
      userId: claims.sub,
      tenantId: claims.tid,
      actorType: claims.typ,
      roles,
      permissions: permissionsForRoles(roles),
      hubScope: claims.hub,
      merchantId: claims.mid ?? null,
      sessionId: claims.sid,
    };
  }

  /**
   * Generates a refresh token.
   *
   * The raw value goes to the client once; only its SHA-256 digest is stored.
   * A database leak therefore does not yield usable refresh tokens.
   */
  generateRefreshToken(): RefreshTokenPair {
    const token = randomBytes(48).toString("base64url");
    return { token, digest: this.digestRefreshToken(token) };
  }

  /** SHA-256 digest. Refresh tokens are high-entropy, so a fast hash is correct here. */
  digestRefreshToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /** Constant-time digest comparison, to avoid leaking a match position. */
  refreshTokenMatches(token: string, storedDigest: string): boolean {
    const candidate = Buffer.from(this.digestRefreshToken(token), "hex");
    let stored: Buffer;
    try {
      stored = Buffer.from(storedDigest, "hex");
    } catch {
      return false;
    }
    if (candidate.length !== stored.length) {
      return false;
    }
    return timingSafeEqual(candidate, stored);
  }

  /** Absolute expiry for a newly issued refresh token. */
  refreshTokenExpiry(actorType: "user" | "driver"): Date {
    const days =
      actorType === "driver"
        ? this.config.get("DRIVER_REFRESH_TTL_DAYS")
        : this.config.get("JWT_REFRESH_TTL_DAYS");
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }
}
