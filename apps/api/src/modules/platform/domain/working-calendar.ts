/**
 * Working-calendar arithmetic (docs/01-mvp-scope.md §4.1 #1.8).
 *
 * Pure — no I/O, no database, no clock beyond what the caller passes in. The
 * scheduling rules are the kind that are easy to get subtly wrong and painful to
 * debug once they are entangled with queries, so they are unit-testable in
 * isolation.
 *
 * ⚠️ EVERYTHING HERE IS IN THE TENANT'S LOCAL TIME, converted at the boundary.
 * A courier opens at 08:00 Tunis time all year round; a promise computed in UTC
 * drifts by an hour whenever the offset changes, and every date an operator
 * reads is an hour wrong for half the year.
 */

/** ISO-8601: 1 = Monday … 7 = Sunday, matching PostgreSQL's `EXTRACT(ISODOW)`. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WorkingDay {
  readonly dayOfWeek: IsoWeekday;
  /** Local wall-clock, minutes from midnight. 08:00 → 480. */
  readonly opensAtMinutes: number;
  readonly closesAtMinutes: number;
  readonly isWorking: boolean;
}

export interface WorkingCalendar {
  /** IANA zone, e.g. `Africa/Tunis`. */
  readonly timezone: string;
  readonly days: readonly WorkingDay[];
  /** Closed days as `YYYY-MM-DD` in the tenant's own timezone. */
  readonly holidays: ReadonlySet<string>;
}

/** `HH:MM[:SS]` → minutes from midnight. */
export function parseTimeToMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/u.exec(value);
  if (match === null) {
    throw new Error(`Invalid time "${value}" — expected HH:MM`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`Invalid time "${value}"`);
  }
  return hours * 60 + minutes;
}

/**
 * The tenant-local parts of an instant.
 *
 * `Intl.DateTimeFormat` rather than manual offset arithmetic: it is the only
 * thing in the platform that knows when Tunisia last changed its DST rules, and
 * hand-rolled offsets are how "one hour out for three weeks a year" bugs happen.
 */
interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly minutes: number;
  readonly weekday: IsoWeekday;
  /** `YYYY-MM-DD`, for holiday lookup. */
  readonly dateKey: string;
}

