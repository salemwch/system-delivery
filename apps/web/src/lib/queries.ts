import { apiFetch } from "./api";

/**
 * The envelope EVERY list endpoint returns (docs/05-api-contracts.md).
 *
 * Modelled separately from {@link PaginatedResult} because the two are not the
 * same shape, and pretending they were is what made "Load more" invisible on
 * every list in this app: the pages read `result.cursor`, the API sends
 * `page.nextCursor`, and `undefined !== null` so the link never rendered.
 */
interface ApiPage<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * A page as the UI consumes it.
 *
 * No `total`: the API deliberately does not count. Cursor pagination exists so
 * a list never pays for a `COUNT(*)` over a growing table, and inventing the
 * field here would only tempt a page to render `undefined`.
 */
export interface PaginatedResult<T> {
  readonly data: readonly T[];
  readonly cursor: string | null;
}

export interface ShipmentSummary {
  readonly id: string;
  readonly trackingNumber: string;
  readonly status: string;
  readonly recipientName: string;
  readonly recipientPhone: string;
  /** No merchant NAME on the list — only the id. Resolve it if you need one. */
  readonly merchantId: string | null;
  readonly currency: string;
  /** Minor units as a decimal STRING. A bigint; parsing it as a number rounds. */
  readonly codAmountMinor: string;
  /** ISO 4217 exponent for `currency`. TND is 3 — never hardcode it. */
  readonly currencyExponent: number;
  readonly codStatus: string;
  readonly serviceLevel: string;
  readonly parcelCount: number;
  readonly weightGrams: number;
  readonly attemptCount: number;
  readonly createdAt: string;
}

/** Only the single-row route resolves addresses; the list returns ids. */
export interface ShipmentDetail extends ShipmentSummary {
  readonly senderName: string;
  readonly senderPhone: string;
  readonly origin: Address;
  readonly destination: Address;
  readonly promisedTo: string | null;
  readonly maxAttempts: number;
  readonly updatedAt: string;
}

interface Address {
  readonly rawInput: string;
  readonly line1: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly countryCode: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly accessNotes: string | null;
}

/** `GET /v1/shipments/:id/events` — a separate call, never embedded. */
export interface ShipmentEvent {
  readonly id: string;
  readonly sequence: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly actorType: string;
  readonly reasonCode: string | null;
}

export interface DriverSummary {
  readonly id: string;
  readonly fullName: string;
  readonly employeeCode: string;
  readonly phone: string;
  readonly status: string;
  readonly employmentType: string;
  readonly homeHubId: string | null;
  readonly defaultVehicleId: string | null;
}

export interface VehicleSummary {
  readonly id: string;
  readonly plateNumber: string;
  readonly type: string;
  readonly status: string;
}

export interface MerchantSummary {
  readonly id: string;
  readonly name: string;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly status: string;
  /** The COMMERCIAL who owns this account. `null` = house-managed. */
  readonly accountManagerId: string | null;
  readonly createdAt: string;
}

export interface MerchantDetail extends MerchantSummary {
  readonly code: string | null;
  readonly contactEmail: string | null;
  readonly blockReason: string | null;
  /**
   * Where the courier collects. `null` means no pickup can be requested for
   * this merchant at all — the command requires an address id.
   */
  readonly defaultPickupAddressId: string | null;
  readonly updatedAt: string;
}

/** One merchant's shipment performance (`GET /v1/shipments/merchant/:id/stats`). */
export interface MerchantStats {
  readonly merchantId: string;
  readonly totalShipments: number;
  readonly byStatus: readonly { readonly status: string; readonly count: number }[];
  readonly deliveryRate: number;
  readonly avgAttemptsPerDelivery: number;
  /** Minor units as a decimal STRING — a bigint that would lose precision as a number. */
  readonly totalCodMinor: string;
  readonly deliveredCodMinor: string;
  readonly currency: string;
  /** ISO 4217 minor-unit exponent from the API. TND is 3, never assume 2. */
  readonly currencyExponent: number;
}

export interface HubSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  /** An id, not text. There is no address endpoint to resolve it. */
  readonly addressId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: string;
  readonly status: string;
}

