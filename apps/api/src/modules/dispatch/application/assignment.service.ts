import { Injectable } from "@nestjs/common";

import { AddressService } from "../../directory/index.js";
import { DriverService } from "../../fleet/index.js";
import { HubService } from "../../network/index.js";
import { ShipmentService } from "../../shipment/index.js";
import type { PlanningLeg } from "../../shipment/index.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { suggestDriversSchema } from "../domain/dtos.js";
import { haversineMetres } from "../domain/geo.js";
import type { LatLng } from "../domain/geo.js";

/** A candidate driver for a leg, ranked for the dispatcher (higher score first). */
export interface ScoredDriver {
  readonly driverId: string;
  readonly fullName: string;
  readonly skills: string[];
  readonly homeHubId: string | null;
  /** Metres from the driver's home hub to the leg target, or null if no home hub. */
  readonly distanceM: number | null;
  /** 0..1, monotonically decreasing in distance; homeless drivers get a neutral 0.5. */
  readonly score: number;
}

/**
 * Assignment scoring (docs/04-context-map.md §3.7).
 *
 * Suggests drivers for a leg from the fleet's assignable pool (ACTIVE + on an open
 * shift + holding the leg's required skills), ranked by home-hub proximity to the
 * delivery target. Deterministic and rule-based — no ML (a documented, always-
 * available substitute per the platform's no-AI decision). The dispatcher decides;
 * this only orders the options.
 */
@Injectable()
export class AssignmentService {
  constructor(
    private readonly shipments: ShipmentService,
    private readonly drivers: DriverService,
    private readonly hubs: HubService,
    private readonly addresses: AddressService,
  ) {}

  async suggestDrivers(input: unknown): Promise<ScoredDriver[]> {
    const dto = parseWithZod(suggestDriversSchema, input);
    const legs = await this.shipments.getLegsForPlanning([dto.legId]);
    const leg = legs[0];
    if (leg === undefined) {
      throw new NotFoundError("ShipmentLeg");
    }

    const target = await this.legTarget(leg);
    const pool = await this.drivers.listAvailable({
      skills: leg.requiredSkills,
      ...(dto.at === undefined ? {} : { at: dto.at }),
    });

    const scored: ScoredDriver[] = [];
    for (const driver of pool) {
      const distanceM = await this.homeHubDistance(driver.homeHubId, target);
      scored.push({
        driverId: driver.id,
        fullName: driver.fullName,
        skills: driver.skills,
        homeHubId: driver.homeHubId,
        distanceM,
        score: distanceM === null ? 0.5 : 1 / (1 + distanceM / 1000),
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const limit = dto.limit ?? scored.length;
    return scored.slice(0, limit);
  }

  private async legTarget(leg: PlanningLeg): Promise<LatLng | null> {
    if (leg.toAddressId !== null) {
      const a = await this.addresses.getById(leg.toAddressId);
      if (a.latitude === null || a.longitude === null) {
        return null;
      }
      return { lat: a.latitude, lng: a.longitude };
    }
    if (leg.toHubId !== null) {
      const h = await this.hubs.getById(leg.toHubId);
      return { lat: h.latitude, lng: h.longitude };
    }
    return null;
  }

  private async homeHubDistance(
    homeHubId: string | null,
    target: LatLng | null,
  ): Promise<number | null> {
    if (homeHubId === null || target === null) {
      return null;
    }
    const hub = await this.hubs.getById(homeHubId);
    return Math.round(haversineMetres({ lat: hub.latitude, lng: hub.longitude }, target));
  }
}
