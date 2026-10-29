import type { LocationObject } from "expo-location";
import * as TaskManager from "expo-task-manager";

import { recordLastError } from "../platform/database";
import { LOCATION_TASK } from "../platform/device";
import { onFixes } from "../services/tracker";

/**
 * The background location task. Defined at module scope and imported first by
 * the entry point (index.ts): when Android wakes the app headless to deliver
 * fixes, no screen is mounted, and a task defined inside a component would not
 * exist (expo-task-manager: "must be called in the global scope").
 *
 * The payload is the OS's, so it is narrowed, not trusted. A failure is
 * recorded for the diagnostics screen and never rethrown: the fixes that did
 * reach the queue stay there either way.
 */
TaskManager.defineTask<unknown>(LOCATION_TASK, async ({ data, error }) => {
  if (error !== null) {
    await recordLastError("tracking", `task error: ${error.message}`);
    return;
  }
  const locations = locationsOf(data);
  if (locations.length === 0) {
    return;
  }
  try {
    await onFixes(locations);
  } catch (failure) {
    await recordLastError("tracking", failure);
  }
});

function locationsOf(data: unknown): LocationObject[] {
  if (typeof data !== "object" || data === null || !("locations" in data)) {
    return [];
  }
  const { locations } = data;
  if (!Array.isArray(locations)) {
    return [];
  }
  return locations.filter(isLocation);
}

function isLocation(value: unknown): value is LocationObject {
  if (typeof value !== "object" || value === null) return false;
  if (!("timestamp" in value) || typeof value.timestamp !== "number") return false;
  if (!("coords" in value) || typeof value.coords !== "object" || value.coords === null)
    return false;
  const coords = value.coords;
  return (
    "latitude" in coords &&
    typeof coords.latitude === "number" &&
    "longitude" in coords &&
    typeof coords.longitude === "number"
  );
}