export interface RouteSummary {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  /** No driver NAME — the route carries an id only. */
  readonly driverId: string | null;
  readonly vehicleId: string | null;
  readonly plannedDate: string;
  readonly stopCount: number;
  /** Metres, and null until the route is optimised. */
  readonly plannedDistanceM: number | null;
  readonly actualDistanceM: number | null;
  readonly createdAt: string;
}

export interface ManifestSummary {
  readonly id: string;
  readonly code: string;
  readonly type: string;
  readonly status: string;
  readonly fromHubId: string | null;
  readonly toHubId: string | null;
  readonly fromDriverId: string | null;
  readonly toDriverId: string | null;
  /** Parcels on the manifest. Named itemCount by the API, not shipmentCount. */
  readonly itemCount: number;
  readonly discrepancyCount: number;
  readonly createdAt: string;
}

export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly roles: readonly string[];
  readonly status: string;
  readonly mfaEnabled: boolean;
  readonly merchantId: string | null;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
}

export interface ComplaintSummary {
  readonly id: string;
  readonly code: string;
  readonly type: string;
  readonly status: string;
  /** The API calls this SEVERITY. There is no `priority` field. */
  readonly severity: string;
  readonly shipmentId: string | null;
  readonly merchantId: string | null;
  readonly description: string;
  readonly slaDueAt: string | null;
  readonly slaBreached: boolean;
  readonly createdAt: string;
}

/**
 * An audit entry as `GET /v1/audit` returns it.
 *
 * ⚠️ Every field here was once named for a table that does not exist —
 * entityType/entityId/userId/userEmail/detail. The trail records a RESOURCE and
 * an ACTOR, and `resourceId` is nullable: a failed login names no resource.
 */
export interface AuditEntry {
  readonly id: string;
  readonly action: string;
  readonly outcome: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly actorType: string;
  readonly actorId: string | null;
  /** The email attempted, when there is one. Never a joined user record. */
  readonly actorLabel: string | null;
  readonly changes: unknown;
  readonly context: unknown;
  readonly ipAddress: string | null;
  readonly createdAt: string;
}

/**
 * A pickup request as `GET /v1/pickups` actually returns it.
 *
 * ⚠️ An earlier version of this interface invented `parcelCount` and
 * `scheduledAt`; neither exists and both rendered as `undefined`. `merchantName`
 * is real now — the list route resolves it through directory in one batched
 * lookup — but it is NULLABLE, so render a fallback rather than assuming.
 */
export interface PickupSummary {
  readonly id: string;
  /** Tenant-facing reference, e.g. PU-4K2M-9XQ1. */
  readonly code: string;
  readonly merchantId: string;
  /** Null when the merchant is outside the caller's scope. Never assume a name. */
  readonly merchantName: string | null;
  readonly status: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly requestedWindowFrom: string;
  readonly requestedWindowTo: string;
  readonly estimatedParcelCount: number;
  /** Null until the run is collected — then it is what was actually scanned. */
  readonly actualParcelCount: number | null;
  /** Who is going to collect. Not necessarily a driver — a commercial may claim it. */
  readonly assignedDriverId: string | null;
  readonly createdAt: string;
}

/**
 * `GET /v1/shipments/dashboard`.
 *
 * ⚠️ Six of the fields here were invented: shipmentsToday, deliveredToday,
 * failedToday, inTransit, pendingPickups, activeDrivers. None exists, so every
 * tile on the dashboard rendered `undefined`. There is no pickup or driver
 * count in this response at all — it is a SHIPMENT dashboard.
 */
export interface DashboardStats {
  readonly totalShipments: number;
  /** One row per status. `inTransit` is a lookup in here, not a field. */
  readonly byStatus: readonly { readonly status: string; readonly count: number }[];
  readonly todayCreated: number;
  readonly todayDelivered: number;
  readonly todayFailed: number;
  readonly deliveryRate: number;
  readonly avgAttemptsPerDelivery: number;
  /** Minor units as decimal STRINGS — bigints that would round as numbers. */
  readonly codCollectedMinor: string;
  readonly codPendingMinor: string;
  readonly currency: string;
  readonly currencyExponent: number;
}

