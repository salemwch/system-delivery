import { Inject, Injectable } from "@nestjs/common";
import { Redis } from "ioredis";

import { AppConfigService } from "../../../shared/config/index.js";
import { VALKEY_CLIENT } from "../../../shared/valkey/index.js";

/** A driver's last-known position, as the dispatcher map needs it. */
export interface LastKnownPosition {
  readonly driverId: string;
  readonly lat: number;
  readonly lon: number;
  readonly headingDeg: number | null;
  readonly speedMps: number | null;
  readonly batteryPct: number | null;
  readonly at: Date;
}

/**
 * Driver presence and last-known position — in Valkey, never the hypertable.
 *
 * docs/06-database-design.md §5.3 is explicit: *"Live dispatcher views read
 * last-known position from Valkey, not from TimescaleDB. The hypertable is for
 * history, playback, and analytics. Confusing these two access patterns is how
 * telemetry stores get overloaded."*
 *
 * The two access patterns really are different problems. "Where is every driver
 * right now" is 200 keys and a millisecond; asking the hypertable the same
 * question means a `DISTINCT ON` over the most recent chunk on every dispatcher
 * poll, for data that is stale by the time it renders.
 *
 * **Expiry is the offline signal.** A position key lives for 90 seconds; a
 * driver whose key has expired is offline by definition. No reaper job, no
 * heartbeat table, no clock skew to reconcile — the absence of data IS the
 * state.
 */
@Injectable()
export class PresenceService {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(VALKEY_CLIENT) private readonly valkey: Redis,
    config: AppConfigService,
  ) {
    this.ttlSeconds = config.get("TELEMETRY_PRESENCE_TTL_S");
  }

  /**
   * Records where a driver is now.
   *
   * Writes the position key and the tenant's online index in ONE pipeline —
   * two round trips per GPS ping, at 10k pings/sec, is 20k round trips we do not
   * need to make.
   */
  async record(tenantId: string, position: LastKnownPosition): Promise<void> {
    const payload = JSON.stringify({
      driverId: position.driverId,
      lat: position.lat,
      lon: position.lon,
      hdg: position.headingDeg,
      spd: position.speedMps,
      bat: position.batteryPct,
      at: position.at.toISOString(),
    });

    await this.valkey
      .pipeline()
      .set(positionKey(tenantId, position.driverId), payload, "EX", this.ttlSeconds)
      // A sorted set scored by last-seen millis. This is what makes
      // `onlineDrivers` a range query instead of a keyspace scan.
      .zadd(onlineKey(tenantId), position.at.getTime(), position.driverId)
      .exec();
  }

  async lastKnown(tenantId: string, driverId: string): Promise<LastKnownPosition | null> {
    const raw = await this.valkey.get(positionKey(tenantId, driverId));
    return raw === null ? null : parsePosition(raw);
  }

  /**
   * Every driver seen within the TTL window.
   *
   * A range query on the sorted set, NOT `KEYS tenant:*:driver:*:pos`. `KEYS` is
   * O(N) over the entire keyspace and blocks the server while it runs — it is
   * the single most reliable way to take a production Redis down.
   *
   * Stale members are trimmed on read. The sorted set has no per-member TTL, so
   * without this it would grow forever with drivers who went home months ago.
   */
  async onlineDrivers(tenantId: string): Promise<string[]> {
    const cutoff = Date.now() - this.ttlSeconds * 1_000;
    const key = onlineKey(tenantId);

    const [, online] = await this.valkey
      .pipeline()
      .zremrangebyscore(key, "-inf", cutoff)
      .zrange(key, 0, -1)
      .exec()
      .then((results) => results ?? []);

    return Array.isArray(online?.[1]) ? (online[1] as string[]) : [];
  }

  /**
   * Last-known positions for many drivers at once.
   *
   * One `MGET` rather than N round trips — the dispatcher map asks this question
   * about every driver in a viewport, once per second, forever.
   */
  async lastKnownMany(
    tenantId: string,
    driverIds: readonly string[],
  ): Promise<LastKnownPosition[]> {
    if (driverIds.length === 0) {
      return [];
    }
    const raws = await this.valkey.mget(driverIds.map((id) => positionKey(tenantId, id)));
    const out: LastKnownPosition[] = [];
    for (const raw of raws) {
      if (raw === null) {
        continue; // Expired between the index read and this one — simply offline.
      }
      const parsed = parsePosition(raw);
      if (parsed !== null) {
        out.push(parsed);
      }
    }
    return out;
  }

  /** Clears a driver's presence — used when a shift ends. */
  async clear(tenantId: string, driverId: string): Promise<void> {
    await this.valkey
      .pipeline()
      .del(positionKey(tenantId, driverId))
      .zrem(onlineKey(tenantId), driverId)
      .exec();
  }
}

/** docs/06-database-design.md §5.3 names this key shape exactly. */
function positionKey(tenantId: string, driverId: string): string {
  return `tenant:${tenantId}:driver:${driverId}:pos`;
}

function onlineKey(tenantId: string): string {
  return `tenant:${tenantId}:drivers:online`;
}

/**
 * Parses a stored position, tolerating garbage.
 *
 * Returns null rather than throwing: a malformed cache entry — a partial write,
 * a format change across a deploy — must degrade to "this driver is offline",
 * never take down the dispatcher board.
 */
function parsePosition(raw: string): LastKnownPosition | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const driverId = record["driverId"];
    const lat = record["lat"];
    const lon = record["lon"];
    const at = record["at"];
    if (
      typeof driverId !== "string" ||
      typeof lat !== "number" ||
      typeof lon !== "number" ||
      typeof at !== "string"
    ) {
      return null;
    }
    const timestamp = new Date(at);
    if (Number.isNaN(timestamp.getTime())) {
      return null;
    }
    return {
      driverId,
      lat,
      lon,
      headingDeg: numberOrNull(record["hdg"]),
      speedMps: numberOrNull(record["spd"]),
      batteryPct: numberOrNull(record["bat"]),
      at: timestamp,
    };
  } catch {
    // Malformed JSON in the cache is not an error worth propagating.
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
