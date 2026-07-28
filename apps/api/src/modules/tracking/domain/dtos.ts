import { z } from "zod";

/**
 * Validated input contracts for the tracking module (docs/05-api-contracts.md §5).
 *
 * Strict schemas — unknown keys are rejected, not silently stripped.
 *
 * ⚠️ The terse field names are deliberate and specified: at ~10,000 positions/sec
 * this is the highest-volume payload in the system, and `lat` versus `latitude`
 * is real bandwidth at that rate. Do not "improve" them — the driver app and any
 * future Go gateway are written against this exact shape.
 */

/** GPS fix source. Stored as a small int; accuracy weighting differs by source. */
export const POSITION_SOURCES = ["GPS", "NETWORK", "FUSED"] as const;
export type PositionSource = (typeof POSITION_SOURCES)[number];

const SOURCE_CODES: Readonly<Record<PositionSource, number>> = {
  GPS: 1,
  NETWORK: 2,
  FUSED: 3,
};

export function sourceCode(source: PositionSource | undefined): number | undefined {
  return source === undefined ? undefined : SOURCE_CODES[source];
}

/**
 * One GPS sample.
 *
 * Every field except position and time is optional: a device reports what its
 * sensors give it, and refusing a fix because the battery level was unavailable
 * would lose real location data for no reason.
 */
const positionSchema = z.strictObject({
  /** Device clock. */
  t: z.coerce.date(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Accuracy radius in metres. Larger is worse. */
  acc: z.number().nonnegative().optional(),
  /** Speed, metres per second. */
  spd: z.number().nonnegative().optional(),
  /** Heading, degrees clockwise from true north. */
  hdg: z.number().min(0).lt(360).optional(),
  /** Battery percentage — a fleet-health and driver-support signal. */
  bat: z.number().int().min(0).max(100).optional(),
  /** Device activity recognition: is the driver actually moving? */
  mov: z.boolean().optional(),
  src: z.enum(POSITION_SOURCES).optional(),
});
export type PositionInput = z.infer<typeof positionSchema>;

export const ingestTelemetrySchema = z.strictObject({
  shiftId: z.uuid(),
  /**
   * Idempotency for the driver app's retry. The app is offline-first and WILL
   * re-send; without this a lost response becomes duplicate rows.
   */
  batchId: z.uuid(),
  routeId: z.uuid().optional(),
  /**
   * Capped at 1,000 — one flush unit. A device that has been offline for hours
   * sends several batches rather than one enormous request, which keeps request
   * memory bounded and lets partial progress stick.
   */
  positions: z.array(positionSchema).min(1).max(1_000),
});
export type IngestTelemetryInput = z.infer<typeof ingestTelemetrySchema>;
