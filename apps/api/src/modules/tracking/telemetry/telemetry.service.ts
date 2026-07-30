import { Inject, Injectable } from "@nestjs/common";
import { Redis } from "ioredis";

import { AppConfigService } from "../../../shared/config/index.js";
import { TenantContext } from "../../../shared/database/index.js";
import { BusinessRuleError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/zod-parse.js";
import { VALKEY_CLIENT } from "../../../shared/valkey/index.js";
import { ShiftService } from "../../fleet/index.js";
import { ingestTelemetrySchema, sourceCode } from "../domain/dtos.js";
import type { PositionInput } from "../domain/dtos.js";
import { RealtimeGateway } from "../realtime/realtime.gateway.js";
import { GeofenceMonitor } from "./geofence-monitor.js";
import { PresenceService } from "./presence.service.js";
import { TelemetryWriter } from "./telemetry-writer.js";
import type { BufferedPosition } from "./telemetry-writer.js";

/** Why a position was not stored. Returned in aggregate, never per-position. */
export type RejectionReason = "OUTSIDE_SHIFT" | "POOR_ACCURACY" | "FUTURE_TIMESTAMP" | "SHED";

export interface IngestResult {
  readonly accepted: number;
  readonly rejected: number;
  readonly serverTime: Date;
  /** Counts by reason — enough for the app to self-diagnose without per-row noise. */
  readonly rejections: Readonly<Partial<Record<RejectionReason, number>>>;
  /** Geofences entered on this batch. Usually empty; that is the point. */
  readonly geofenceEntries: number;
}

/** How long a batch id is remembered for replay detection. */
const BATCH_DEDUP_TTL_S = 6 * 60 * 60;

/**
 * How far into the future a device clock may be before its fix is rejected.
 *
 * Phone clocks drift and occasionally leap. A position stamped next Tuesday
 * would land in a future hypertable chunk and quietly poison playback, so a
 * small tolerance is allowed and anything beyond it is refused.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * GPS batch ingest — the highest-volume endpoint in the system.
 *
 * `POST /v1/telemetry` (docs/05-api-contracts.md §5). Deliberately
 * transport-agnostic and versioned: ADR-005 makes this the first thing extracted
 * to Go, and later moved to MQTT, behind an unchanged contract. Nothing in this
 * class knows it is being called over HTTP.
 *
 * The request path is: validate → privacy gate → quality gates → buffer →
 * presence → geofences. It returns `202` once the positions are buffered; it
 * does not wait for the database write, because a driver's phone should not hold
 * a connection open for a durability guarantee nobody needs on a GPS sample.
 *
 * **This endpoint emits no business event.** Only geofence transitions cross
 * into the business plane (docs/03-event-storming.md §2.4).
 */
@Injectable()
export class TelemetryService {
  private readonly maxAccuracyM: number;

  constructor(
    private readonly writer: TelemetryWriter,
    private readonly presence: PresenceService,
    private readonly geofences: GeofenceMonitor,
    private readonly shifts: ShiftService,
    private readonly realtime: RealtimeGateway,
    @Inject(VALKEY_CLIENT) private readonly valkey: Redis,
    config: AppConfigService,
  ) {
    this.maxAccuracyM = config.get("TELEMETRY_MAX_ACCURACY_M");
  }

  async ingestBatch(input: unknown, ctx: { readonly userId: string }): Promise<IngestResult> {
    const dto = parseWithZod(ingestTelemetrySchema, input);
    const tenantId = TenantContext.requireTenantId();
    const serverTime = new Date();

    // Idempotent replay. The driver app is offline-first and WILL re-send a
    // batch whose response it never saw; without this that becomes duplicate
    // rows in a table nobody can UPDATE or DELETE.
    const replayed = await this.recallBatch(tenantId, dto.batchId);
    if (replayed !== null) {
      return { ...replayed, serverTime };
    }

    // ── Privacy gate ─────────────────────────────────────────────────────────
    // docs/05 §5: "The server rejects telemetry outside an open shift regardless
    // of what the app sends." Location tracking outside a shift is surveillance,
    // not operations, so this is checked here rather than trusted from the
    // client — a compromised or modified app must not be able to opt in.
    //
    // ⚠️ Takes the authenticated USER id and resolves the driver from it. A user
    // id and a driver id are different things: the caller only ever knows who is
    // authenticated, and `driver_positions.driver_id` must hold a `drivers.id`.
    // Accepting a driver id from the caller would also mean trusting it.
    const shift = await this.shifts.openShiftForUser(ctx.userId, serverTime);
    if (shift === null) {
      throw new BusinessRuleError(
        "TELEMETRY_OUTSIDE_SHIFT",
        "Telemetry is only accepted while the driver has an open shift",
      );
    }
    const driverId = shift.driverId;

    // ── Quality gates ────────────────────────────────────────────────────────
    const rejections: Partial<Record<RejectionReason, number>> = {};
    const accepted: PositionInput[] = [];
    const skewLimit = serverTime.getTime() + MAX_CLOCK_SKEW_MS;

    for (const position of dto.positions) {
      if (position.acc !== undefined && position.acc > this.maxAccuracyM) {
        // A 500-metre fix would drag the map marker across town and could fire a
        // geofence three streets away. Noise, not data.
        rejections.POOR_ACCURACY = (rejections.POOR_ACCURACY ?? 0) + 1;
        continue;
      }
      if (position.t.getTime() > skewLimit) {
        rejections.FUTURE_TIMESTAMP = (rejections.FUTURE_TIMESTAMP ?? 0) + 1;
        continue;
      }
      accepted.push(position);
    }

    // ── Buffer ───────────────────────────────────────────────────────────────
    const { shed } = this.writer.enqueue(
      accepted.map((p) => toBuffered(tenantId, driverId, dto.routeId ?? null, p)),
    );
    if (shed > 0) {
      rejections.SHED = shed;
    }

    // ── Presence + geofences ─────────────────────────────────────────────────
    let geofenceEntries = 0;
    if (accepted.length > 0) {
      // Only the newest fix matters for presence — the map renders one marker,
      // not a trail, and writing every point would be N round trips for a value
      // immediately overwritten.
      const newest = accepted.reduce((a, b) => (b.t.getTime() > a.t.getTime() ? b : a));
      await this.presence.record(tenantId, {
        driverId: driverId,
        lat: newest.lat,
        lon: newest.lon,
        headingDeg: newest.hdg ?? null,
        speedMps: newest.spd ?? null,
        batteryPct: newest.bat ?? null,
        at: newest.t,
      });

      // Fan out to any dispatcher watching. Fire-and-forget across Valkey
      // pub/sub so the socket a dispatcher happens to hold on another instance
      // still receives it — and so a realtime hiccup never fails an upload.
      this.realtime.publishPosition(tenantId, {
        driverId: driverId,
        lat: newest.lat,
        lon: newest.lon,
        headingDeg: newest.hdg ?? null,
        speedMps: newest.spd ?? null,
        batteryPct: newest.bat ?? null,
        routeId: dto.routeId ?? null,
      });

      const entries = await this.geofences.evaluateTrack(
        tenantId,
        driverId,
        accepted.map((p) => ({ at: p.t, lat: p.lat, lon: p.lon })),
        { routeId: dto.routeId ?? null, actorId: driverId },
      );
      geofenceEntries = entries.length;
    }

    const rejected = dto.positions.length - accepted.length + shed;
    const result: Omit<IngestResult, "serverTime"> = {
      accepted: accepted.length - shed,
      rejected,
      rejections,
      geofenceEntries,
    };
    await this.rememberBatch(tenantId, dto.batchId, result);

    return { ...result, serverTime };
  }

  /** Releases a driver's live state when their shift ends. */
  async clearPresence(driverId: string): Promise<void> {
    const tenantId = TenantContext.requireTenantId();
    await this.presence.clear(tenantId, driverId);
    await this.geofences.clear(tenantId, driverId);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Batch replay detection.
   *
   * Valkey rather than a table: this is a short-lived guard against a retry
   * minutes later, not an audit record. A batch re-sent six hours on is not a
   * retry, it is a bug, and it should land as new rows rather than vanish.
   */
  private async recallBatch(
    tenantId: string,
    batchId: string,
  ): Promise<Omit<IngestResult, "serverTime"> | null> {
    const raw = await this.valkey.get(batchKey(tenantId, batchId));
    if (raw === null) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      const accepted = record["accepted"];
      const rejected = record["rejected"];
      if (typeof accepted !== "number" || typeof rejected !== "number") {
        return null;
      }
      return {
        accepted,
        rejected,
        rejections: {},
        geofenceEntries: 0,
      };
    } catch {
      // A malformed dedup entry means we cannot prove this is a replay. Treating
      // it as new risks duplicate rows; treating it as seen risks losing a real
      // batch. Losing data is worse — re-ingest.
      return null;
    }
  }

  private async rememberBatch(
    tenantId: string,
    batchId: string,
    result: Omit<IngestResult, "serverTime">,
  ): Promise<void> {
    await this.valkey.set(
      batchKey(tenantId, batchId),
      JSON.stringify({ accepted: result.accepted, rejected: result.rejected }),
      "EX",
      BATCH_DEDUP_TTL_S,
    );
  }
}

function batchKey(tenantId: string, batchId: string): string {
  return `tenant:${tenantId}:telemetry:batch:${batchId}`;
}

function toBuffered(
  tenantId: string,
  driverId: string,
  routeId: string | null,
  position: PositionInput,
): BufferedPosition {
  return {
    tenantId,
    driverId,
    routeId,
    time: position.t,
    lat: position.lat,
    lon: position.lon,
    speedMps: position.spd ?? null,
    headingDeg: position.hdg ?? null,
    accuracyM: position.acc ?? null,
    batteryPct: position.bat ?? null,
    isMoving: position.mov ?? null,
    source: sourceCode(position.src) ?? null,
  };
}
