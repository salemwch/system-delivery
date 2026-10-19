import { z } from "zod";

/**
 * The durable telemetry pipeline: GPS fixes → local queue → batched,
 * idempotent uploads to `POST /v1/telemetry` (docs/05 §5).
 *
 * The rules that make the field-test target (> 95 % of expected batches
 * received over an 8-hour shift) reachable on a phone that loses signal:
 *
 *   - Every fix is written to the encrypted local database before anything
 *     else happens to it. A killed app, a dead network or a reboot loses
 *     nothing already captured.
 *   - A batch keeps its `batchId` until the server acknowledges it. A retry
 *     after a lost response is the SAME batch, which the server de-duplicates
 *     on `batchId`; a new id would write every point twice.
 *   - Points are uploaded oldest first, one shift per batch, at most 1,000 per
 *     batch (the server's cap).
 *   - A failure is classified once, here: retry with backoff, drop as
 *     unrecoverable, or stop tracking because the shift is no longer open.
 *
 * Platform-free: the queue is a port (SQLite on the device, memory in tests)
 * and the network is an injected uploader.
 */

/**
 * One point on the wire, in the server's terse format (docs/05 §5, the API's
 * positionSchema). Also how a queued row is read back: a row that does not
 * match is skipped, never uploaded as garbage.
 */
export const wirePositionSchema = z.strictObject({
  t: z.string(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  acc: z.number().nonnegative().optional(),
  spd: z.number().nonnegative().optional(),
  hdg: z.number().min(0).lt(360).optional(),
  bat: z.number().int().min(0).max(100).optional(),
  src: z.enum(["GPS", "NETWORK", "FUSED"]).optional(),
});
export type WirePosition = z.infer<typeof wirePositionSchema>;

export interface QueuedBatch {
  readonly batchId: string;
  readonly shiftId: string;
  readonly positions: readonly WirePosition[];
}

/** The local queue. Implementations must make every method atomic. */
export interface TelemetryStore {
  append(shiftId: string, positions: readonly WirePosition[]): Promise<void>;
  /**
   * The batch to send next: an already-formed, unacknowledged batch if one
   * exists (so its id is reused), otherwise up to `max` of the oldest queued
   * points of one shift, sealed under `newBatchId`. Null when empty.
   */
  nextBatch(max: number, newBatchId: string): Promise<QueuedBatch | null>;
  /** Removes a batch the server accepted, or one that can never be accepted. */
  remove(batchId: string): Promise<void>;
  depth(): Promise<number>;
  /** Epoch ms of the oldest queued point, or null when empty. */
  oldestAt(): Promise<number | null>;
}

/** What the uploader learned from one attempt. */
export type UploadOutcome =
  | { readonly kind: "ACCEPTED"; readonly accepted: number; readonly rejected: number }
  | { readonly kind: "OUTSIDE_SHIFT" }
  | { readonly kind: "UNAUTHENTICATED" }
  | { readonly kind: "INVALID"; readonly status: number }
  | { readonly kind: "TRANSIENT"; readonly reason: string; readonly retryAfterMs?: number };

export type Uploader = (batch: QueuedBatch) => Promise<UploadOutcome>;

/** The server refuses more than this per request (ingestTelemetrySchema). */
const MAX_BATCH = 1_000;
/** Upload as soon as this many points wait, whatever their age. */
export const FLUSH_AT_DEPTH = 50;
/** Never send more than this many batches in one flush: keep wake-ups short. */
const MAX_BATCHES_PER_FLUSH = 10;

export function shouldFlush(
  depth: number,
  oldestAtMs: number | null,
  flushAfterMs: number,
  nowMs: number,
): boolean {
  if (depth === 0 || oldestAtMs === null) {
    return false;
  }
  return depth >= FLUSH_AT_DEPTH || nowMs - oldestAtMs >= flushAfterMs;
}

/**
 * Exponential backoff with full jitter (AWS Architecture Blog, "Exponential
 * Backoff And Jitter"): 5 s, 10 s, 20 s ... capped at 5 minutes, uniformly
 * jittered so a fleet coming back online after an outage does not retry in
 * lock-step and flatten the API.
 */
export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(300_000, 5_000 * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

export interface FlushReport {
  readonly sentBatches: number;
  readonly sentPoints: number;
  readonly droppedBatches: number;
  /** Set when the server says the shift is not open: tracking must stop. */
  readonly shiftClosed: boolean;
  /** Set when the session must be renewed before anything else is sent. */
  readonly needsSignIn: boolean;
  /** Set when the queue still holds work; the caller waits this long. */
  readonly retryInMs: number | null;
}

export interface FlushDeps {
  readonly store: TelemetryStore;
  readonly upload: Uploader;
  readonly newId: () => string;
  readonly random: () => number;
  /** Consecutive failed attempts so far, for backoff; owned by the caller. */
  readonly attempt: number;
}

/**
 * Sends the queue, oldest first, until it is empty, a failure stops it, or
 * the per-wake-up cap is reached. Never throws for a network or server
 * failure: those are outcomes, and the queue keeps the data.
 */
export async function flush(deps: FlushDeps): Promise<FlushReport> {
  let sentBatches = 0;
  let sentPoints = 0;
  let droppedBatches = 0;
  for (let i = 0; i < MAX_BATCHES_PER_FLUSH; i += 1) {
    const batch = await deps.store.nextBatch(MAX_BATCH, deps.newId());
    if (batch === null) {
      return {
        sentBatches,
        sentPoints,
        droppedBatches,
        shiftClosed: false,
        needsSignIn: false,
        retryInMs: null,
      };
    }
    const outcome = await deps.upload(batch);
    switch (outcome.kind) {
      case "ACCEPTED":
        await deps.store.remove(batch.batchId);
        sentBatches += 1;
        sentPoints += batch.positions.length;
        continue;
      case "INVALID":
        // The server will never take this batch (a malformed point): keeping
        // it would block every point queued behind it, for the whole shift.
        await deps.store.remove(batch.batchId);
        droppedBatches += 1;
        continue;
      case "OUTSIDE_SHIFT":
        // The shift is closed: the server refuses location by design (privacy
        // gate). The points cannot be accepted, and collecting more is wrong.
        await deps.store.remove(batch.batchId);
        droppedBatches += 1;
        return {
          sentBatches,
          sentPoints,
          droppedBatches,
          shiftClosed: true,
          needsSignIn: false,
          retryInMs: null,
        };
      case "UNAUTHENTICATED":
        // Refresh already failed inside the client: keep the data, ask for sign-in.
        return {
          sentBatches,
          sentPoints,
          droppedBatches,
          shiftClosed: false,
          needsSignIn: true,
          retryInMs: null,
        };
      case "TRANSIENT":
        return {
          sentBatches,
          sentPoints,
          droppedBatches,
          shiftClosed: false,
          needsSignIn: false,
          retryInMs: outcome.retryAfterMs ?? backoffMs(deps.attempt, deps.random),
        };
    }
  }
  // Cap reached with work left: continue soon, without backoff.
  return {
    sentBatches,
    sentPoints,
    droppedBatches,
    shiftClosed: false,
    needsSignIn: false,
    retryInMs: 1_000,
  };
}
