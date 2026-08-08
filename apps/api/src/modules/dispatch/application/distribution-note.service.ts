import { Injectable } from "@nestjs/common";

import { AddressService } from "../../directory/index.js";
import { DriverService, VehicleService } from "../../fleet/index.js";
import { TenantService } from "../../platform/index.js";
import { ShipmentService } from "../../shipment/index.js";
import { CurrencyService, formatMinorUnits } from "../../../shared/money/index.js";
import { toDocumentLocale } from "../../../shared/documents/index.js";
import { BusinessRuleError } from "../../../shared/errors/index.js";
import { renderDistributionNote } from "../domain/distribution-note.js";
import type { DistributionStop } from "../domain/distribution-note.js";
import { RouteService } from "./route.service.js";

export interface RenderedDistributionNote {
  readonly html: string;
  readonly filename: string;
}

/**
 * Bon de distribution — the manifest a driver signs for.
 *
 * ⚠️ REFUSES A ROUTE WITH NO DRIVER. The whole document is a handover between
 * two named people; printing one with a blank driver line produces a piece of
 * paper nobody is accountable for, which is worse than no paper at all.
 */
@Injectable()
export class DistributionNoteService {
  constructor(
    private readonly routes: RouteService,
    private readonly shipments: ShipmentService,
    private readonly addresses: AddressService,
    private readonly drivers: DriverService,
    private readonly vehicles: VehicleService,
    private readonly tenants: TenantService,
    private readonly currency: CurrencyService,
  ) {}

  async render(routeId: string, locale?: string): Promise<RenderedDistributionNote> {
    const plan = await this.routes.getPlan(routeId);
    const { route, stops } = plan;

    if (route.driverId === null) {
      throw new BusinessRuleError(
        "ROUTE_HAS_NO_DRIVER",
        "Assign a driver before printing the distribution note — it is a handover between two named people.",
      );
    }

    const profile = await this.tenants.profile();
    const resolvedLocale = toDocumentLocale(locale ?? profile.defaultLocale);

    // Every leg on the route, in one query rather than one per stop.
    const legIds = stops.flatMap((stop) => stop.legIds);
    const [legs, driver, vehicle] = await Promise.all([
      legIds.length === 0 ? Promise.resolve([]) : this.shipments.getLegsForPlanning(legIds),
      this.drivers.getById(route.driverId),
      route.vehicleId === null ? Promise.resolve(null) : this.vehicles.getById(route.vehicleId),
    ]);

    // Address text for every delivery stop, deduplicated — a route with two
    // parcels to one building must not fetch it twice.
    const addressIds = [
      ...new Set(legs.map((leg) => leg.toAddressId).filter((id): id is string => id !== null)),
    ];
    const addresses = new Map(
      (await Promise.all(addressIds.map((id) => this.addresses.getById(id)))).map((address) => [
        address.id,
        address,
      ]),
    );

    // The manifest follows the STOP order, which is the order the driver
    // actually drives — not the order the legs happen to come back in.
    const bySequence = new Map(stops.map((stop) => [stop.id, stop.sequence]));
    const ordered = [...legs].sort(
      (a, b) =>
        (bySequence.get(a.routeStopId ?? "") ?? 0) - (bySequence.get(b.routeStopId ?? "") ?? 0),
    );

    const exponent = await this.exponentFor(ordered);
    let codTotalMinor = 0n;

    const manifest: DistributionStop[] = ordered.map((leg, index) => {
      codTotalMinor += leg.codAmountMinor;
      const address = leg.toAddressId === null ? null : addresses.get(leg.toAddressId);
      return {
        // Renumbered 1..n for the paper. A driver ticks line 7, not stop id
        // 019fe1…, and gaps from removed stops would make the list read wrong.
        sequence: index + 1,
        trackingNumber: leg.trackingNumber,
        recipientName: leg.recipientName,
        recipientPhone: leg.recipientPhone,
        addressLine: address === undefined || address === null ? "—" : addressLineOf(address),
        codAmount:
          leg.codAmountMinor > 0n ? formatMinorUnits(leg.codAmountMinor, exponent) : null,
      };
    });

    // Taken from the parcels, not from tenant config: the note prints what the
    // driver will actually be handed, and a route with no COD prints no total.
    const currency = ordered[0]?.currency ?? "";

    const html = renderDistributionNote({
      locale: resolvedLocale,
      courierName: profile.name,
      routeCode: route.code,
      plannedDate: route.plannedDate,
      driverName: driver.fullName,
      vehiclePlate: vehicle?.plateNumber ?? null,
      issuedAt: new Date(),
      timezone: profile.timezone,
      stops: manifest,
      codTotal: codTotalMinor > 0n ? formatMinorUnits(codTotalMinor, exponent) : null,
      currency,
    });

    return { html, filename: `bon-de-distribution-${route.code}.html` };
  }

  /**
   * The exponent for the route's currency.
   *
   * ⚠️ A route whose parcels carry two currencies cannot be totalled — 45 dinars
   * plus 45 euros is not a number — so it is refused rather than summed. Rare to
   * the point of hypothetical in this market, and silently wrong if allowed.
   */
  private async exponentFor(
    legs: readonly { readonly currency: string }[],
  ): Promise<number> {
    const currencies = new Set(legs.map((leg) => leg.currency));
    if (currencies.size > 1) {
      throw new BusinessRuleError(
        "ROUTE_MIXES_CURRENCIES",
        "This route carries parcels in more than one currency; its cash total cannot be printed.",
      );
    }
    const [currency] = currencies;
    return currency === undefined ? 0 : this.currency.exponentOf(currency);
  }
}

/** The address as one printable line. */
function addressLineOf(address: {
  readonly normalisedLine1: string | null;
  readonly city: string | null;
  readonly rawInput: string;
}): string {
  const parts = [address.normalisedLine1, address.city].filter(
    (part): part is string => part !== null && part.trim().length > 0,
  );
  // The raw input is what a human typed; it is a better address on paper than a
  // half-normalised one with a missing street.
  return parts.length > 0 ? parts.join(", ") : address.rawInput;
}
