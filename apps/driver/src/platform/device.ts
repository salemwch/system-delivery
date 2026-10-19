import * as Battery from "expo-battery";
import * as IntentLauncher from "expo-intent-launcher";
import * as Location from "expo-location";

import type { BatteryState, SamplingProfile } from "../core/sampling";

/**
 * The device seams: location updates, battery, permissions. Everything the
 * tracker needs from Android, behind plain functions, so the location layer
 * can be replaced by a native Kotlin module (docs/technology-decisions.md
 * §5.3, mitigation 3) without touching the rest of the app.
 */

/** Battery level arrives as 0..1; shown and sent as a whole percentage. */
const PERCENT = 100;

/** The background task's name. Versioned: renaming it orphans a running task. */
export const LOCATION_TASK = "driver-location-v1";

export async function batteryState(): Promise<BatteryState> {
  const [level, state] = await Promise.all([
    Battery.getBatteryLevelAsync(),
    Battery.getBatteryStateAsync(),
  ]);
  return {
    // -1 when unknown (emulators, some OEMs): say so rather than guess.
    percent: level < 0 ? null : Math.round(level * PERCENT),
    charging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
  };
}

export function isBatteryOptimised(): Promise<boolean> {
  return Battery.isBatteryOptimizationEnabledAsync();
}

/**
 * Android's list of apps under battery optimisation, where the driver exempts
 * this one. No permission needed (REQUEST_IGNORE_BATTERY_OPTIMIZATIONS is
 * Play-restricted and deliberately not requested).
 */
export async function openBatterySettings(): Promise<void> {
  await IntentLauncher.startActivityAsync(
    IntentLauncher.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS,
  );
}

export interface Permissions {
  readonly foreground: boolean;
  readonly background: boolean;
}

export async function permissions(): Promise<Permissions> {
  const [fg, bg] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
  ]);
  return { foreground: fg.granted, background: bg.granted };
}

/**
 * Foreground first, then background: Android 11+ refuses a background request
 * that is not preceded by a granted foreground one, and shows it on a separate
 * settings screen. Called only after the in-app disclosure was accepted
 * (Play's prominent-disclosure requirement).
 */
export async function requestPermissions(): Promise<Permissions> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) {
    return { foreground: false, background: false };
  }
  const bg = await Location.requestBackgroundPermissionsAsync();
  return { foreground: true, background: bg.granted };
}

export async function startUpdates(
  profile: SamplingProfile,
  title: string,
  body: string,
): Promise<void> {
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: profile.accuracy === "HIGH" ? Location.Accuracy.High : Location.Accuracy.Balanced,
    timeInterval: profile.timeIntervalMs,
    distanceInterval: profile.distanceIntervalM,
    deferredUpdatesInterval: profile.deferredIntervalMs,
    // Required on Android for collection with the app in the background: a
    // visible notification while tracking, which is also the driver's proof
    // that it stops when the shift does.
    foregroundService: {
      notificationTitle: title,
      notificationBody: body,
      killServiceOnDestroy: false,
    },
  });
}

export async function stopUpdates(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}

export function isUpdating(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
}
