/**
 * Adaptive location sampling (docs/01 4.2: "background location with adaptive
 * sampling"; acceptance: < 6 %/hour battery during an active shift,
 * docs/technology-decisions.md §5.3).
 *
 * GPS is the battery. A courier spends much of a shift standing at a door or
 * in traffic, so sampling every five seconds while parked is pure drain. The
 * profile follows what the vehicle is doing:
 *
 *   MOVING      driving: dense fixes, so the live map and geofences are right
 *   SLOW        walking to a door, crawling in traffic
 *   STATIONARY  parked or waiting: sparse, low-power fixes
 *
 * and is relaxed again when the battery is low and not charging, because a
 * phone that dies at 15:00 reports nothing at all for the rest of the shift.
 *
 * Changing profile restarts the platform's location request, which costs a
 * little, so the classifier has hysteresis: it speeds up at once (a driver
 * pulling away must not be under-sampled), and slows down only after the
 * vehicle has been still for a while (a red light is not a parking spot).
 */

export type Motion = "MOVING" | "SLOW" | "STATIONARY";
type Accuracy = "HIGH" | "BALANCED";

export interface SamplingProfile {
  readonly motion: Motion;
  readonly lowBattery: boolean;
  /** Minimum time between fixes. */
  readonly timeIntervalMs: number;
  /** Minimum movement between fixes. */
  readonly distanceIntervalM: number;
  readonly accuracy: Accuracy;
  /**
   * How long the OS may hold fixes before waking the app with a batch. Waking
   * the JS runtime is a large share of the cost, so fixes are delivered in
   * groups rather than one by one.
   */
  readonly deferredIntervalMs: number;
  /** Upload the queue once its oldest point is this old (or it is full). */
  readonly flushAfterMs: number;
}

const BASE: Readonly<Record<Motion, Omit<SamplingProfile, "motion" | "lowBattery">>> = {
  MOVING: {
    timeIntervalMs: 5_000,
    distanceIntervalM: 10,
    accuracy: "HIGH",
    deferredIntervalMs: 30_000,
    flushAfterMs: 30_000,
  },
  SLOW: {
    timeIntervalMs: 10_000,
    distanceIntervalM: 15,
    accuracy: "HIGH",
    deferredIntervalMs: 60_000,
    flushAfterMs: 60_000,
  },
  STATIONARY: {
    timeIntervalMs: 60_000,
    distanceIntervalM: 50,
    accuracy: "BALANCED",
    deferredIntervalMs: 120_000,
    flushAfterMs: 120_000,
  },
};

/** At or below this, and not charging, sampling is relaxed. */
const LOW_BATTERY_PERCENT = 20;

export function profileFor(motion: Motion, battery: BatteryState): SamplingProfile {
  const base = BASE[motion];
  const lowBattery =
    !battery.charging && battery.percent !== null && battery.percent <= LOW_BATTERY_PERCENT;
  if (!lowBattery) {
    return { motion, lowBattery, ...base };
  }
  return {
    motion,
    lowBattery,
    timeIntervalMs: base.timeIntervalMs * 2,
    distanceIntervalM: base.distanceIntervalM * 2,
    accuracy: "BALANCED",
    deferredIntervalMs: base.deferredIntervalMs * 2,
    // The upload cadence is NOT relaxed: dispatch still needs to see the van,
    // and a radio wake-up per minute is cheap next to the GPS it replaces.
    flushAfterMs: base.flushAfterMs,
  };
}

/** Whether two profiles would configure the platform request identically. */
export function sameRequest(a: SamplingProfile, b: SamplingProfile): boolean {
  return (
    a.timeIntervalMs === b.timeIntervalMs &&
    a.distanceIntervalM === b.distanceIntervalM &&
    a.accuracy === b.accuracy &&
    a.deferredIntervalMs === b.deferredIntervalMs
  );
}

export interface BatteryState {
  /** 0..100, or null when the platform cannot say. */
  readonly percent: number | null;
  readonly charging: boolean;
}

export interface Fix {
  /** Epoch milliseconds, device clock. */
  readonly t: number;
  readonly lat: number;
  readonly lon: number;
  /** Metres per second, when the platform reports it. */
  readonly spd?: number;
}

/** m/s. Above: driving. Between this and STILL: walking or crawling. */
const MOVING_MPS = 4; // ≈ 14 km/h
const STILL_MPS = 0.7; // ≈ 2.5 km/h, GPS noise on a parked phone stays below
/** How long below STILL before the van is considered parked. */
const STILL_FOR_MS = 120_000;

/**
 * Turns the stream of fixes into a motion state, with hysteresis. Pure and
 * deterministic: it only ever sees the fixes it is given, so the background
 * task can rebuild it from the last few stored fixes after a cold start.
 */
export class MotionClassifier {
  private current: Motion;
  private stillSince: number | null = null;
  private last: Fix | null = null;

  constructor(initial: Motion = "MOVING") {
    this.current = initial;
  }

  get motion(): Motion {
    return this.current;
  }

  /** Feeds fixes in time order; returns the motion after the last one. */
  observe(fixes: readonly Fix[]): Motion {
    for (const fix of fixes) {
      this.step(fix);
    }
    return this.current;
  }

  private step(fix: Fix): void {
    const speed = fix.spd ?? this.derivedSpeed(fix);
    if (this.last !== null && fix.t <= this.last.t) {
      return; // out of order or duplicate: ignore, never travel back in time
    }
    this.last = fix;
    if (speed === null) {
      return;
    }
    if (speed >= MOVING_MPS) {
      this.current = "MOVING";
      this.stillSince = null;
      return;
    }
    if (speed >= STILL_MPS) {
      // Speed up at once; never slow down past SLOW without the still period.
      this.current = "SLOW";
      this.stillSince = null;
      return;
    }
    this.stillSince ??= fix.t;
    if (fix.t - this.stillSince >= STILL_FOR_MS) {
      this.current = "STATIONARY";
    }
  }

  /** Speed from the previous fix when the platform gives none. */
  private derivedSpeed(fix: Fix): number | null {
    if (this.last === null || fix.t <= this.last.t) {
      return null;
    }
    return haversineMetres(this.last, fix) / ((fix.t - this.last.t) / 1000);
  }
}

function haversineMetres(a: Pick<Fix, "lat" | "lon">, b: Pick<Fix, "lat" | "lon">): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
