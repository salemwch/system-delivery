import { describe, expect, it } from "vitest";

import { NAV_GATES, P } from "../src/lib/permissions";

describe("permissions", () => {
  it("has all nav gate keys matching a message key", () => {
    const keys = Object.keys(NAV_GATES);
    expect(keys).toContain("dashboard");
    expect(keys).toContain("shipments");
    expect(keys).toContain("dispatch");
    expect(keys).toContain("fleet");
    expect(keys).toContain("network");
    expect(keys).toContain("merchants");
    expect(keys).toContain("pickups");
    expect(keys).toContain("custody");
    expect(keys).toContain("finance");
    expect(keys).toContain("complaints");
    expect(keys).toContain("users");
    expect(keys).toContain("audit");
  });

  it("dashboard has no permission gate", () => {
    expect(NAV_GATES.dashboard).toBeNull();
  });

  it("each gated section points to a real permission", () => {
    const allPermissions = new Set(Object.values(P));
    for (const [, permission] of Object.entries(NAV_GATES)) {
      if (permission !== null) {
        expect(allPermissions.has(permission)).toBe(true);
      }
    }
  });

  it("permission values follow domain:action format", () => {
    for (const value of Object.values(P)) {
      expect(value).toMatch(/^[a-z]+:[a-z_:]+$/u);
    }
  });

  it("carries the merchant-account permissions the console gates on", () => {
    // The three that decide what a COMMERCIAL sees on a merchant page: register
    // an account, mint its portal login, and (owner only) move its ownership.
    expect(P.MERCHANT_CREATE).toBe("merchant:create");
    expect(P.MERCHANT_ONBOARD).toBe("merchant:onboard");
    expect(P.MERCHANT_ASSIGN_MANAGER).toBe("merchant:assign_manager");
  });

  it("gates merchants on read, so a commercial keeps the section", () => {
    // A commercial holds merchant:read and pickup:read but no route/hub/ledger
    // permissions — the sidebar therefore resolves to their five sections
    // without any role check of its own.
    expect(NAV_GATES.merchants).toBe(P.MERCHANT_READ);
    expect(NAV_GATES.pickups).toBe(P.PICKUP_READ);
    expect(NAV_GATES.dispatch).toBe(P.ROUTE_READ);
    expect(NAV_GATES.finance).toBe(P.LEDGER_READ);
  });
});
