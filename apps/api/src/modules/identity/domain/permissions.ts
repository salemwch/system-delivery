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
  /**
   * Render a parcel's scannable label. Separate from `shipment:read` because a
   * label is the physical token that starts the custody chain — a role that may
   * look at a shipment does not necessarily get to print one.
   */
  "shipment:label",

  // Pickup requests
  "pickup:read",
  "pickup:create",
  "pickup:accept",
  /** Name who will go and collect. Implies routing another person's work. */
  "pickup:assign",
  /**
   * Take a collection run for ONESELF.
   *
   * Deliberately not `pickup:assign`. The claim command reads the collector
   * from the token, so its holder can only ever assign themselves — a field
   * commercial can collect their own merchants' parcels without gaining the
   * ability to dispatch a fleet of hundreds.
   */
  "pickup:claim",
  "pickup:collect",

  // Merchants (the businesses that ship through the tenant — never "customer")
  "merchant:read",
  "merchant:create",
  "merchant:update",
  "merchant:block",
  /**
   * Mint the merchant's own portal login.
   *
   * Deliberately NOT `user:manage`. Onboarding an *expéditeur* has to create
   * credentials, but `user:manage` creates credentials for ANY role — a
   * commercial holding it could mint themselves an OWNER. This permission can
   * only ever produce a MERCHANT login, for a merchant the caller manages.
   */
  "merchant:onboard",
  /** Hand an account to a commercial, or take it back. Owner-only. */
  "merchant:assign_manager",

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
  // Reporting one's own GPS position. Held by drivers only — a dispatcher has no
  // location to report, and the server additionally requires an open shift.
  "telemetry:write",
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
  "MERCHANT",
  "COMMERCIAL",
] as const;

export type Role = (typeof ROLES)[number];

/**
 * The role whose visibility is narrowed to the merchants it manages.
 *
 * Named once here so the portfolio rule cannot be restated — and drift — in the
 * interceptor, the realtime handshake, or a future consumer.
 */
const ACCOUNT_MANAGER_ROLE = "COMMERCIAL";

/**
 * The portfolio scope a caller carries, or null for none (invariant I25).
 *
 * A commercial's scope is their own user id: `merchants.account_manager_id`
 * points at it, and RLS reads it from `app.current_account_manager_id`. Unlike
 * a merchant's `mid` this is NOT a separate token claim — it is derived from
 * claims already signed (`sub` and `rol`), so there is no third value that
 * could disagree with the other two.
 *
 * Structurally typed rather than taking a Principal: this file is the bottom of
 * the identity module and imports nothing.
 */
export function accountManagerScope(principal: {
  readonly roles: readonly Role[];
  readonly userId: string;
}): string | null {
  return principal.roles.includes(ACCOUNT_MANAGER_ROLE) ? principal.userId : null;
}

const ROLE_SET: ReadonlySet<string> = new Set<string>(ROLES);

/**
 * Narrows an arbitrary string to a known Role.
 *
 * The database stores `user_roles.role` as TEXT behind a CHECK constraint, so a
 * row read back is `string` to TypeScript. This is the one place that turns it
 * into a `Role` — an unrecognised value is dropped rather than trusted, so a
 * role added by a future migration but unknown to this build grants nothing.
 */
