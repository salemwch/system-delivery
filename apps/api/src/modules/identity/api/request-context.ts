import { SetMetadata, createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { UnauthenticatedError } from "../../../shared/errors/domain-error.js";
import type { Permission } from "../domain/permissions.js";
import type { Principal } from "../application/token.service.js";

/** A request that has passed authentication carries its Principal. */
export type AuthenticatedRequest = FastifyRequest & { principal?: Principal };

export const IS_PUBLIC_KEY = "identity:isPublic";
export const REQUIRED_PERMISSIONS_KEY = "identity:requiredPermissions";

/**
 * Marks a route as reachable without authentication.
 *
 * Used only for login, token refresh, health, and the public tracking page.
 * Authentication is deny-by-default: a route is protected unless it explicitly
 * opts out here, so forgetting the decorator fails closed.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Declares the permissions a route requires. ALL listed are required.
 *
 * Typed as `Permission`, so a misspelled permission is a compile error rather
 * than a check that silently never passes — or worse, never runs.
 */
export const RequirePermissions = (
  ...permissions: readonly [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/**
 * Injects the authenticated Principal into a handler parameter.
 *
 * Throws rather than returning undefined: reaching a handler without a
 * principal means the guard was misconfigured, and failing loudly beats
 * handing business logic an undefined identity.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.principal === undefined) {
      throw new UnauthenticatedError(
        "No authenticated principal on this request — the route is missing AuthGuard.",
      );
    }
    return request.principal;
  },
);