/**
 * The single place the API's page envelope is translated for the UI.
 *
 * Every list below goes through here, so the two shapes are reconciled once
 * rather than in each of a dozen fetchers — and a future endpoint cannot get
 * the translation subtly wrong on its own.
 *
 * The query string is built with `URLSearchParams` rather than by concatenation
 * so a filter value containing `&` cannot smuggle in a second parameter, and so
 * a path that already carries one is impossible to construct here at all.
 */
async function fetchPage<T>(
  path: string,
  cursor?: string | null,
  limit?: number,
  filters: Readonly<Record<string, string>> = {},
): Promise<PaginatedResult<T>> {
  const query = new URLSearchParams(filters);
  if (cursor !== undefined && cursor !== null) {
    query.set("cursor", cursor);
  }
  if (limit !== undefined) {
    query.set("limit", String(limit));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const result = await apiFetch<ApiPage<T>>(`${path}${suffix}`);
  // `hasMore` is the authority. `nextCursor` is the id of the last row on this
  // page and is non-null on the final page too, so paginating on it alone would
  // offer a "Load more" that returns nothing, forever.
  return { data: result.data, cursor: result.page.hasMore ? result.page.nextCursor : null };
}

export async function fetchDashboard(): Promise<DashboardStats> {
  return apiFetch<DashboardStats>("/v1/shipments/dashboard");
}

export async function fetchShipments(cursor?: string | null, limit = 25): Promise<PaginatedResult<ShipmentSummary>> {
  return fetchPage<ShipmentSummary>("/v1/shipments", cursor, limit);
}

export async function fetchShipment(id: string): Promise<ShipmentDetail> {
  return apiFetch<ShipmentDetail>(`/v1/shipments/${encodeURIComponent(id)}`);
}

/**
 * A shipment's custody trail.
 *
 * A SEPARATE call. The detail response never embedded `events`, so a page that
 * assumed it did crashed on `.map` of undefined.
 */
export async function fetchShipmentEvents(id: string): Promise<readonly ShipmentEvent[]> {
  const result = await apiFetch<{ data: readonly ShipmentEvent[] }>(
    `/v1/shipments/${encodeURIComponent(id)}/events`,
  );
  return result.data;
}

export async function fetchDrivers(cursor?: string | null, limit = 50): Promise<PaginatedResult<DriverSummary>> {
  return fetchPage<DriverSummary>("/v1/drivers", cursor, limit);
}

export async function fetchVehicles(cursor?: string | null, limit = 50): Promise<PaginatedResult<VehicleSummary>> {
  return fetchPage<VehicleSummary>("/v1/vehicles", cursor, limit);
}

export async function fetchMerchants(cursor?: string | null, limit = 25): Promise<PaginatedResult<MerchantSummary>> {
  return fetchPage<MerchantSummary>("/v1/merchants", cursor, limit);
}

export async function fetchMerchant(id: string): Promise<MerchantDetail> {
  return apiFetch<MerchantDetail>(`/v1/merchants/${encodeURIComponent(id)}`);
}

/**
 * One merchant's performance — the numbers a commercial is asked for when they
 * call on the *expéditeur*.
 *
 * Needs no portfolio filter of its own: RLS already narrows a commercial's
 * session to the merchants they manage, so this returns zeros for anything
 * outside it rather than another commercial's figures (invariant I25).
 */
export async function fetchMerchantStats(id: string): Promise<MerchantStats> {
  return apiFetch<MerchantStats>(`/v1/shipments/merchant/${encodeURIComponent(id)}/stats`);
}

export async function fetchHubs(): Promise<PaginatedResult<HubSummary>> {
  return fetchPage<HubSummary>("/v1/hubs", null, 100);
}

export async function fetchRoutes(cursor?: string | null, limit = 25): Promise<PaginatedResult<RouteSummary>> {
  return fetchPage<RouteSummary>("/v1/routes", cursor, limit);
}

export async function fetchManifests(cursor?: string | null, limit = 25): Promise<PaginatedResult<ManifestSummary>> {
  return fetchPage<ManifestSummary>("/v1/manifests", cursor, limit);
}

export async function fetchUsers(cursor?: string | null, limit = 25): Promise<PaginatedResult<UserSummary>> {
  return fetchPage<UserSummary>("/v1/users", cursor, limit);
}

/** The tenant's commercials, for the account-manager picker. */
export async function fetchCommercials(): Promise<PaginatedResult<UserSummary>> {
  return fetchPage<UserSummary>("/v1/users", null, 100, { role: "COMMERCIAL" });
}

export async function fetchComplaints(cursor?: string | null, limit = 25): Promise<PaginatedResult<ComplaintSummary>> {
  return fetchPage<ComplaintSummary>("/v1/complaints", cursor, limit);
}

export async function fetchAudit(cursor?: string | null, limit = 25): Promise<PaginatedResult<AuditEntry>> {
  return fetchPage<AuditEntry>("/v1/audit", cursor, limit);
}

export async function fetchPickups(cursor?: string | null, limit = 25): Promise<PaginatedResult<PickupSummary>> {
  return fetchPage<PickupSummary>("/v1/pickups", cursor, limit);
}

/**
 * A notification template — one row per key × locale × channel.
 *
 * `isDefault` distinguishes the built-in copy from a tenant override, which is
 * what makes "revert" meaningful. `estimatedSegments` is surfaced because an
 * Arabic body is UCS-2 at 70 characters per segment: a template that reads
 * naturally can silently cost three segments on every delivery.
 */
export interface NotificationTemplate {
  readonly key: string;
  readonly locale: string;
  readonly channel: string;
  readonly body: string;
  readonly active: boolean;
  readonly isDefault: boolean;
  readonly estimatedSegments: number;
}

export async function fetchTemplates(): Promise<readonly NotificationTemplate[]> {
  const result = await apiFetch<{ data: readonly NotificationTemplate[] }>(
    "/v1/notification-templates",
  );
  return result.data;
}

/** A delivery zone. `boundary` is GeoJSON and is not rendered — there is no map yet. */
export interface ZoneSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly defaultGeofenceRadiusM: number;
  readonly active: boolean;
  readonly centroidLat: number;
  readonly centroidLng: number;
  readonly createdAt: string;
}

