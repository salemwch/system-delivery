import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";

import { AddressCorrectionService } from "../../directory/index.js";
import type { Permission } from "../../identity/index.js";
import { DEFAULT_FEATURES, FEATURE_KEYS, FeatureService } from "../../platform/index.js";
import type { FeatureKey } from "../../platform/index.js";
import { ShipmentService } from "../../shipment/index.js";
import type { CommandContext } from "../../shipment/index.js";
import { NO_DRIVER, TenantContext } from "../../../shared/database/index.js";
import { DomainError, ForbiddenError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod, requestFingerprint } from "../../../shared/http/index.js";
import { CurrencyService } from "../../../shared/money/index.js";
import { toManifestResponse } from "./manifest-response.js";
import type { ManifestResponse } from "./manifest-response.js";
import { driverSyncSchema, syncItemSchema } from "../domain/sync-dtos.js";
import type { SyncItem, SyncItemType } from "../domain/sync-dtos.js";
import type { Route } from "../domain/schema.js";
import { RouteService } from "./route.service.js";

/** What the app must do with an item the server did not accept (docs/08 §8.1). */
export type SyncAction = "DISCARD_AND_REFRESH" | "RETRY_LATER" | "ESCALATE_TO_DISPATCHER";

export type SyncItemResult =
  | {
      readonly idempotencyKey: string | null;
      readonly type: SyncItemType | null;
      readonly status: "ACCEPTED";
      /** True when the server had already applied it (an earlier sync's retry). */
      readonly replayed: boolean;
      /** The state the item left behind: a shipment status or a correction status. */
      readonly resultingStatus: string;
    }
  | {
      readonly idempotencyKey: string | null;
      readonly type: SyncItemType | null;
      readonly status: "REJECTED";
      readonly code: string;
      readonly detail: string;
      readonly action: SyncAction;
    };

export interface SyncResult {
  readonly results: readonly SyncItemResult[];
  /** Every route the driver holds today; anything else on the device is stale. */
  readonly activeRoutes: readonly { routeId: string; status: string; version: string }[];
  /** Full manifests, only for routes whose version the device did not have. */
  readonly routeUpdates: readonly {
    routeId: string;
    version: string;
    manifest: ManifestResponse;
  }[];
  readonly features: Readonly<Record<FeatureKey, boolean>>;
  readonly serverTime: Date;
}

export interface SyncCaller {
  readonly userId: string;
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<Permission>;
}

const ITEM_PERMISSION: Readonly<Record<SyncItemType, Permission>> = {
  DELIVERED: "shipment:deliver",
  FAILED: "shipment:fail",
  RETURN_COMPLETED: "shipment:deliver",
  ADDRESS_CORRECTED: "address:correct",
};

/**
 * Items that record something that PHYSICALLY happened and cannot be redone:
 * a parcel handed over (with its cash), a parcel handed back. When the server
 * refuses one, it is never silently discarded; a person has to reconcile what
 * the system says with what the driver did.
 */
const PHYSICAL: ReadonlySet<SyncItemType> = new Set(["DELIVERED", "RETURN_COMPLETED"]);

const ACTIVE_ROUTE_STATUSES = ["PUBLISHED", "IN_PROGRESS"] as const;

/**
 * The driver app's offline sync (docs/05 §5, docs/08 §8.1): drain the device's
 * queue, then tell it what changed.
 *
 * Each item runs as the command it replays, through the same service, the same
 * state machine, RLS scope and idempotency binding (I29) as the online route:
 * sync is a transport, never a second set of rules. Items run in the device's
 * order, each in its own transaction, and each gets its own result.
 *
 * ⚠️ ORDER PER PARCEL IS PRESERVED. Once an item for a parcel (or an address)
 * is held back, RETRY_LATER or ESCALATE, every later item for the same parcel
 * in the batch is held too, unexecuted. Otherwise a transient failure on
 * "failed attempt" followed by a successful "delivered" would retry the
 * failure afterwards, against a parcel already delivered.
 */
@Injectable()
export class DriverSyncService {
  constructor(
    private readonly shipments: ShipmentService,
    private readonly corrections: AddressCorrectionService,
    private readonly routes: RouteService,
    private readonly features: FeatureService,
    private readonly currencies: CurrencyService,
    private readonly logger: PinoLogger,
  ) {}

