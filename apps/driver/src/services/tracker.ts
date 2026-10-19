import type { LocationObject } from "expo-location";

import { telemetryUploader } from "../core/endpoints";
import { MotionClassifier, profileFor, sameRequest } from "../core/sampling";
import type { Motion, SamplingProfile } from "../core/sampling";
import { flush, shouldFlush } from "../core/telemetry";
import type { WirePosition } from "../core/telemetry";
import { readMeta, writeMeta } from "../platform/database";
import { batteryState, isUpdating, startUpdates, stopUpdates } from "../platform/device";
import { sqliteTelemetryStore } from "../platform/telemetry-store";
import { api, newId } from "./runtime";

/**
 * Shift-bound location tracking (docs/01 4.2, docs/technology-decisions §5.3).
 *
 * ⚠️ COLLECTION FOLLOWS THE SHIFT, ON THE DEVICE TOO. The server already
 * refuses telemetry outside an open shift (privacy gate); the app also stops
 * collecting the moment it learns the shift is over, rather than gathering
 * points nobody may receive. `tracking.shiftId` in the database is the one
 * switch: set when tracking starts for a shift, cleared when it stops.
 *
 * State lives in the encrypted database, never in memory, because the
 * background task and the UI are separate runtimes and Android may kill
 * either at any moment.
 */
const META = {
  shiftId: "tracking.shiftId",
  motion: "tracking.motion",
  lastFixAt: "tracking.lastFixAt",
  lastUploadAt: "tracking.lastUploadAt",
  attempt: "tracking.attempt",
  retryAt: "tracking.retryAt",
  mockedDropped: "tracking.mockedDropped",
  notification: "tracking.notification",
} as const;

export interface Notification {
  readonly title: string;
  readonly body: string;
}

/** Starts (or re-starts) collection for an open shift. */
export async function startTracking(shiftId: string, notification: Notification): Promise<void> {
  await writeMeta(META.shiftId, shiftId);
  await writeMeta(META.notification, JSON.stringify(notification));
  const motion = await storedMotion();
  await startUpdates(
    profileFor(motion, await batteryState()),
    notification.title,
    notification.body,
  );
}

/** Stops collection, then uploads what was already captured. */
export async function stopTracking(): Promise<void> {
  await stopUpdates();
  await writeMeta(META.shiftId, "");
}

export async function trackingShift(): Promise<string | null> {
  const value = await readMeta(META.shiftId);
  return value === null || value === "" ? null : value;
}

/**
 * The background task's handler: store the fixes, adapt the sampling, and
 * upload when due. A network or server failure is an outcome, never an
 * exception (the queue keeps the data); only a local failure (the database)
 * throws, and the task records it (background/location-task.ts).
 */
export async function onFixes(locations: readonly LocationObject[]): Promise<void> {
  const shiftId = await trackingShift();
  if (shiftId === null) {
    // No open shift on record: collecting would be surveillance. Stop.
    await stopUpdates();
    return;
  }
  const battery = await batteryState();
  // A mocked fix (developer options, a spoofing app) is not evidence of where
  // the van is; it never reaches dispatch, and the count is kept for review.
  const genuine = locations.filter((location) => location.mocked !== true);
  if (genuine.length < locations.length) {
    const dropped =
      Number((await readMeta(META.mockedDropped)) ?? "0") + locations.length - genuine.length;
    await writeMeta(META.mockedDropped, String(dropped));
  }
  const positions = genuine.map((location) => toWire(location, battery.percent));
  await sqliteTelemetryStore.append(shiftId, positions);
  const last = genuine.at(-1);
  if (last !== undefined) {
    await writeMeta(META.lastFixAt, String(last.timestamp));
  }

  await adaptSampling(genuine, battery);
  await uploadIfDue(false);
}

/**
 * Uploads the queue if it is due (or `force`), respecting the backoff after a
 * failure. Safe to call from the UI and the task at once: a batch keeps its id,
 * and the server de-duplicates on it.
 */