export async function fetchZones(cursor?: string | null): Promise<PaginatedResult<ZoneSummary>> {
  return fetchPage<ZoneSummary>("/v1/zones", cursor, 100);
}

/**
 * A shipper asking to be taken on — nouveaux clients.
 *
 * Not a merchant. Approving one CREATES a merchant and sets `merchantId`; until
 * then this is a stranger who filled in a form, which is why nothing in the
 * merchant surface ever sees these rows.
 */
export interface MerchantApplicationSummary {
  readonly id: string;
  readonly businessName: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly contactEmail: string | null;
  readonly city: string | null;
  readonly addressLine: string | null;
  readonly expectedVolume: number | null;
  readonly message: string | null;
  /** PUBLIC_FORM | STAFF. */
  readonly source: string;
  /** PENDING | APPROVED | REJECTED. */
  readonly status: string;
  readonly merchantId: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly createdAt: string;
}

export async function fetchApplications(
  cursor?: string | null,
  status = "PENDING",
): Promise<PaginatedResult<MerchantApplicationSummary>> {
  return fetchPage<MerchantApplicationSummary>("/v1/merchant-applications", cursor, 50, { status });
}

/**
 * An internal staff remark on a parcel, a merchant or a driver.
 *
 * `body` is immutable once written (migration 0035), so there is no edit form
 * anywhere in this app — only pin, resolve, and write a new one.
 */
export interface NoteSummary {
  readonly id: string;
  /** SHIPMENT | MERCHANT | DRIVER. */
  readonly subjectType: string;
  readonly subjectId: string;
  readonly body: string;
  readonly authorUserId: string;
  readonly authorName: string | null;
  readonly pinned: boolean;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

export async function fetchNotes(
  cursor?: string | null,
  filters: Readonly<Record<string, string>> = {},
): Promise<PaginatedResult<NoteSummary>> {
  return fetchPage<NoteSummary>("/v1/notes", cursor, 50, filters);
}

/**
 * A subject's own remarks.
 *
 * Both halves of the filter or neither — the API refuses one alone rather than
 * quietly listing every subject's notes, which on a detail page would mean
 * showing another parcel's remarks.
 */
export async function fetchNotesFor(
  subjectType: "SHIPMENT" | "MERCHANT" | "DRIVER",
  subjectId: string,
  resolved = false,
): Promise<readonly NoteSummary[]> {
  const page = await fetchNotes(null, {
    subjectType,
    subjectId,
    resolved: String(resolved),
  });
  return page.data;
}

/**
 * A served city and what it costs to deliver to.
 *
 * Fees are decimal STRINGS of minor units for the same reason invoice amounts
 * are: they are bigints on the wire, and `formatMoney` takes a bigint. A tariff
 * parsed as a JavaScript number is the exact bug this whole convention exists
 * to prevent.
 */
export interface CitySummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameAr: string | null;
  readonly governorate: string;
  readonly postalCode: string | null;
  readonly zoneId: string | null;
  readonly currency: string;
  readonly currencyExponent: number;
  readonly deliveryFeeMinor: string;
  readonly returnFeeMinor: string;
  readonly deliveryDelayDays: number;
  readonly aliases: readonly string[];
  readonly active: boolean;
}

