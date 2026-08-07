/**
 * Converts a wall-clock time typed by a human into the UTC instant the API stores.
 *
 * A `<input type="datetime-local">` yields `2026-08-07T09:00` with NO zone. The
 * person meant nine in the morning *in Tunis*. Two wrong ways to read that:
 *
 *   - `new Date("2026-08-07T09:00")` parses it in the SERVER's zone. Correct
 *     only while the server happens to run in Africa/Tunis, and silently wrong
 *     the day it is deployed to a UTC container — every pickup window shifts by
 *     an hour and nobody notices until a driver arrives when the shop is shut.
 *   - Appending `Z` treats it as UTC, which is the same bug stated louder.
 *
 * The tenant's IANA zone is the authority (docs/02-domain-model.md: TIMESTAMPTZ
 * in UTC, locations carry an IANA timezone), so the offset is resolved against
 * that zone on that date — which also gets DST right, rather than assuming a
 * fixed +1.
 */

/**
 * The zone's offset from UTC at a given instant, in milliseconds.
 *
 * Derived by formatting the instant IN the zone and reading the wall-clock
 * numbers back. `Intl` is the only part of the platform that knows the tz
 * database, so this is the supported way to ask.
 */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const field = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? 0 : Number(value);
  };

  // `hour` comes back as 24 at midnight under hour12:false in some engines.
  const hour = field("hour") % 24;
  const asIfUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    hour,
    field("minute"),
    field("second"),
  );
  return asIfUtc - instant.getTime();
}

/**
 * `2026-08-07T09:00` in `Africa/Tunis` → `2026-08-07T08:00:00.000Z`.
 *
 * Returns null for anything that is not a wall-clock string, so the caller
 * reports a validation error rather than sending `Invalid Date` to the API.
 */
export function zonedToUtcIso(wallClock: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/u.test(wallClock)) {
    return null;
  }

  // Read the digits as though they were UTC, then subtract the zone's offset.
  const naive = new Date(`${wallClock.length === 16 ? `${wallClock}:00` : wallClock}Z`);
  if (Number.isNaN(naive.getTime())) {
    return null;
  }

  // Two passes. The first offset is measured at the wrong instant — off by the
  // offset itself — which straddles the boundary twice a year and lands an hour
  // out. Re-measuring at the corrected instant settles it.
  const firstPass = new Date(naive.getTime() - offsetMs(naive, timeZone));
  const corrected = new Date(naive.getTime() - offsetMs(firstPass, timeZone));
  return corrected.toISOString();
}
