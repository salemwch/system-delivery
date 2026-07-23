/**
 * Permission catalogue and role definitions.
 *
 * Implements docs/07-security-architecture.md §4.2. Permissions are
 * `resource:action` verbs; roles are bundles of them.
 *
 * Everything here is a compile-time constant. A typo in a permission name must
 * be a build error, never a silently-denied (or silently-granted) check — an
 * authorization system whose keys are loose strings will eventually grant
 * something it should not.
 */

export const PERMISSIONS = [
  // Shipment
  "shipment:read",
  "shipment:create",
  "shipment:update",
  "shipment:assign",
  "shipment:cancel",
  "shipment:override_status",
  "shipment:deliver",
  "shipment:fail",

  // Pickup requests
  "pickup:read",
  "pickup:create",
  "pickup:accept",
  "pickup:assign",
  "pickup:collect",

  // Merchants (the businesses that ship through the tenant — never "customer")
  "merchant:read",
  "merchant:create",
  "merchant:update",
  "merchant:block",

  // Recipients (the address book — never called "customer", invariant I18)
  "recipient:read",
  "recipient:create",
  "recipient:update",
  "recipient:block",

  // Addresses (the address-quality pipeline; directory owns it)
  "address:read",
  "address:correct",

  // Routes and dispatch
  "route:read",
  "route:create",
  "route:publish",
  "route:optimize",

  // Fleet and workforce
  "driver:read",
  "driver:create",
  "driver:update",
  "driver:location:read_live",
  "driver:location:read_history",
  "vehicle:read",
  "vehicle:manage",
  "shift:start",
  "shift:end",

  // Network
  "hub:read",
  "hub:manage",
  "manifest:read",
  "manifest:seal",
  "manifest:receive",

  // Money
  "cod:read_amount",
  "cod:collect",
  "cod:remit_receive",
  "ledger:read",
  "ledger:adjust",
  "settlement:read",
  "settlement:approve",
  "settlement:mark_paid",

  // Complaints
  "complaint:read",
  "complaint:create",
  "complaint:assign",
  "complaint:resolve",

  // Administration
  "user:read",
  "user:manage",
  "role:assign",
  "feature:manage",
  "tenant:update",
  "pii:export",
  "audit:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

/** Narrows an arbitrary string to a known Permission. */
export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

export const ROLES = [
  "OWNER",
  "DISPATCHER",
  "HUB_OPERATOR",
  "FINANCE",
  "DRIVER",
  "PLATFORM_ADMIN",
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Role → permission bundles (docs/07-security-architecture.md §4.2).
 *
 * Two deliberate decisions worth defending:
 *
 *  - DISPATCHER does NOT get `cod:read_amount`. Dispatchers do not need cash
 *    figures to dispatch, and excluding them shrinks the blast radius of the
 *    most numerous and least-hardened account type.
 *
 *  - FINANCE is read-only on operations. Separation of duties: whoever
 *    reconciles cash must not also be able to alter delivery status to conceal
 *    a discrepancy.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  OWNER: PERMISSIONS,

  DISPATCHER: [
    "shipment:read",
    "shipment:create",
    "shipment:update",
    "shipment:assign",
    "shipment:cancel",
    "shipment:override_status",
    "pickup:read",
    "pickup:create",
    "pickup:accept",
    "pickup:assign",
    "merchant:read",
    "merchant:create",
    "merchant:update",
    "recipient:read",
    "recipient:create",
    "recipient:update",
    "address:read",
    "route:read",
    "route:create",
    "route:publish",
    "route:optimize",
    "driver:read",
    "driver:location:read_live",
    "driver:location:read_history",
    "vehicle:read",
    "hub:read",
    "manifest:read",
    "complaint:read",
    "complaint:create",
    "complaint:assign",
  ],

  HUB_OPERATOR: [
    "shipment:read",
    "pickup:read",
    "pickup:collect",
    "merchant:read",
    "recipient:read",
    "address:read",
    "route:read",
    "driver:read",
    "driver:location:read_live",
    "vehicle:read",
    "hub:read",
    "manifest:read",
    "manifest:seal",
    "manifest:receive",
    "cod:remit_receive",
    "complaint:read",
    "complaint:create",
  ],

  FINANCE: [
    "shipment:read",
    "merchant:read",
    "recipient:read",
    "address:read",
    "route:read",
    "driver:read",
    "hub:read",
    "manifest:read",
    "cod:read_amount",
    "cod:remit_receive",
    "ledger:read",
    "ledger:adjust",
    "settlement:read",
    "settlement:approve",
    "settlement:mark_paid",
    "complaint:read",
    "complaint:resolve",
    "pii:export",
    "audit:read",
  ],

  DRIVER: [
    "shipment:read",
    "shipment:deliver",
    "shipment:fail",
    "pickup:read",
    "pickup:collect",
    "recipient:read",
    "address:read",
    "address:correct",
    "route:read",
    "shift:start",
    "shift:end",
    "manifest:read",
    "cod:collect",
    "complaint:create",
  ],

  // Cross-tenant support access. Every action is audited and the tenant owner
  // is notified (docs/07-security-architecture.md §10).
  PLATFORM_ADMIN: ["tenant:update", "feature:manage", "audit:read", "user:read"],
};

/** Roles that must have MFA enabled before they can authenticate. */
export const MFA_REQUIRED_ROLES: ReadonlySet<Role> = new Set<Role>([
  "OWNER",
  "FINANCE",
  "PLATFORM_ADMIN",
]);

/** Resolves the union of permissions granted by a set of roles. */
export function permissionsForRoles(roles: readonly Role[]): ReadonlySet<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      granted.add(permission);
    }
  }
  return granted;
}
