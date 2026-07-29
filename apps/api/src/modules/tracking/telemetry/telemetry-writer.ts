import { Inject, Injectable } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import type { Sql } from "postgres";

import { AppConfigService } from "../../../shared/config/index.js";
import { TELEMETRY_POSTGRES_CLIENT } from "../tracking.tokens.js";

/** One position, already validated and tenant-tagged, waiting to be flushed. */
export interface BufferedPosition {
  readonly tenantId: string;
  readonly driverId: string;
  readonly routeId: string | null;
  readonly time: Date;
  readonly lat: number;
  readonly lon: number;
  readonly speedMps: number | null;
  readonly headingDeg: number | null;
  readonly accuracyM: number | null;
  readonly batteryPct: number | null;
  readonly isMoving: boolean | null;
  readonly source: number | null;
}

/** Operational counters. Exposed so tests can assert behaviour, not timing. */
export interface WriterStats {
  readonly buffered: number;
  readonly written: number;
  readonly dropped: number;
  readonly failedFlushes: number;
}

/**
 * The batched telemetry writer.
 *
 * docs/06-database-design.md §5.1: *"Writes arrive via batched COPY, flushed
 * every 1 s or 1,000 rows — never row-at-a-time INSERT. This single decision is
 * the difference between 10k/sec working and not."*
 *
 * A position is not a transaction. Nobody reads one back, nothing branches on
 * it, and the row after it says almost the same thing. So ingest accepts into
 * memory and returns `202` immediately; durability is a background concern
 * measured in seconds, not a synchronous guarantee per ping.
 *
 * Three properties this class exists to hold, each of which has a test:
 *
 *  1. **Bounded.** A buffer that grows while the database is slow is an
 *     out-of-memory crash wearing a buffer's clothes. Past the high-water mark
 *     it sheds OLDEST first — positions sample a continuous signal, so the
 *     freshest ones are the ones worth keeping.
 *  2. **Drains on shutdown.** Otherwise every deploy silently eats the last
 *     second of every driver's trail.
 *  3. **A failed flush never reaches the caller.** The request returned 202 long
 *     ago; a database hiccup is logged and counted, not thrown into a driver's
 *     phone.
 *
 * Writes go through a DEDICATED pool (ADR-005 requirement 4), so a telemetry
 * burst cannot starve the transactional API of connections.
 */
@Injectable()
export class TelemetryWriter implements OnApplicationShutdown {
  private buffer: BufferedPosition[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private shuttingDown = false;

  private written = 0;
  private dropped = 0;
  private failedFlushes = 0;

  private readonly flushRows: number;
  private readonly flushIntervalMs: number;
  private readonly maxRows: number;

  constructor(
    @Inject(TELEMETRY_POSTGRES_CLIENT) private readonly sql: Sql,
    config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.flushRows = config.get("TELEMETRY_FLUSH_ROWS");
    this.flushIntervalMs = config.get("TELEMETRY_FLUSH_INTERVAL_MS");
    this.maxRows = config.get("TELEMETRY_BUFFER_MAX_ROWS");
  }

  /**
   * Buffers positions for the next flush. Never throws, never awaits the write.
   *
   * Returns how many were shed, so ingest can report honestly rather than
   * claiming acceptance for rows it dropped on the floor.
   */
  enqueue(positions: readonly BufferedPosition[]): { readonly shed: number } {
    if (positions.length === 0) {
      return { shed: 0 };
    }

    this.buffer.push(...positions);

    let shed = 0;
    if (this.buffer.length > this.maxRows) {
      shed = this.buffer.length - this.maxRows;
      // Oldest-first: a stale position is worth less than a fresh one, and the
      // map only ever renders the newest.
      this.buffer.splice(0, shed);
      this.dropped += shed;
      this.logger.warn(
        { shed, bufferMax: this.maxRows, totalDropped: this.dropped },
        "telemetry buffer full; shedding oldest positions",
      );
    }

    if (this.buffer.length >= this.flushRows) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }

    return { shed };
  }