export async function uploadIfDue(force: boolean): Promise<void> {
  const now = Date.now();
  const retryAt = Number((await readMeta(META.retryAt)) ?? "0");
  if (!force && now < retryAt) {
    return;
  }
  const profile = profileFor(await storedMotion(), await batteryState());
  const depth = await sqliteTelemetryStore.depth();
  const oldest = await sqliteTelemetryStore.oldestAt();
  if (!force && !shouldFlush(depth, oldest, profile.flushAfterMs, now)) {
    return;
  }
  const attempt = Number((await readMeta(META.attempt)) ?? "0");
  const report = await flush({
    store: sqliteTelemetryStore,
    upload: telemetryUploader(await api()),
    newId,
    random: Math.random,
    attempt,
  });
  if (report.sentBatches > 0) {
    await writeMeta(META.lastUploadAt, String(Date.now()));
  }
  if (report.retryInMs === null) {
    await writeMeta(META.attempt, "0");
    await writeMeta(META.retryAt, "0");
  } else {
    await writeMeta(META.attempt, String(attempt + 1));
    await writeMeta(META.retryAt, String(Date.now() + report.retryInMs));
  }
  if (report.shiftClosed) {
    await stopTracking();
  }
}

/** Restarts the platform request only when the profile would change it. */
async function adaptSampling(
  fixes: readonly LocationObject[],
  battery: Awaited<ReturnType<typeof batteryState>>,
): Promise<void> {
  const before = await storedMotion();
  const classifier = new MotionClassifier(before);
  const after = classifier.observe(
    fixes.map((f) => ({
      t: f.timestamp,
      lat: f.coords.latitude,
      lon: f.coords.longitude,
      ...(f.coords.speed !== null && f.coords.speed >= 0 ? { spd: f.coords.speed } : {}),
    })),
  );
  await writeMeta(META.motion, after);
  const current: SamplingProfile = profileFor(before, battery);
  const next: SamplingProfile = profileFor(after, battery);
  if (!sameRequest(current, next) && (await isUpdating())) {
    const notification = await storedNotification();
    if (notification !== null) {
      await startUpdates(next, notification.title, notification.body);
    }
  }
}

async function storedMotion(): Promise<Motion> {
  const value = await readMeta(META.motion);
  return value === "MOVING" || value === "SLOW" || value === "STATIONARY" ? value : "MOVING";
}

async function storedNotification(): Promise<Notification | null> {
  const raw = await readMeta(META.notification);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "title" in parsed &&
      "body" in parsed &&
      typeof parsed.title === "string" &&
      typeof parsed.body === "string"
    ) {
      return { title: parsed.title, body: parsed.body };
    }
    return null;
  } catch {
    return null;
  }
}

/** The platform's fix in the server's terse format; absent fields stay absent. */
function toWire(location: LocationObject, battery: number | null): WirePosition {
  const { coords } = location;
  return {
    t: new Date(location.timestamp).toISOString(),
    lat: coords.latitude,
    lon: coords.longitude,
    // Android's fused provider: GPS, Wi-Fi and cell combined.
    src: "FUSED",
    ...(coords.accuracy !== null && coords.accuracy >= 0 ? { acc: coords.accuracy } : {}),
    ...(coords.speed !== null && coords.speed >= 0 ? { spd: coords.speed } : {}),
    ...(coords.heading !== null && coords.heading >= 0 && coords.heading < 360
      ? { hdg: coords.heading }
      : {}),
    ...(battery === null ? {} : { bat: battery }),
  };
}

export interface Diagnostics {
  readonly shiftId: string | null;
  readonly motion: Motion;
  readonly queued: number;
  readonly lastFixAt: number | null;
  readonly lastUploadAt: number | null;
  readonly mockedDropped: number;
}

export async function diagnostics(): Promise<Diagnostics> {
  const num = async (key: string) => {
    const value = Number((await readMeta(key)) ?? "");
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    shiftId: await trackingShift(),
    motion: await storedMotion(),
    queued: await sqliteTelemetryStore.depth(),
    lastFixAt: await num(META.lastFixAt),
    lastUploadAt: await num(META.lastUploadAt),
    mockedDropped: (await num(META.mockedDropped)) ?? 0,
  };
}