export function isRole(value: string): value is Role {
  return ROLE_SET.has(value);
}

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
    "telemetry:write",
    "manifest:read",
    "cod:collect",
    "complaint:create",
  ],

  /**
   * The *commercial* — the field salesperson who signs the *expéditeur* up,
   * collects their parcels in person, and stays the named contact afterwards
   * (docs/01-mvp-scope.md §6, added 2026-08-05).
   *
   * ⚠️ Like MERCHANT, this list is narrower than it reads. Every merchant-facing
   * permission below applies only to the merchants this user MANAGES —
   * `merchants.account_manager_id = their user id` — narrowed by RLS through
   * `app.current_account_manager_id` (migration 0030, invariant I25). A
   * permission list alone would grant the whole tenant, which for this role
   * would mean reading a rival commercial's book of business.
   *
   * Deliberately ABSENT, and each for its own reason:
   *
   *  - `recipient:*` — recipients are tenant-scoped by design (RM-R1, migration
   *    0021) and carry no merchant, so RLS cannot narrow them. Granting the read
   *    would hand over the tenant's entire customer list, which is the single
   *    most valuable thing a departing salesperson could walk out with.
   *  - `merchant:block` — suspending an account is the courier's commercial
   *    decision, not the salesperson's. They raise it; an OWNER acts on it.
   *  - `merchant:assign_manager` — otherwise a commercial could help themselves
   *    to a colleague's accounts, which is precisely the escalation the
   *    portfolio scope exists to prevent.
   *  - `pickup:assign` — they hold `pickup:claim` instead. Assigning names any
   *    collector; claiming can only name the caller.
   *  - `user:manage` — see `merchant:onboard`. Minting arbitrary logins is not
   *    the same job as minting a merchant's portal login.
   *  - routes, drivers, vehicles, hubs, manifests — the operations plane. A
   *    commercial hands parcels over at the hub and is done.
   */
  COMMERCIAL: [
    // Their book of business.
    "merchant:read",
    "merchant:create",
    "merchant:update",
    "merchant:onboard",
    // The collection run: request it, take it on, take it OUT themselves, and
    // scan the parcels in. `pickup:claim` rather than `pickup:assign` — see the
    // permission's own note; a commercial routes nobody's work but their own.
    "pickup:read",
    "pickup:create",
    "pickup:accept",
    "pickup:claim",
    "pickup:collect",
    // What they collected, and the label that starts its custody chain.
    "shipment:read",
    "shipment:label",
    "address:read",
    // "How is my client doing?" — the two numbers a salesperson is asked for.
    "cod:read_amount",
    "settlement:read",
    // Raise, and follow, a problem on behalf of their merchant.
    "complaint:read",
    "complaint:create",
  ],

  // Cross-tenant support access. Every action is audited and the tenant owner
  // is notified (docs/07-security-architecture.md §10).
  PLATFORM_ADMIN: ["tenant:update", "feature:manage", "audit:read", "user:read"],

  /**
   * The *expéditeur* — the shipper who hands parcels to the courier
   * (docs/01-mvp-scope.md §6, added 2026-07-29).
   *
   * ⚠️ Holding a permission here grants it only over the merchant's OWN rows.
   * MERCHANT is the one role scoped BELOW the tenant, so every permission in
   * this list is read as "…for my own merchant" and is narrowed again by
   * `users.merchant_id` (invariant I24). A permission list alone would grant
   * tenant-wide access, which for this role would mean reading competitors'
   * shipment volume, customers, and revenue.
   *
   * Deliberately ABSENT: anything to do with routes, drivers, vehicles, hubs,
   * manifests, or other merchants. A merchant is a customer of the tenant, not
   * a member of it — they see their parcels and their money, never the courier's
   * operations.
   *
   * ALSO ABSENT, and PERMANENTLY so: `recipient:*`. This is settled, not
   * pending — open decision RM-R1 (docs/02-domain-model.md §3.19) was resolved
   * on 2026-07-29 in favour of leaving `recipients` tenant-scoped.
   *
   * The table is one row per person on purpose, so address quality, delivery
   * history, and above all the repeat-refuser block-list accumulate across the
   * whole tenant. Splitting it per merchant would defeat all three. A merchant
   * therefore never reads it; they read `GET /v1/address-book`, a projection of
   * their OWN shipments that RLS already narrows (migration 0020), which is
   * precisely the "recipients the merchant has actually shipped to" that RM-R1
   * called for. See migration 0021 for the full reasoning and the measurements
   * that ruled out the alternative.
   */
  MERCHANT: [
    // Their own parcels, end to end.
    "shipment:read",
    "shipment:create",
    "shipment:update",
    "shipment:cancel",
    // The physical token that starts the custody chain.
    "shipment:label",
    // Ask the courier to come and collect.
    "pickup:read",
    "pickup:create",
    "address:read",
    // "How much am I owed?" — the question a merchant asks most.
    "cod:read_amount",
    "settlement:read",
    // Raise a problem with their own parcel.
    "complaint:create",
    "complaint:read",
  ],
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