const WEEKDAY_TO_ISO: Readonly<Record<string, IsoWeekday>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function localPartsOf(instant: Date, timezone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    parts[part.type] = part.value;
  }

  const year = Number(parts["year"]);
  const month = Number(parts["month"]);
  const day = Number(parts["day"]);
  // `en-GB` with hour12:false renders midnight as "24" in some ICU versions.
  const hour = Number(parts["hour"]) % 24;
  const minute = Number(parts["minute"]);
  const weekday = WEEKDAY_TO_ISO[parts["weekday"] ?? ""];

  if (weekday === undefined || Number.isNaN(year)) {
    throw new Error(`Could not read local time in timezone "${timezone}"`);
  }

  return {
    year,
    month,
    day,
    minutes: hour * 60 + minute,
    weekday,
    dateKey: `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/**
 * The UTC instant for a local wall-clock time in `timezone`.
 *
 * Solved by iteration rather than by looking up an offset: guess UTC, read back
 * what that renders as locally, and correct by the difference. Two passes settle
 * it even across a DST boundary, where the offset that applies depends on the
 * very answer being computed.
 */
export function instantAtLocalTime(
  year: number,
  month: number,
  day: number,
  minutesFromMidnight: number,
  timezone: string,
): Date {
  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  for (let pass = 0; pass < 2; pass += 1) {
    const rendered = localPartsOf(new Date(guess), timezone);
    const renderedUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      Math.floor(rendered.minutes / 60),
      rendered.minutes % 60,
      0,
      0,
    );
    const drift = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - renderedUtc;
    if (drift === 0) {
      break;
    }
    guess += drift;
  }

  return new Date(guess);
}

function dayFor(calendar: WorkingCalendar, weekday: IsoWeekday): WorkingDay | undefined {
  return calendar.days.find((d) => d.dayOfWeek === weekday);
}

function isOpenOn(calendar: WorkingCalendar, parts: LocalParts): WorkingDay | null {
  if (calendar.holidays.has(parts.dateKey)) {
    return null;
  }
  const day = dayFor(calendar, parts.weekday);
  return day !== undefined && day.isWorking ? day : null;
}

/** How many days ahead to search before giving up. */
const MAX_SEARCH_DAYS = 400;

/**
 * The first working instant at or after `from`.
 *
 * Used for re-attempt scheduling: a parcel that fails at 17:55 on Saturday is due
 * Monday at opening, not Sunday at 17:55. Promising a customer a delivery on a
 * day nobody works is worse than promising nothing.
 *
 * Throws if the tenant has no working day at all in the next year — a
 * configuration that would otherwise make every scheduling call hang or silently
 * return a nonsense date.
 */
export function nextWorkingInstant(from: Date, calendar: WorkingCalendar): Date {
  let cursor = from;

  for (let attempt = 0; attempt < MAX_SEARCH_DAYS; attempt += 1) {
    const parts = localPartsOf(cursor, calendar.timezone);
    const day = isOpenOn(calendar, parts);

    if (day !== null) {
      if (parts.minutes < day.opensAtMinutes) {
        // Before opening on a working day: wait for the doors.
        return instantAtLocalTime(
          parts.year,
          parts.month,
          parts.day,
          day.opensAtMinutes,
          calendar.timezone,
        );
      }
      if (parts.minutes < day.closesAtMinutes) {
        // Already inside working hours — now is the answer.
        return cursor;
      }
    }

    // Closed, a holiday, or past closing: move to the start of the next local
    // day and re-test. Built from local parts rather than by adding 24h, which
    // would land at 23:00 or 01:00 across a DST boundary.
    cursor = instantAtLocalTime(parts.year, parts.month, parts.day + 1, 0, calendar.timezone);
  }

  throw new Error(
    `No working day found within ${String(MAX_SEARCH_DAYS)} days — the tenant calendar has no open days`,
  );
}

/**
 * Adds `hours` of WORKING time to an instant.
 *
 * ⚠️ Working hours, not elapsed hours, and the difference is the whole point. A
 * parcel accepted at 17:00 on Friday with a 24-hour promise is due Monday
 * afternoon. Measured in wall-clock time it would be due Saturday evening —
 * marked late before anyone could possibly have delivered it, on a day the
 * courier is shut.
 */
export function addWorkingHours(from: Date, hours: number, calendar: WorkingCalendar): Date {
  if (hours < 0) {
    throw new Error("Cannot add a negative number of working hours");
  }

  let remainingMinutes = Math.round(hours * 60);
  let cursor = nextWorkingInstant(from, calendar);

  if (remainingMinutes === 0) {
    return cursor;
  }

  for (let attempt = 0; attempt < MAX_SEARCH_DAYS; attempt += 1) {
    const parts = localPartsOf(cursor, calendar.timezone);
    const day = isOpenOn(calendar, parts);

    if (day === null) {
      cursor = nextWorkingInstant(
        instantAtLocalTime(parts.year, parts.month, parts.day + 1, 0, calendar.timezone),
        calendar,
      );
      continue;
    }

    const minutesLeftToday = day.closesAtMinutes - parts.minutes;

    if (remainingMinutes <= minutesLeftToday) {
      return instantAtLocalTime(
        parts.year,
        parts.month,
        parts.day,
        parts.minutes + remainingMinutes,
        calendar.timezone,
      );
    }

    // Consume the rest of today and continue from the next working day's opening.
    remainingMinutes -= minutesLeftToday;
    cursor = nextWorkingInstant(
      instantAtLocalTime(parts.year, parts.month, parts.day + 1, 0, calendar.timezone),
      calendar,
    );
  }

  throw new Error(
    `Could not add ${String(hours)} working hours within ${String(MAX_SEARCH_DAYS)} days`,
  );
}
