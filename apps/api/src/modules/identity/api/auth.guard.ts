import { Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { UnauthenticatedError } from "../../../shared/errors/domain-error.js";
import { TokenService } from "../application/token.service.js";
import { IS_PUBLIC_KEY } from "./request-context.js";
import type { AuthenticatedRequest } from "./request-context.js";

/**
 * Authenticates every request from its bearer token.
 *
 * Registered globally, so routes are protected by DEFAULT and must opt out with
 * `@Public()`. Deny-by-default matters: forgetting a decorator then leaves a
 * route locked rather than open.
 *
 * The tenant is taken ONLY from the verified token claim. A client-supplied
 * `X-Tenant-Id` header is never consulted — trusting one would make tenant
 * impersonation a single header away (docs/07-security-architecture.md §5.3).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request.headers.authorization);

    // Public routes still resolve a principal when a valid token is present, so
    // handlers can personalise. They simply do not require one.
    if (token === null) {
      if (isPublic === true) {
        return true;
      }
      throw new UnauthenticatedError();
    }

    // One implementation of "token → Principal", shared with the realtime
    // handshake, so a socket and a request can never disagree about identity.
    const principal = await this.tokens.authenticate(token);

    if (principal === null) {
      if (isPublic === true) {
        return true;
      }
      // Deliberately identical to "no token": expired, tampered, and malformed
      // are indistinguishable to the caller.
      throw new UnauthenticatedError();
    }

    request.principal = principal;

    return true;
  }

  /** Extracts `Authorization: Bearer <token>`, case-insensitively on the scheme. */
  private extractBearerToken(header: string | undefined): string | null {
    if (header === undefined) {
      return null;
    }
    const [scheme, value] = header.split(" ");
    if (scheme === undefined || value === undefined || scheme.toLowerCase() !== "bearer") {
      return null;
    }
    const token = value.trim();
    return token.length > 0 ? token : null;
  }
}
