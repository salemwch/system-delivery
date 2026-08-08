/**
 * Permission constants matching the API's identity/domain/permissions.ts.
 *
 * Used for UI conditional rendering — which nav items, buttons, and fields to
 * show. This is cosmetic only; the API enforces the real boundary.
 */

export const P = {
  SHIPMENT_READ: "shipment:read",
  SHIPMENT_CREATE: "shipment:create",
  SHIPMENT_ASSIGN: "shipment:assign",
  SHIPMENT_CANCEL: "shipment:cancel",
  SHIPMENT_DELIVER: "shipment:deliver",
  SHIPMENT_FAIL: "shipment:fail",
  SHIPMENT_LABEL: "shipment:label",
  SHIPMENT_OVERRIDE: "shipment:override_status",
  /** Decide a requested parcel change. Holding it applies your own on the spot. */
  SHIPMENT_AMEND_APPROVE: "shipment:amend_approve",
  SHIPMENT_UPDATE: "shipment:update",

  PICKUP_READ: "pickup:read",
  PICKUP_CREATE: "pickup:create",
  /** Take the request on: REQUESTED → ACCEPTED. The step before anyone can claim it. */
  PICKUP_ACCEPT: "pickup:accept",
  /** Take a collection run for oneself. Never names anyone else — see PICKUP_ASSIGN. */
  PICKUP_CLAIM: "pickup:claim",
  /** Name who will go. Held by dispatch, deliberately not by a commercial. */
  PICKUP_ASSIGN: "pickup:assign",

  MERCHANT_READ: "merchant:read",
  MERCHANT_CREATE: "merchant:create",
  MERCHANT_UPDATE: "merchant:update",
  /** Mint the merchant's portal login. Held by OWNER and COMMERCIAL only. */
  MERCHANT_ONBOARD: "merchant:onboard",
  /** Move an account between commercials. OWNER only. */
  MERCHANT_ASSIGN_MANAGER: "merchant:assign_manager",
  /** Decide a merchant application. Separate from creating one outright. */
  MERCHANT_DECIDE_APPLICATION: "merchant:decide_application",

  RECIPIENT_READ: "recipient:read",

  ROUTE_READ: "route:read",
  ROUTE_CREATE: "route:create",
  ROUTE_PUBLISH: "route:publish",
  ROUTE_OPTIMIZE: "route:optimize",

  DRIVER_READ: "driver:read",
  DRIVER_CREATE: "driver:create",
  DRIVER_LOCATION_LIVE: "driver:location:read_live",

  VEHICLE_READ: "vehicle:read",
  VEHICLE_MANAGE: "vehicle:manage",

  HUB_READ: "hub:read",
  HUB_MANAGE: "hub:manage",

  MANIFEST_READ: "manifest:read",
  MANIFEST_SEAL: "manifest:seal",
  MANIFEST_RECEIVE: "manifest:receive",

  COD_READ_AMOUNT: "cod:read_amount",
  COD_REMIT_RECEIVE: "cod:remit_receive",
  LEDGER_READ: "ledger:read",
  SETTLEMENT_READ: "settlement:read",
  SETTLEMENT_APPROVE: "settlement:approve",

  SUPPORT_READ: "support:read",
  SUPPORT_WRITE: "support:write",
  /** Assign, recategorise, close, and write internal notes. Never a merchant. */
  SUPPORT_MANAGE: "support:manage",

  /** Internal remarks. Staff-only — no MERCHANT or COMMERCIAL holds either. */
  NOTE_READ: "note:read",
  NOTE_MANAGE: "note:manage",

  COMPLAINT_READ: "complaint:read",
  COMPLAINT_CREATE: "complaint:create",

  USER_READ: "user:read",
  USER_MANAGE: "user:manage",

  AUDIT_READ: "audit:read",
  FEATURE_MANAGE: "feature:manage",
} as const;

/** Nav sections and the permission that gates them. */
export const NAV_GATES = {
  dashboard: null,
  shipments: P.SHIPMENT_READ,
  documents: P.SHIPMENT_LABEL,
  import: P.SHIPMENT_CREATE,
  dispatch: P.ROUTE_READ,
  fleet: P.DRIVER_READ,
  network: P.HUB_READ,
  merchants: P.MERCHANT_READ,
  applications: P.MERCHANT_READ,
  amendments: P.SHIPMENT_READ,
  pickups: P.PICKUP_READ,
  custody: P.MANIFEST_READ,
  finance: P.LEDGER_READ,
  support: P.SUPPORT_READ,
  remarks: P.NOTE_READ,
  complaints: P.COMPLAINT_READ,
  users: P.USER_READ,
  settings: P.FEATURE_MANAGE,
  audit: P.AUDIT_READ,
} as const;
