/**
 * A sensible default pickup window: tomorrow morning, in the tenant's timezone.
 *
 * Returned in the `YYYY-MM-DDTHH:mm` shape `<input type="datetime-local">`
 * requires — that input has no timezone, so the values must already be wall
 * clock IN THE TENANT'S ZONE or the box shows the server's idea of the time.
 *
 * Tomorrow rather than today because a request made at 17:00 for a window
 * starting at 09:00 would be in the past, and the API would take it: the only
 * rule is that `to` follows `from`. A default nobody notices is a default that
 * has to be right.
 */

/** 09:00–12:00. The morning round, before the afternoon deliveries go out. */
const WINDOW_START_HOUR = 9;
const WINDOW_END_HOUR = 12;

export function nextWorkingWindow(timeZone: string): { from: string; to: string } {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // The calendar date AS IT IS in the tenant's zone — near midnight that is a
  // different day from the server's, and booking a pickup for the wrong day is
  // exactly the kind of error nobody checks for.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(tomorrow);

  const pad = (hour: number): string => String(hour).padStart(2, "0");
  return {
    from: `${parts}T${pad(WINDOW_START_HOUR)}:00`,
    to: `${parts}T${pad(WINDOW_END_HOUR)}:00`,
  };
}
