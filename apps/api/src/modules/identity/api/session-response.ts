import type { AuthSession } from "../application/auth.service.js";

/**
 * The ONE shape every endpoint that mints a session returns.
 *
 * Three do: `POST /v1/auth/login`, `POST /v1/auth/mfa/challenge`, and
 * `POST /v1/auth/mfa/bootstrap/confirm`. They used to return three different
 * shapes — only `login` carried `user`, and the other two returned bare tokens.
 *
 * That broke every client that completed a login through MFA: a caller parsed
 * the login response, then reached the same code path after a TOTP challenge
 * and found no `user` to read an id or a permission list from. `apps/web` threw
 * "malformed session response" and reported it as invalid credentials, so no
 * OWNER or FINANCE account could sign in at all.
 *
 * A discriminated `status` rather than "check which fields are present": a
 * client switches on one field, and adding a future state cannot be mistaken
 * for a session.
 */
export interface SessionResponse {
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
 * Maps an issued session onto the wire.
 *
 * `permissions` is spread out of its Set — a Set serialises to `{}` in JSON,
 * which would send an empty object where the client expects a list and silently
 * leave every UI gate closed.
 */
export function toSessionResponse(session: AuthSession): SessionResponse {
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
