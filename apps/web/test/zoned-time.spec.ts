import { describe, expect, it } from "vitest";

import { zonedToUtcIso } from "../src/lib/zoned-time";

/**
 * A pickup window typed as "09:00" must mean nine in the morning where the shop
 * is, not where the server happens to run. Getting this wrong sends a driver an
 * hour early or an hour late — and only in one half of the year, which is the
 * hardest kind of bug to notice.
 */
describe("zonedToUtcIso", () => {
  it("reads a wall-clock time in the tenant's zone, not the server's", () => {
    // Tunisia is UTC+1 year-round (no DST since 2009).
    expect(zonedToUtcIso("2026-08-07T09:00", "Africa/Tunis")).toBe("2026-08-07T08:00:00.000Z");
    expect(zonedToUtcIso("2026-01-15T14:30", "Africa/Tunis")).toBe("2026-01-15T13:30:00.000Z");
  });

  it("is a no-op for UTC itself", () => {
    expect(zonedToUtcIso("2026-08-07T09:00", "UTC")).toBe("2026-08-07T09:00:00.000Z");
  });

  it("handles a zone that DOES observe DST, on both sides of the change", () => {
    // Paris: UTC+1 in winter, UTC+2 in summer. A fixed offset gets one wrong.
    expect(zonedToUtcIso("2026-01-15T09:00", "Europe/Paris")).toBe("2026-01-15T08:00:00.000Z");
    expect(zonedToUtcIso("2026-08-15T09:00", "Europe/Paris")).toBe("2026-08-15T07:00:00.000Z");
  });

  it("handles a zone behind UTC", () => {
    expect(zonedToUtcIso("2026-08-07T09:00", "America/New_York")).toBe("2026-08-07T13:00:00.000Z");
  });

  it("handles a half-hour offset", () => {
    expect(zonedToUtcIso("2026-08-07T09:00", "Asia/Kolkata")).toBe("2026-08-07T03:30:00.000Z");
  });

  it("accepts the seconds some browsers append", () => {
    expect(zonedToUtcIso("2026-08-07T09:00:00", "Africa/Tunis")).toBe("2026-08-07T08:00:00.000Z");
  });

  it("returns null for anything that is not a wall-clock time", () => {
    // Null so the caller reports a field error, rather than posting
    // "Invalid Date" to the API and getting an opaque 422 back.
    expect(zonedToUtcIso("", "Africa/Tunis")).toBeNull();
    expect(zonedToUtcIso("not a time", "Africa/Tunis")).toBeNull();
    expect(zonedToUtcIso("2026-08-07", "Africa/Tunis")).toBeNull();
    expect(zonedToUtcIso("2026-13-45T99:99", "Africa/Tunis")).toBeNull();
  });
});
