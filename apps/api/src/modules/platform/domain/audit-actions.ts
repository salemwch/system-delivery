/**
 * The audit action catalogue.
 *
 * docs/07-security-architecture.md §10 enumerates what MUST be audited. This
 * list is that requirement made into a type: a typo in an action name is a
 * build error, and the mandatory set cannot silently shrink because someone
 * renamed a string.
 *
 * Names follow `domain.action`, past tense — the same convention as domain
 * events. They are NOT domain events: an event says something happened to the
 * business, an audit action says someone did something and who. A single
 * operation frequently produces both, and they answer different questions.
 */
export const AUDIT_ACTIONS = [
  // ── Authentication (§10: success AND failure) ──────────────────────────────
  // Failures are the load-bearing half. A brute-force attempt is invisible
  // without them, and they are the reason `ANONYMOUS` is an actor type.
  "auth.login_succeeded",
  "auth.login_failed",
  "auth.logout",
  "auth.token_refreshed",
  "auth.refresh_reuse_detected",
  "auth.account_locked",
  "auth.mfa_enrolled",
  "auth.mfa_challenge_failed",
  "auth.mfa_reset",

  // ── Users, permissions, roles (§10) ────────────────────────────────────────
  "user.created",
  "user.updated",
  "user.disabled",
  "user.enabled",
  "user.password_reset",
  "user.role_granted",
  "user.role_revoked",

  // ── Merchant account ownership ─────────────────────────────────────────────
  // Moving an account between commercials moves who can see its shipments,
  // customers and revenue (invariant I25). That is a change of access, which
  // §10 makes mandatory to record, even though nothing about the merchant's own
  // data changed.
  "merchant.account_manager_assigned",

  // Deciding who becomes a customer. An approval creates a merchant and, when a
  // commercial makes it, hands them the account; a rejection turns a business
  // away. Both are commercial decisions someone will eventually be asked to
  // justify, and neither leaves a trace anywhere else — a rejected application
  // produces no merchant, no shipment, and no ledger entry.
  "merchant.application_approved",
  "merchant.application_rejected",

  // ── Tenant lifecycle and configuration (§10) ───────────────────────────────
  "tenant.provisioned",
  "tenant.updated",
  "tenant.suspended",
  "tenant.reactivated",
  "feature.changed",

  // ── Shipments — status overrides only ──────────────────────────────────────
  // A normal delivery is already in the immutable custody log; duplicating it
  // here would bury the entries that matter. An OVERRIDE is different: it is a
  // human asserting a status the custody chain did not produce.
  "shipment.status_overridden",
  "shipment.cancelled",
  // A parcel changed after creation — modification colis. The shipment row only
  // ever shows the current recipient and address, so "the driver called the
  // wrong number" has no answer six weeks later without this.
  "shipment.amended",

  // ── Money (§10: all ledger adjustments, variance, approvals) ───────────────
  "ledger.adjusted",
  "remittance.confirmed_with_variance",
  "remittance.disputed",
  "settlement.approved",
  "settlement.marked_paid",
  "cod.amount_changed",
  // Approving a dépense moves real money out of a cash box or a bank account and
  // posts a ledger transaction. A rejection produces nothing anywhere else, so
  // without this entry there is no record that a claim was ever refused.
  "expense.approved",
  "expense.rejected",

  // ── Invoicing ─────────────────────────────────────────────────────────────
  // An invoice is a tax document. Issuing one creates a legal obligation and
  // consumes a number that can never be reused, so the trail records who did
  // it and what number it took.
  "invoice.drafted",
  "invoice.issued",
  "invoice.paid",
  "invoice.cancelled",
  "credit_note.drafted",

  // ── Tariffs ────────────────────────────────────────────────────────────────
  // What a city costs to deliver to is a price list. Changing it re-prices every
  // shipment created afterwards, and the question a billing dispute asks is
  // "what was the tariff on the 3rd, and who changed it?" — which only a trail
  // can answer, because the table itself holds only the current value.
  "city.tariff_changed",

  // ── Privacy (§10) ──────────────────────────────────────────────────────────
  "pii.exported",
  "tracking_token.bulk_issued",
  "driver.location_history_read",

  // ── Platform Admin (§10: EVERY action) ─────────────────────────────────────
  // Cross-tenant support access. The tenant owner is additionally notified —
  // support access without the customer's knowledge is a trust failure,
  // whatever the contract permits.
  "platform_admin.tenant_accessed",
  "platform_admin.action_performed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set<string>(AUDIT_ACTIONS);

/** Narrows an arbitrary string to a known audit action. */
export function isAuditAction(value: string): value is AuditAction {
  return ACTION_SET.has(value);
}
