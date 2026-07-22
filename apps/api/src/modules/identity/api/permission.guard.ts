import { Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { ForbiddenError, UnauthenticatedError } from "../../../shared/errors/domain-error.js";
import { AccessService } from "../application/access.service.js";
import type { Permission } from "../domain/permissions.js";
import { REQUIRED_PERMISSIONS_KEY } from "./request-context.js";
import type { AuthenticatedRequest } from "./request-context.js";

/**
 * Enforces `@RequirePermissions(...)` on a route.
 *
 * Runs after AuthGuard, so a Principal is present for any route that reaches
 * it. This is layer 2 of the three-layer model
 * (docs/07-security-architecture.md §4.1) — layer 1, tenant isolation, is
 * enforced by PostgreSQL RLS and is deliberately NOT re-implemented here.
 *
 * Object-level ownership (OWASP API1/BOLA) is layer 3 and belongs in the
 * handler, after the resource is fetched. A permission check alone never proves
 * the caller owns the specific record they named.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<readonly Permission[] | undefined>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (required === undefined || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;

    if (principal === undefined) {
      // A route declaring permissions but reachable unauthenticated is a
      // configuration error. Fail closed and loudly rather than allowing it.
      throw new UnauthenticatedError();
    }

    if (!this.access.canAll(principal, required)) {
      throw new ForbiddenError(`This action requires: ${required.join(", ")}.`);
    }

    return true;
  }
}