export async function fetchCities(
  cursor?: string | null,
  filters: Readonly<Record<string, string>> = {},
): Promise<PaginatedResult<CitySummary>> {
  return fetchPage<CitySummary>("/v1/cities", cursor, 200, filters);
}

/**
 * Free-text destinations → the tariff that applies, for a whole CSV at once.
 *
 * One request for every row in the file. The alternative — a request per row —
 * turns a 500-line import into 500 round trips before a single shipment is
 * created.
 */
export async function resolveCities(
  names: readonly string[],
): Promise<{ readonly unmatched: readonly string[] }> {
  if (names.length === 0) {
    return { unmatched: [] };
  }
  const result = await apiFetch<{ readonly unmatched: readonly string[] }>("/v1/cities/resolve", {
    method: "POST",
    body: { names: [...names] },
  });
  return { unmatched: result.unmatched };
}

/**
 * An invoice or credit note, as `GET /v1/invoices` returns it.
 *
 * ⚠️ Every amount is a decimal STRING of minor units, not a number. An invoice
 * total in millimes exceeds `Number.MAX_SAFE_INTEGER` long before the amount
 * becomes implausible, and `formatMoney` takes `bigint` for exactly this reason.
 *
 * `currencyExponent` comes from the API, never from a constant here: TND has
 * THREE decimals and a hardcoded ÷100 misprices every Tunisian invoice tenfold.
 */
export interface InvoiceSummary {
  readonly id: string;
  /** INVOICE | CREDIT_NOTE. */
  readonly kind: string;
  /** NULL while a draft — an abandoned draft consumes no number. */
  readonly number: string | null;
  /** DRAFT | ISSUED | PAID | CANCELLED. */
  readonly status: string;
  readonly merchantId: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly issuedAt: string | null;
  readonly dueAt: string | null;
  readonly currency: string;
  readonly currencyExponent: number;
  readonly subtotalMinor: string;
  /** Basis points: 1900 = 19.00%. */
  readonly vatRateBp: number;
  readonly vatAmountMinor: string;
  readonly stampDutyMinor: string;
  readonly totalMinor: string;
  readonly sellerName: string | null;
  readonly sellerTaxId: string | null;
  readonly buyerName: string | null;
  readonly correctsInvoiceId: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly lines: readonly InvoiceLineRow[];
}

/** One invoice line. Reachable through {@link InvoiceSummary}. */
interface InvoiceLineRow {
  readonly id: string;
  readonly position: number;
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: string;
  readonly lineTotalMinor: string;
}

/** The tenant's billing configuration. Amounts in minor units, as strings. */
export interface BillingSettings {
  readonly vatRateBp: number;
  readonly stampDutyMinor: string;
  readonly paymentTermsDays: number;
  readonly legalName: string | null;
  readonly taxIdentifier: string | null;
  readonly legalAddress: string | null;
}

export async function fetchInvoices(
  cursor?: string | null,
  filters: Readonly<Record<string, string>> = {},
): Promise<PaginatedResult<InvoiceSummary>> {
  return fetchPage<InvoiceSummary>("/v1/invoices", cursor, 25, filters);
}

export async function fetchInvoice(id: string): Promise<InvoiceSummary> {
  return apiFetch<InvoiceSummary>(`/v1/invoices/${encodeURIComponent(id)}`);
}

export async function fetchBillingSettings(): Promise<BillingSettings> {
  return apiFetch<BillingSettings>("/v1/invoices/settings");
}