  async sync(input: unknown, caller: SyncCaller): Promise<SyncResult> {
    const dto = parseWithZod(driverSyncSchema, input);
    const state = TenantContext.current();
    // The driver's own device only: a staff account has no queue to drain, and
    // a DRIVER login without a driver record holds no parcel to act on.
    if (
      !caller.roles.includes("DRIVER") ||
      state?.driverId === undefined ||
      state.driverId === NO_DRIVER
    ) {
      throw new ForbiddenError("Sync is for a driver's own device");
    }
    const ctx: CommandContext = { actor: { actorType: "DRIVER", actorId: caller.userId } };

    const held = new Set<string>();
    const results: SyncItemResult[] = [];
    for (const raw of dto.pendingEvents) {
      results.push(await this.apply(raw, caller, ctx, held));
    }

    const accepted = results.filter((r) => r.status === "ACCEPTED").length;
    this.logger.info(
      {
        deviceId: dto.deviceId,
        items: results.length,
        accepted,
        rejected: results.length - accepted,
      },
      "driver sync drained",
    );

    const { activeRoutes, routeUpdates } = await this.routeState(dto.knownRouteVersions ?? {});
    const enabled = new Set(await this.features.enabledKeys(TenantContext.requireTenantId()));
    // Every key, so the app replaces its flags rather than merging stale ones.
    const features: Record<FeatureKey, boolean> = { ...DEFAULT_FEATURES };
    for (const key of FEATURE_KEYS) {
      features[key] = enabled.has(key);
    }

    return {
      results,
      activeRoutes,
      routeUpdates,
      features,
      serverTime: new Date(),
    };
  }

