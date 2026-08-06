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
  readonly merchantName: string;
  readonly currency: string;
  readonly codAmountMinor: number;
  readonly codStatus: string;
  readonly createdAt: string;
}

export interface ShipmentDetail extends ShipmentSummary {
  readonly parcelCount: number;
  readonly weightGrams: number;
  readonly senderName: string;
  readonly senderPhone: string;
  readonly origin: Address;
  readonly destination: Address;
  readonly events: readonly ShipmentEvent[];
  readonly notes: string | null;
}

interface Address {
  readonly rawInput: string;
  readonly city: string | null;
  readonly countryCode: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

interface ShipmentEvent {
  readonly id: string;
  readonly status: string;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly actor: string | null;
}

export interface DriverSummary {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly status: string;
  readonly vehicleId: string | null;
  readonly currentShiftId: string | null;
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
  readonly name: string;
  readonly type: string;
  readonly address: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface RouteSummary {
  readonly id: string;
  readonly status: string;
  readonly driverId: string | null;
  readonly driverName: string | null;
  readonly stopCount: number;
  readonly distanceMeters: number;
  readonly createdAt: string;
}

export interface ManifestSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly originHubId: string;
  readonly destinationHubId: string | null;
  readonly shipmentCount: number;
  readonly createdAt: string;
}

export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly status: string;
  readonly createdAt: string;
}

export interface ComplaintSummary {
  readonly id: string;
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly type: string;
  readonly status: string;
  readonly priority: string;
  readonly createdAt: string;
}

export interface AuditEntry {
  readonly id: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly detail: Record<string, unknown>;
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

export interface DashboardStats {
  readonly shipmentsToday: number;
  readonly deliveredToday: number;
  readonly failedToday: number;
  readonly inTransit: number;
  readonly pendingPickups: number;
  readonly activeDrivers: number;
  readonly deliveryRate: number;
  readonly codPendingMinor: number;
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