  /**
   * Writes everything buffered, and does not return until the buffer is empty.
   *
   * Serialised: a second call while a flush is in flight awaits the first rather
   * than opening a competing write. Concurrent flushes would race on the buffer
   * and could write the same rows twice.
   *
   * ⚠️ The LOOP is load-bearing, and awaiting the in-flight flush alone is not
   * enough. `drain()` takes the whole buffer up front, so rows enqueued after it
   * started belong to the NEXT batch — a caller that simply awaited the current
   * flush would be told "everything is written" while those rows sat in memory.
   * On `onApplicationShutdown` that is the difference between draining the last
   * second of every driver's trail and silently discarding it, which is the
   * exact guarantee this class exists to provide.
   *
   * Terminates: `drain()` empties the buffer and `write()` contains its own
   * failures, so each pass strictly consumes what was there. Only new arrivals
   * extend the loop, and each one is written rather than spun on.
   */
  async flush(): Promise<void> {
    for (;;) {
      const inFlight = this.flushing;
      if (inFlight !== null) {
        await inFlight;
        if (this.buffer.length === 0) {
          return;
        }
        continue;
      }

      if (this.buffer.length === 0) {
        return;
      }

      this.flushing = this.drain().finally(() => {
        this.flushing = null;
      });
      await this.flushing;
    }
  }

  stats(): WriterStats {
    return {
      buffered: this.buffer.length,
      written: this.written,
      dropped: this.dropped,
      failedFlushes: this.failedFlushes,
    };
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearTimer();
    await this.flush();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.timer !== null || this.shuttingDown) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
    // Never hold the process open for a flush timer.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async drain(): Promise<void> {
    this.clearTimer();
    if (this.buffer.length === 0) {
      return;
    }

    // Take the whole buffer and let new arrivals accumulate in a fresh array, so
    // ingest is never blocked behind a write.
    const batch = this.buffer;
    this.buffer = [];

    await this.write(batch);
  }

  /**
   * One multi-row INSERT per tenant, each isolated from the others.
   *
   * Grouping by tenant is not cosmetic: the buffer is process-wide and holds
   * many tenants at once, and `app.current_tenant_id` is a single value per
   * transaction. Writing a mixed batch under one tenant's context would either
   * be rejected by the RLS policy or — far worse — file one tenant's positions
   * under another. Each group gets its own tenant-scoped transaction.
   *
   * Failures are contained per tenant. One tenant hitting a constraint must not
   * discard every other tenant's positions from the same flush; in a shared
   * buffer that would turn one bad actor into a fleet-wide outage.
   *
   * A failed group is NOT re-buffered. Retrying would pile a growing backlog on
   * a database that is already struggling, and the data samples a signal that
   * has since moved on. Loud, counted, and dropped.
   */
  private async write(batch: readonly BufferedPosition[]): Promise<void> {
    const byTenant = new Map<string, BufferedPosition[]>();
    for (const row of batch) {
      const group = byTenant.get(row.tenantId);
      if (group === undefined) {
        byTenant.set(row.tenantId, [row]);
      } else {
        group.push(row);
      }
    }

    for (const [tenantId, rows] of byTenant) {
      try {
        await this.writeGroup(tenantId, rows);
        this.written += rows.length;
      } catch (error: unknown) {
        this.failedFlushes += 1;
        this.logger.error(
          {
            err: error instanceof Error ? error : new Error(String(error)),
            rows: rows.length,
            failedFlushes: this.failedFlushes,
          },
          "telemetry flush failed for tenant; positions discarded",
        );
      }
    }
  }

  private async writeGroup(tenantId: string, rows: readonly BufferedPosition[]): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;

      // One multi-row INSERT for the whole group — a single round trip
      // regardless of batch size, and no SQL composed per position.
      //
      // `location` is absent on purpose: it is a GENERATED column derived from
      // lon/lat by the database (migration 0018), so the point cannot be built
      // wrong here and this stays a plain values insert.
      await tx`
          insert into driver_positions ${tx(
            rows.map((r) => ({
              time: r.time,
              tenant_id: r.tenantId,
              driver_id: r.driverId,
              route_id: r.routeId,
              lon: r.lon,
              lat: r.lat,
              speed_mps: r.speedMps,
              heading_deg: r.headingDeg,
              accuracy_m: r.accuracyM,
              battery_pct: r.batteryPct,
              is_moving: r.isMoving,
              source: r.source,
            })),
          )}
        `;
    });
  }
}