  private async apply(
    raw: unknown,
    caller: SyncCaller,
    ctx: CommandContext,
    held: Set<string>,
  ): Promise<SyncItemResult> {
    const parsed = syncItemSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ...identify(raw),
        status: "REJECTED",
        code: "VALIDATION_FAILED",
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "item"}: ${issue.message}`)
          .join("; "),
        // The device queued something the server cannot read: a client bug. It
        // may be a delivery, so it is shown to a person, never dropped.
        action: "ESCALATE_TO_DISPATCHER",
      };
    }
    const item = parsed.data;
    const aggregate = aggregateOf(item);
    const base = { idempotencyKey: item.idempotencyKey, type: item.type };

    if (held.has(aggregate)) {
      return {
        ...base,
        status: "REJECTED",
        code: "HELD_BEHIND_EARLIER_ITEM",
        detail:
          "An earlier item for the same parcel or address was not applied; this one waits for it.",
        action: "RETRY_LATER",
      };
    }
    if (!caller.permissions.has(ITEM_PERMISSION[item.type])) {
      held.add(aggregate);
      return {
        ...base,
        status: "REJECTED",
        code: "FORBIDDEN",
        detail: `This login may not record ${item.type}.`,
        action: "ESCALATE_TO_DISPATCHER",
      };
    }

    try {
      return { ...base, status: "ACCEPTED", ...(await this.execute(item, ctx)) };
    } catch (error) {
      const result = this.reject(item, error);
      if (result.action !== "DISCARD_AND_REFRESH") {
        held.add(aggregate);
      }
      return { ...base, ...result };
    }
  }

  private async execute(
    item: SyncItem,
    ctx: CommandContext,
  ): Promise<{ replayed: boolean; resultingStatus: string }> {
    const command = { ...item.payload, idempotencyKey: item.idempotencyKey };
    if (item.type === "ADDRESS_CORRECTED") {
      const outcome = await this.corrections.submit(target(item.addressId), command);
      return { replayed: outcome.replayed, resultingStatus: outcome.correction.status };
    }
    const id = target(item.shipmentId);
    const shipment =
      item.type === "DELIVERED"
        ? await this.shipments.confirmDelivery(id, command, ctx)
        : item.type === "FAILED"
          ? await this.shipments.recordFailedAttempt(id, command, ctx)
          : await this.shipments.completeReturn(id, command, ctx);
    // A parcel outcome may finish its stop (RouteService.settleStopsForShipment);
    // idempotent, so a replayed item settles nothing twice.
    await this.routes.settleStopsForShipment(shipment.id);
    return { replayed: this.shipments.isReplay(shipment), resultingStatus: shipment.status };
  }

  /**
   * Starts the driver's OWN published route: the parcels on it go out for
   * delivery (RouteService.start), which is what lets the driver deliver them.
   * docs/03: route.started is produced by the Driver App. A colleague's route
   * is invisible under the driver's RLS (0047) and is a 404; the driver of
   * the route is checked again here.
   */
  async startRoute(routeId: string, caller: SyncCaller): Promise<Route> {
    const route = await this.ownRoute(routeId, caller);
    return this.routes.start(route.id, { actor: { actorType: "DRIVER", actorId: caller.userId } });
  }

  /** Completes the driver's own route once every stop is settled. */
  async completeRoute(routeId: string, caller: SyncCaller): Promise<Route> {
    const route = await this.ownRoute(routeId, caller);
    return this.routes.complete(route.id);
  }

  private async ownRoute(routeId: string, caller: SyncCaller): Promise<Route> {
    const driverId = TenantContext.current()?.driverId;
    if (!caller.roles.includes("DRIVER") || driverId === undefined || driverId === NO_DRIVER) {
      throw new ForbiddenError("Only the driver of a route may run it");
    }
    const route = await this.routes.getById(routeId);
    if (route.driverId !== driverId) {
      throw new NotFoundError("Route");
    }
    return route;
  }

  /** What the device should do with an item the server refused. */
  private reject(
    item: SyncItem,
    error: unknown,
  ): { status: "REJECTED"; code: string; detail: string; action: SyncAction } {
    if (!(error instanceof DomainError)) {
      // A fault on our side, not a verdict on the item: keep it and resend.
      this.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)), type: item.type },
        "driver sync item failed unexpectedly",
      );
      return {
        status: "REJECTED",
        code: "INTERNAL_ERROR",
        detail: "The server could not process this item; it will be retried.",
        action: "RETRY_LATER",
      };
    }
    const verdict = { status: "REJECTED" as const, code: error.code, detail: error.message };
    if (error.status >= 500 || error.status === 429) {
      return { ...verdict, action: "RETRY_LATER" };
    }
    // Something that physically happened and the server refuses to record:
    // a person reconciles it, whatever the reason (the parcel was cancelled
    // while it was being handed over, the POD is incomplete, the COD does not
    // match). Discarding it would lose a delivery, and maybe cash.
    if (PHYSICAL.has(item.type)) {
      return { ...verdict, action: "ESCALATE_TO_DISPATCHER" };
    }
    // The server's state moved on (the parcel is no longer this driver's, or
    // the transition no longer applies): nothing was lost, refresh and drop.
    if (error.status === 403 || error.status === 404 || error.status === 409) {
      return { ...verdict, action: "DISCARD_AND_REFRESH" };
    }
    // A malformed or contradictory record (400/422, a reused key): an app bug
    // that a person should see rather than the queue silently losing it.
    return { ...verdict, action: "ESCALATE_TO_DISPATCHER" };
  }

  /**
   * The driver's active routes, each with the fingerprint of the manifest the
   * device would download. Read under the driver's own RLS (0047/0048), so a
   * parcel re-planned to a colleague changes the version too.
   */
  private async routeState(known: Readonly<Record<string, string>>): Promise<{
    activeRoutes: SyncResult["activeRoutes"];
    routeUpdates: SyncResult["routeUpdates"];
  }> {
    const active = (
      await Promise.all(
        ACTIVE_ROUTE_STATUSES.map((status) => this.routes.list({ status, limit: 20 })),
      )
    ).flatMap((page) => page.items);

    const activeRoutes: { routeId: string; status: string; version: string }[] = [];
    const routeUpdates: { routeId: string; version: string; manifest: ManifestResponse }[] = [];
    for (const route of active) {
      const manifest = await toManifestResponse(
        await this.routes.getManifest(route.id),
        this.currencies,
      );
      const version = requestFingerprint({ manifest });
      activeRoutes.push({ routeId: route.id, status: route.status, version });
      if (known[route.id] !== version) {
        routeUpdates.push({ routeId: route.id, version, manifest });
      }
    }
    return { activeRoutes, routeUpdates };
  }
}

/** The id the item schema guarantees for its type (superRefine); narrowed, not assumed. */
function target(id: string | undefined): string {
  if (id === undefined) {
    throw new Error("Sync item reached execution without its target id");
  }
  return id;
}

function aggregateOf(item: SyncItem): string {
  return item.type === "ADDRESS_CORRECTED"
    ? `address:${item.addressId ?? ""}`
    : `shipment:${item.shipmentId ?? ""}`;
}

/** Best-effort echo of an unparseable item's key and type, so the app can match it. */
function identify(raw: unknown): { idempotencyKey: string | null; type: SyncItemType | null } {
  if (typeof raw !== "object" || raw === null) {
    return { idempotencyKey: null, type: null };
  }
  const record: Record<string, unknown> = { ...raw };
  const key = record["idempotencyKey"];
  const type = record["type"];
  return {
    idempotencyKey: typeof key === "string" ? key.slice(0, 200) : null,
    type:
      type === "DELIVERED" ||
      type === "FAILED" ||
      type === "RETURN_COMPLETED" ||
      type === "ADDRESS_CORRECTED"
        ? type
        : null,
  };
}
