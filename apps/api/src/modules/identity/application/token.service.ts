import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { SignJWT, createLocalJWKSet, jwtVerify } from "jose";
import type { JWK, JWTPayload } from "jose";

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

/**
 * Ed25519 — the fully-specified JWS algorithm (RFC 9864), not the polymorphic
 * "EdDSA" it deprecates. Asymmetric, so a verifier holds only the public key
 * and cannot mint a token; deterministic signatures, so there is no
 * per-signature nonce to get wrong (the classic ECDSA failure).
 */
const ALGORITHM = "Ed25519";

/** Who mints these tokens and who accepts them (RFC 8725 §3.8–3.9). */
const ISSUER = "urn:delivery-platform:api";
const AUDIENCE = "urn:delivery-platform:api";

/**
 * Explicit typing (RFC 8725 §3.11) in the PROTECTED header: an MFA challenge
 * can never verify as an access token, nor the reverse, whatever its claims
 * say. `at+jwt` is the registered access-token type (RFC 9068).
 */
const ACCESS_TOKEN_TYPE = "at+jwt";
const MFA_CHALLENGE_TOKEN_TYPE = "mfa-challenge+jwt";

/**
 * Roles a token may name. Derived from ROLES rather than restated, so adding a
 * role cannot leave an allow-list quietly behind.
 */
const KNOWN_ROLES: ReadonlySet<string> = new Set<string>(ROLES);

/** Marks a token as an MFA challenge, so it can never be used as a session. */
const MFA_CHALLENGE_TYPE = "mfa";

/**
 * How long a challenge stays usable. Exported so the login response can tell a
 * client how long it has, rather than the client hardcoding a second copy of
 * this number that drifts the moment the token is shortened.
 */
export const MFA_CHALLENGE_TTL_SECONDS = 300;

/** A generated refresh token and the digest to persist for it. */
export interface RefreshTokenPair {
  /** Returned to the client exactly once. Never stored in this form. */
  readonly token: string;
  /** SHA-256 of the token. This is what goes in the database. */
  readonly digest: string;
}

@Injectable()
export class TokenService {
  private readonly signingKey: KeyObject;
  private readonly keyId: string;
  /** Current key, plus the previous one during a rotation — selected by `kid`. */
  private readonly verificationKeys: ReturnType<typeof createLocalJWKSet>;

  constructor(private readonly config: AppConfigService) {
    this.signingKey = createPrivateKey(config.get("JWT_SIGNING_KEY"));
    const current = verificationJwk(createPublicKey(this.signingKey));
    this.keyId = current.kid;
    const previous = config.get("JWT_PREVIOUS_VERIFY_KEY");
    this.verificationKeys = createLocalJWKSet({
      keys: previous === "" ? [current] : [current, verificationJwk(createPublicKey(previous))],
    });
  }

  /** Signs a short-lived access token. */
  async issueAccessToken(principal: Principal): Promise<{ token: string; expiresIn: number }> {
    const expiresIn =
      principal.actorType === "driver"
        ? this.config.get("DRIVER_ACCESS_TTL_SECONDS")
        : this.config.get("JWT_ACCESS_TTL_SECONDS");

    const token = await this.sign(
      {
        tid: principal.tenantId,
        typ: principal.actorType,
        rol: [...principal.roles],
        hub: [...principal.hubScope],
        // Carried in the token so every request is scoped without a lookup. The
        // token is signed, so a merchant cannot widen their own scope by editing it.
        ...(principal.merchantId === null ? {} : { mid: principal.merchantId }),
        sid: principal.sessionId,
      },
      { subject: principal.userId, ttlSeconds: expiresIn, type: ACCESS_TOKEN_TYPE },
    );

    return { token, expiresIn };
  }

  /**
   * Signs a short-lived token proving the PASSWORD step was passed.
   *
   * Deliberately minimal. It carries no roles, no permissions and no merchant
   * scope, and `typ: "mfa"` means {@link authenticate} rejects it outright — so
   * possession of one grants nothing anywhere in the system except the right to
   * present a second factor.
   *
   * Five minutes: long enough to open an authenticator app, short enough that a
   * token captured in transit is worthless by the time it is replayed.
   */
  async issueMfaChallenge(userId: string, tenantId: string): Promise<string> {
    return this.sign(
      { tid: tenantId, typ: MFA_CHALLENGE_TYPE },
      { subject: userId, ttlSeconds: MFA_CHALLENGE_TTL_SECONDS, type: MFA_CHALLENGE_TOKEN_TYPE },
    );
  }

  /**
   * Verifies a challenge token, returning who it belongs to.
   *
   * Returns null for anything that is not a live challenge — including a
   * perfectly valid ACCESS token, which must never be usable here: that would
   * let an existing session skip the second factor for another account.
   */
  async verifyMfaChallenge(token: string): Promise<{ userId: string; tenantId: string } | null> {
    try {
      const payload = await this.verify(token, MFA_CHALLENGE_TOKEN_TYPE);
      if (payload["typ"] !== MFA_CHALLENGE_TYPE) {
        return null;
      }
      const userId = payload.sub;
      const tenantId = payload["tid"];
      if (typeof userId !== "string" || typeof tenantId !== "string") {
        return null;
      }
      return { userId, tenantId };
    } catch {
      // Expired, tampered, or signed with another key. All equally "no".
      return null;
    }
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
      const payload = await this.verify(token, ACCESS_TOKEN_TYPE);

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

  /** The one place a token is signed: algorithm, key id, type, issuer and audience. */
  private async sign(
    claims: Record<string, unknown>,
    options: { readonly subject: string; readonly ttlSeconds: number; readonly type: string },
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: ALGORITHM, kid: this.keyId, typ: options.type })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(options.subject)
      .setIssuedAt()
      .setExpirationTime(`${String(options.ttlSeconds)}s`)
      .sign(this.signingKey);
  }

  /**
   * The one place a token is verified. Throws on any failure; callers map that
   * to null. Pinning the algorithm list prevents `alg: none` and key-confusion
   * attacks; `typ` keeps each token type to its own purpose.
   */
  private async verify(token: string, type: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.verificationKeys, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
      typ: type,
    });
    return payload;
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

/**
 * The public JWK a verifier selects by `kid`. The kid is the RFC 7638
 * thumbprint, derived from the key itself: no setting to keep in step with
 * the key, and two different keys can never share one.
 */
function verificationJwk(publicKey: KeyObject): JWK & { readonly kid: string } {
  const { kty, crv, x } = publicKey.export({ format: "jwk" });
  if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string") {
    // The config schema already refuses any other key; this is the type guard.
    throw new Error("JWT keys must be Ed25519");
  }
  // RFC 7638 §3.2: the required members, lexicographic order, no whitespace.
  const kid = createHash("sha256").update(JSON.stringify({ crv, kty, x })).digest("base64url");
  return { kty, crv, x, kid, alg: ALGORITHM, use: "sig" };
}
