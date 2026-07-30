/**
 * The operating configuration a courier company starts life with.
 *
 * ⚠️ These exist in TypeScript because a MIGRATION ONLY EVER REACHES THE TENANTS
 * THAT EXIST WHEN IT RUNS. Migration 0026 seeded the same values with a
 * `CROSS JOIN tenants`, which read as "every tenant gets these" and meant "every
 * tenant provisioned before this deploy". Every courier onboarded afterwards had
 * an empty failure taxonomy — so `decideReattempt` found no row for
 * `CUSTOMER_REFUSED`, failed open, and drove out to a customer who had already
 * said no, twice more, before returning the parcel. Exactly the waste that
 * module was built to stop, reintroduced by where the data lived.
 *
 * `TenantService.provision` now seeds from here, inside the provisioning
 * transaction, so the guarantee is "every tenant" without a qualifier.
 *
 * Defaults, not policy: every value is a row the tenant can change through
 * `/v1/operating-config`.
 *
 * Pure data — no I/O, no imports.
 */

export interface DefaultFailureReason {
  readonly code: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly allowsReattempt: boolean;
  readonly fault: "RECIPIENT" | "COURIER" | "MERCHANT" | "EXTERNAL";
  readonly displayOrder: number;
}

/** Ordered by how often a Tunisian driver actually picks them. */
export const DEFAULT_FAILURE_REASONS: readonly DefaultFailureReason[] = [
  {
    code: "CUSTOMER_UNAVAILABLE",
    labels: { ar: "العميل غير متوفر", fr: "Client absent", en: "Customer unavailable" },
    allowsReattempt: true,
    fault: "RECIPIENT",
    displayOrder: 10,
  },
  {
    code: "CUSTOMER_UNREACHABLE",
    labels: { ar: "تعذر الاتصال بالعميل", fr: "Client injoignable", en: "Customer unreachable" },
    allowsReattempt: true,
    fault: "RECIPIENT",
    displayOrder: 20,
  },
  {
    code: "INSUFFICIENT_CASH",
    labels: { ar: "نقص في السيولة", fr: "Fonds insuffisants", en: "Insufficient cash" },
    allowsReattempt: true,
    fault: "RECIPIENT",
    displayOrder: 30,
  },
  {
    code: "WRONG_ADDRESS",
    labels: { ar: "عنوان خاطئ", fr: "Mauvaise adresse", en: "Wrong address" },
    allowsReattempt: true,
    fault: "MERCHANT",
    displayOrder: 40,
  },
  {
    code: "ACCESS_RESTRICTED",
    labels: { ar: "دخول ممنوع", fr: "Accès restreint", en: "Access restricted" },
    allowsReattempt: true,
    fault: "EXTERNAL",
    displayOrder: 50,
  },
  // The two that must NOT be re-attempted. Driving out again after a refusal is
  // a wasted trip plus a return leg, and a damaged parcel does not heal in a van.
  {
    code: "CUSTOMER_REFUSED",
    labels: { ar: "رفض العميل", fr: "Refus du client", en: "Customer refused" },
    allowsReattempt: false,
    fault: "RECIPIENT",
    displayOrder: 60,
  },
  {
    code: "DAMAGED_PACKAGE",
    labels: { ar: "طرد تالف", fr: "Colis endommagé", en: "Damaged package" },
    allowsReattempt: false,
    fault: "COURIER",
    displayOrder: 70,
  },
];

export interface DefaultWorkingDay {
  readonly dayOfWeek: number;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly isWorking: boolean;
}

/** Monday–Friday 08:00–18:00, Saturday 08:00–13:00, Sunday closed — the Tunisian norm. */
export const DEFAULT_WORKING_WEEK: readonly DefaultWorkingDay[] = [
  { dayOfWeek: 1, opensAt: "08:00", closesAt: "18:00", isWorking: true },
  { dayOfWeek: 2, opensAt: "08:00", closesAt: "18:00", isWorking: true },
  { dayOfWeek: 3, opensAt: "08:00", closesAt: "18:00", isWorking: true },
  { dayOfWeek: 4, opensAt: "08:00", closesAt: "18:00", isWorking: true },
  { dayOfWeek: 5, opensAt: "08:00", closesAt: "18:00", isWorking: true },
  { dayOfWeek: 6, opensAt: "08:00", closesAt: "13:00", isWorking: true },
  { dayOfWeek: 7, opensAt: "08:00", closesAt: "18:00", isWorking: false },
];

export interface DefaultSlaTemplate {
  readonly serviceLevel: string;
  readonly deliveryHours: number;
  readonly reattemptDelayHours: number;
  readonly maxAttempts: number;
}

/**
 * One per `shipments.service_level`. All three, because a level with no template
 * gets no promised-by date and falls back to a hardcoded re-attempt delay
 * instead of the tenant's own — silently, since nothing errors.
 *
 * Hours are WORKING hours: 24 of them is roughly two-and-a-half Tunisian days.
 */
export const DEFAULT_SLA_TEMPLATES: readonly DefaultSlaTemplate[] = [
  { serviceLevel: "STANDARD", deliveryHours: 48, reattemptDelayHours: 24, maxAttempts: 3 },
  { serviceLevel: "EXPRESS", deliveryHours: 24, reattemptDelayHours: 12, maxAttempts: 3 },
  // The customer chose the slot, so the window is wider and missing it is not
  // the same failure as missing an express promise.
  { serviceLevel: "SCHEDULED", deliveryHours: 72, reattemptDelayHours: 24, maxAttempts: 3 },
];
