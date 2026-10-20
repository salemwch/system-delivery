import { useEffect, useRef } from "react";

import { currentFix } from "../platform/device";
import type { Fix } from "../platform/device";

/** How long a tap waits for a position that is not there yet. */
const TAP_WAIT_MS = 1_500;

/**
 * The driver's position at the moment of the tap, without making the tap
 * wait: the fix is requested when the screen opens, and the tap takes
 * whatever is ready within a moment (or none: the action is never blocked).
 */
export function useFixAtTap(): () => Promise<Fix | null> {
  const pending = useRef<Promise<Fix | null>>(Promise.resolve(null));
  useEffect(() => {
    pending.current = currentFix().catch(() => null);
  }, []);
  return () =>
    Promise.race([
      pending.current,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TAP_WAIT_MS)),
    ]);
}

/** The command fields for a position (absent fields stay absent). */
export function locationFields(fix: Fix | null): Record<string, unknown> {
  if (fix === null) return {};
  return {
    location: { lat: fix.lat, lng: fix.lng },
    ...(fix.accuracyM === null ? {} : { locationAccuracyM: fix.accuracyM }),
  };
}
