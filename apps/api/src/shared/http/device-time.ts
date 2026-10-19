import { ValidationError } from "../errors/index.js";

/**
 * How far ahead of the server a device clock may run (5 minutes).
 *
 * Device time (`occurredAt`) is what SLA, plan-vs-actual and "which happened
 * first" are measured against (docs/01 §4.7 item 7.5), and an offline phone is
 * the usual source of it. Without a cap, one handset with its clock set a day
 * ahead records deliveries in the future: they read as early against every
 * SLA, and outrank every later event in any "newest wins" rule.
 */
export const DEVICE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * The time an action happened, as the server will record it.
 *
 * Absent → now. More than {@link DEVICE_CLOCK_SKEW_MS} ahead → refused, naming
 * the field. Within the allowance → clamped to now: a phone a few minutes fast
 * must not outrank what the server saw happen after it.
 */
export function resolveDeviceTime(
  value: Date | undefined,
  field = "occurredAt",
  now: Date = new Date(),
): Date {
  if (value === undefined) {
    return now;
  }
  if (value.getTime() > now.getTime() + DEVICE_CLOCK_SKEW_MS) {
    throw new ValidationError([
      {
        field,
        code: "IN_FUTURE",
        detail: `${field} is ahead of the server clock; check the device time`,
      },
    ]);
  }
  return value.getTime() > now.getTime() ? now : value;
}
