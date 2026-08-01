import { apiFetch } from "./api";

/**
 * Typed reads. One place that knows the API's response shapes, so a contract
 * change surfaces here rather than in six components.
 */

export interface BootstrapConfig {
  readonly currency: { readonly code: string; readonly exponent: number; readonly symbol: string };
  readonly timezone: string;
  readonly features: Record<string, boolean>;
}

export interface DashboardStats {
  readonly totalShipments: number;
  readonly byStatus: readonly { readonly status: string; readonly count: number }[];
  readonly todayCreated: number;
  readonly todayDelivered: number;
  readonly todayFailed: number;
  readonly deliveryRate: number;
  readonly codCollectedMinor: string;
  readonly codPendingMinor: string;
  readonly currency: string;
}

export interface ShipmentSummary {
  readonly id: string;
  readonly trackingNumber: string;
  readonly status: string;
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly codAmountMinor: string;
  readonly codStatus: string;
  readonly currency: string;
  readonly weightGrams: number;
  readonly parcelCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ShipmentPage {
  readonly data: readonly ShipmentSummary[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

export interface ShipmentEvent {
  readonly id: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly reasonCode: string | null;
}

export interface AddressBookEntry {
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly addressId: string;
  readonly rawInput: string;
  readonly city: string | null;
  readonly shipmentCount: number;
  readonly lastUsedAt: string;
}

/**
 * The app-shell config — currency exponent above all.
 *
 * ⚠️ Every amount in this portal is formatted from `currency.exponent`. TND has
 * three decimal places, and a hardcoded 2 would misstate what a merchant is owed
 * by a factor of ten.
 */
export async function fetchBootstrap(): Promise<BootstrapConfig> {
  return apiFetch<BootstrapConfig>("/v1/config/bootstrap");
}

export async function fetchDashboard(currency: string): Promise<DashboardStats> {
  // RLS narrows this to the caller's own rows: a MERCHANT token sees only its
  // own parcels, so the "dashboard" is already this merchant's dashboard
  // (invariant I24). No merchant id is passed, and none could be trusted if it were.
  return apiFetch<DashboardStats>(`/v1/shipments/dashboard?currency=${encodeURIComponent(currency)}`);
}

export async function fetchShipments(params: {
  readonly status?: string;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<ShipmentPage> {
  const query = new URLSearchParams();
  if (params.status !== undefined && params.status !== "") query.set("status", params.status);
  if (params.cursor !== undefined && params.cursor !== "") query.set("cursor", params.cursor);
  query.set("limit", String(params.limit ?? 20));
  return apiFetch<ShipmentPage>(`/v1/shipments?${query.toString()}`);
}

export async function fetchShipment(id: string): Promise<ShipmentSummary> {
  return apiFetch<ShipmentSummary>(`/v1/shipments/${encodeURIComponent(id)}`);
}

export async function fetchShipmentEvents(id: string): Promise<readonly ShipmentEvent[]> {
  return apiFetch<readonly ShipmentEvent[]>(`/v1/shipments/${encodeURIComponent(id)}/events`);
}

/**
 * The merchant's own recipients.
 *
 * ⚠️ Projected from their OWN shipments, not from the tenant's `recipients`
 * table — that one is shared across every merchant on the platform, so exposing
 * it would hand a merchant their competitors' customer list (RM-R1, migration
 * 0021).
 */
export async function fetchAddressBook(): Promise<readonly AddressBookEntry[]> {
  const page = await apiFetch<{ data: readonly AddressBookEntry[] }>("/v1/address-book?limit=100");
  return page.data;
}
