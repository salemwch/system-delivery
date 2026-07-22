import { Injectable } from "@nestjs/common";

import { isPermission } from "../domain/permissions.js";
import type { Permission } from "../domain/permissions.js";
import type { Principal } from "./token.service.js";

/**
 * Authorization decisions.
 *
 * Layer 2 and 3 of the three-layer model in
 * docs/07-security-architecture.md §4.1. Layer 1 — tenant isolation — is
 * enforced by PostgreSQL RLS and is not re-implemented here; this service
 * cannot and must not be the thing that keeps tenants apart.
 */
@Injectable()
export class AccessService {
  /** True when the principal holds the permission. */
  can(principal: Principal, permission: Permission): boolean {
    return principal.permissions.has(permission);
  }

  /** Narrowing variant for permissions arriving as plain strings. */
  canByName(principal: Principal, permission: string): boolean {
    return isPermission(permission) && principal.permissions.has(permission);
  }

  /** True only when EVERY permission is held. */
  canAll(principal: Principal, permissions: readonly Permission[]): boolean {
    return permissions.every((permission) => principal.permissions.has(permission));
  }

  /** True when at least one permission is held. */
  canAny(principal: Principal, permissions: readonly Permission[]): boolean {
    return permissions.some((permission) => principal.permissions.has(permission));
  }

  /**
   * Resource scoping: whether a principal may act on a given hub.
   *
   * An empty `hubScope` means unrestricted. A non-empty scope restricts a
   * Dispatcher or Hub Operator to named hubs, so a compromised account at one
   * facility cannot reach the whole network.
   */
  canAccessHub(principal: Principal, hubId: string): boolean {
    return principal.hubScope.length === 0 || principal.hubScope.includes(hubId);
  }
}
