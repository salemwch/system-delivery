import type { CurrencyService } from "../../../shared/money/index.js";
import type { ManifestView } from "./route.service.js";

/** Money on the wire (docs/05 §1.3): minor units as a decimal STRING, with its exponent. */
interface MoneyResponse {
  readonly amountMinor: string;
  readonly currency: string;
  readonly currencyExponent: number;
}

export interface ManifestResponse {
  readonly routeId: string;
  readonly code: string;
  readonly status: string;
  readonly plannedDate: string;
  readonly driverId: string | null;
  readonly vehicleId: string | null;
  readonly summary: {
    readonly stopsTotal: number;
    readonly stopsCompleted: number;
    /** One entry per currency: amounts in different currencies are never summed. */
    readonly codExpected: readonly MoneyResponse[];
  };
  readonly stops: readonly {
    readonly id: string;
    readonly sequence: number;
    readonly type: string;
    readonly status: string;
    readonly latitude: number | null;
    readonly longitude: number | null;
    readonly plannedArrivalAt: string | null;
    readonly address: {
      readonly line1: string | null;
      readonly city: string | null;
      readonly accessNotes: string | null;
    } | null;
    readonly shipments: readonly {
      readonly shipmentId: string;
      readonly trackingNumber: string;
      readonly recipientName: string;
      readonly recipientPhone: string;
      readonly parcelCount: number;
      readonly cod: MoneyResponse;
    }[];
  }[];
}

/**
 * The driver's day as JSON.
 *
 * ⚠️ THE DEFECT THIS CLOSES. `GET /v1/routes/:id/manifest` returned the
 * service's `ManifestView` as it was, and that view carries COD as `bigint`.
 * Fastify serializes a schemaless response with `JSON.stringify`, which throws
 * on a bigint, so the route answered 500 on every call, including for a route
 * with no COD at all (`0n` is still a bigint). Every service test passed
 * because none of them went through HTTP. Money now leaves as a decimal string
 * with its currency and ISO 4217 exponent, like every other money field
 * (docs/05 §1.3), and TND's three decimals are never guessed.
 */
export async function toManifestResponse(
  view: ManifestView,
  currencies: CurrencyService,
): Promise<ManifestResponse> {
  const codes = new Set(view.stops.flatMap((stop) => stop.shipments.map((s) => s.currency)));
  const exponents = new Map<string, number>();
  for (const code of codes) {
    exponents.set(code, await currencies.exponentOf(code));
  }
  const money = (amountMinor: bigint, currency: string): MoneyResponse => {
    const currencyExponent = exponents.get(currency);
    if (currencyExponent === undefined) {
      throw new Error(`No exponent resolved for ${currency}`);
    }
    return { amountMinor: amountMinor.toString(), currency, currencyExponent };
  };

  // Per currency, and per shipment once: a parcel served by two stops (a
  // pickup and a delivery) is one amount to collect, as in the service view.
  const totals = new Map<string, bigint>();
  const counted = new Set<string>();
  for (const stop of view.stops) {
    for (const shipment of stop.shipments) {
      if (counted.has(shipment.shipmentId)) continue;
      counted.add(shipment.shipmentId);
      totals.set(
        shipment.currency,
        (totals.get(shipment.currency) ?? 0n) + shipment.codAmountMinor,
      );
    }
  }

  return {
    routeId: view.routeId,
    code: view.code,
    status: view.status,
    plannedDate: view.plannedDate,
    driverId: view.driverId,
    vehicleId: view.vehicleId,
    summary: {
      stopsTotal: view.summary.stopsTotal,
      stopsCompleted: view.summary.stopsCompleted,
      codExpected: [...totals.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([currency, amount]) => money(amount, currency)),
    },
    stops: view.stops.map((stop) => ({
      id: stop.id,
      sequence: stop.sequence,
      type: stop.type,
      status: stop.status,
      latitude: stop.latitude,
      longitude: stop.longitude,
      plannedArrivalAt: stop.plannedArrivalAt?.toISOString() ?? null,
      address: stop.address,
      shipments: stop.shipments.map((s) => ({
        shipmentId: s.shipmentId,
        trackingNumber: s.trackingNumber,
        recipientName: s.recipientName,
        recipientPhone: s.recipientPhone,
        parcelCount: s.parcelCount,
        cod: money(s.codAmountMinor, s.currency),
      })),
    })),
  };
}
