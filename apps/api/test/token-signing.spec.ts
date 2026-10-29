import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

import { SignJWT, decodeProtectedHeader, decodeJwt } from "jose";
import { describe, expect, it } from "vitest";

import { TokenService } from "../src/modules/identity/application/token.service.js";
import type { Principal } from "../src/modules/identity/application/token.service.js";
import { permissionsForRoles } from "../src/modules/identity/domain/permissions.js";
import { configSchema } from "../src/shared/config/config.schema.js";
import { stubConfig, testSigningKey, verifyKeyOf } from "./config.stub.js";

/**
 * Token signing (Ed25519, RFC 8725 BCP). Each case is an attack the verifier
 * must refuse, or a rotation step it must survive. Pure: no database.
 */
describe("token signing (Ed25519)", () => {
  const principal: Principal = {
    userId: "018f0000-0000-7000-8000-000000000001",
    tenantId: "018f0000-0000-7000-8000-0000000000aa",
    actorType: "user",
    roles: ["OWNER"],
    permissions: permissionsForRoles(["OWNER"]),
    hubScope: [],
    merchantId: null,
    sessionId: "018f0000-0000-7000-8000-000000000002",
  };

  function serviceWith(signingKey: string, previous = ""): TokenService {
    return new TokenService(
      stubConfig({ JWT_SIGNING_KEY: signingKey, JWT_PREVIOUS_VERIFY_KEY: previous }),
    );
  }

  /** A token with the real claims, but a header or registered claim of our choosing. */
  async function forge(
    signingKey: string,
    header: { alg: string; typ?: string; kid?: string },
    claims: { iss?: string; aud?: string } = {},
  ): Promise<string> {
    const issued = await serviceWith(signingKey).issueAccessToken(principal);
    const payload = { ...decodeJwt(issued.token), ...claims };
    return new SignJWT(payload)
      .setProtectedHeader({ kid: kidOf(issued.token), typ: "at+jwt", ...header })
      .sign(createPrivateKey(signingKey));
  }

  /** The `kid` every token this service signs must carry. */
  function kidOf(token: string): string {
    const { kid } = decodeProtectedHeader(token);
    if (kid === undefined) throw new Error("token carries no kid");
    return kid;
  }

  it("signs with Ed25519, a thumbprint kid, at+jwt, issuer and audience", async () => {
    const tokens = serviceWith(testSigningKey());
    const { token } = await tokens.issueAccessToken(principal);

    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe("Ed25519");
    expect(header.typ).toBe("at+jwt");
    expect(header.kid).toMatch(/^[A-Za-z0-9_-]{43}$/u); // base64url SHA-256
    const claims = decodeJwt(token);
    expect(claims.iss).toBe("urn:delivery-platform:api");
    expect(claims.aud).toBe("urn:delivery-platform:api");
    expect(await tokens.verifyAccessToken(token)).toMatchObject({ sub: principal.userId });
  });

  it("refuses an unsigned token (alg: none)", async () => {
    const key = testSigningKey();
    const issued = await serviceWith(key).issueAccessToken(principal);
    const [header, payload] = issued.token.split(".");
    const unsignedHeader = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(header ?? "", "base64url").toString()),
        alg: "none",
      }),
    ).toString("base64url");

    expect(
      await serviceWith(key).verifyAccessToken(`${unsignedHeader}.${payload ?? ""}.`),
    ).toBeNull();
  });

  it("refuses HS256 keyed with the PUBLIC key (algorithm confusion)", async () => {
    const key = testSigningKey();
    const issued = await serviceWith(key).issueAccessToken(principal);
    const publicPem = new TextEncoder().encode(verifyKeyOf(key));
    const confused = await new SignJWT(decodeJwt(issued.token))
      .setProtectedHeader({
        alg: "HS256",
        typ: "at+jwt",
        kid: kidOf(issued.token),
      })
      .sign(publicPem);

    expect(await serviceWith(key).verifyAccessToken(confused)).toBeNull();
  });

  it("refuses the right key with the wrong issuer, audience or type", async () => {
    const key = testSigningKey();
    const tokens = serviceWith(key);

    expect(await tokens.verifyAccessToken(await forge(key, { alg: "Ed25519" }))).not.toBeNull();
    expect(
      await tokens.verifyAccessToken(await forge(key, { alg: "Ed25519" }, { iss: "urn:evil" })),
    ).toBeNull();
    expect(
      await tokens.verifyAccessToken(await forge(key, { alg: "Ed25519" }, { aud: "urn:evil" })),
    ).toBeNull();
    expect(
      await tokens.verifyAccessToken(await forge(key, { alg: "Ed25519", typ: "JWT" })),
    ).toBeNull();
  });

  it("keeps an MFA challenge and an access token each to its own purpose", async () => {
    const tokens = serviceWith(testSigningKey());
    const challenge = await tokens.issueMfaChallenge(principal.userId, principal.tenantId);
    const access = await tokens.issueAccessToken(principal);

    expect(decodeProtectedHeader(challenge).typ).toBe("mfa-challenge+jwt");
    expect(await tokens.verifyAccessToken(challenge)).toBeNull();
    expect(await tokens.verifyMfaChallenge(access.token)).toBeNull();
    expect(await tokens.verifyMfaChallenge(challenge)).toEqual({
      userId: principal.userId,
      tenantId: principal.tenantId,
    });
  });

  it("rotates: the outgoing key verifies only while named as the previous key", async () => {
    const outgoing = testSigningKey();
    const incoming = testSigningKey();
    const old = await serviceWith(outgoing).issueAccessToken(principal);

    const duringRotation = serviceWith(incoming, verifyKeyOf(outgoing));
    expect(await duringRotation.verifyAccessToken(old.token)).not.toBeNull();
    const fresh = await duringRotation.issueAccessToken(principal);
    expect(kidOf(fresh.token)).not.toBe(kidOf(old.token));

    const afterRotation = serviceWith(incoming);
    expect(await afterRotation.verifyAccessToken(old.token)).toBeNull();
    expect(await afterRotation.verifyAccessToken(fresh.token)).not.toBeNull();
  });

  it("refuses a token signed by any other key", async () => {
    const foreign = await serviceWith(testSigningKey()).issueAccessToken(principal);
    expect(await serviceWith(testSigningKey()).verifyAccessToken(foreign.token)).toBeNull();
  });

  it("derives a stable kid from the key itself", async () => {
    const key = testSigningKey();
    const a = await serviceWith(key).issueAccessToken(principal);
    const b = await serviceWith(key).issueAccessToken(principal);
    expect(kidOf(a.token)).toBe(kidOf(b.token));
    // The public half alone is enough to verify: what a future verifier holds.
    expect(createPublicKey(verifyKeyOf(key)).asymmetricKeyType).toBe("ed25519");
  });
});

/** The env boundary: a key that would sign wrongly must stop the API booting. */
describe("JWT key configuration", () => {
  const signing = configSchema.shape.JWT_SIGNING_KEY;
  const previous = configSchema.shape.JWT_PREVIOUS_VERIFY_KEY;
  const escaped = (pem: string) => pem.trim().replace(/\n/gu, "\n");

  it("accepts a one-line escaped Ed25519 PKCS#8 key and yields real PEM", () => {
    const key = testSigningKey();
    const parsed = signing.safeParse(escaped(key));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toBe(key.trim());
  });

  it("refuses an empty, garbage, RSA, or public key as the signing key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    for (const value of ["", "not-a-key", rsa, verifyKeyOf(testSigningKey())]) {
      expect(signing.safeParse(value).success).toBe(false);
    }
  });

  it("takes an empty or Ed25519 SPKI previous key, never a private one", () => {
    expect(previous.safeParse(undefined).data).toBe("");
    expect(previous.safeParse(escaped(verifyKeyOf(testSigningKey()))).success).toBe(true);
    expect(previous.safeParse("garbage").success).toBe(false);
  });
});
