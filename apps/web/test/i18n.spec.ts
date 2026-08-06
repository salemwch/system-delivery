import { describe, expect, it } from "vitest";

import { directionOf, MESSAGES, STATUS_LABELS, toLocale } from "../src/lib/i18n";
import type { Locale } from "../src/lib/i18n";

describe("toLocale", () => {
  it("returns known locales", () => {
    expect(toLocale("ar")).toBe("ar");
    expect(toLocale("fr")).toBe("fr");
    expect(toLocale("en")).toBe("en");
  });

  it("is case-insensitive", () => {
    expect(toLocale("AR")).toBe("ar");
    expect(toLocale("Fr")).toBe("fr");
  });

  it("falls back to fr for unknown", () => {
    expect(toLocale("de")).toBe("fr");
    expect(toLocale("")).toBe("fr");
    expect(toLocale("xyz")).toBe("fr");
  });
});

describe("directionOf", () => {
  it("returns rtl for Arabic", () => {
    expect(directionOf("ar")).toBe("rtl");
  });

  it("returns ltr for French and English", () => {
    expect(directionOf("fr")).toBe("ltr");
    expect(directionOf("en")).toBe("ltr");
  });
});

describe("MESSAGES", () => {
  const locales: Locale[] = ["ar", "fr", "en"];

  it("has all required keys for every locale", () => {
    for (const locale of locales) {
      const messages = MESSAGES[locale];
      expect(messages.title).toBeTruthy();
      expect(messages.login).toBeTruthy();
      expect(messages.signIn).toBeTruthy();
      expect(messages.signOut).toBeTruthy();
      expect(messages.dashboard).toBeTruthy();
      expect(messages.shipments).toBeTruthy();
      expect(messages.dispatch).toBeTruthy();
      expect(messages.fleet).toBeTruthy();
      expect(messages.network).toBeTruthy();
      expect(messages.merchants).toBeTruthy();
      expect(messages.pickups).toBeTruthy();
      expect(messages.custody).toBeTruthy();
      expect(messages.finance).toBeTruthy();
      expect(messages.complaints).toBeTruthy();
      expect(messages.users).toBeTruthy();
      expect(messages.audit).toBeTruthy();
      // The merchant-account screens a commercial lives in.
      expect(messages.newMerchant).toBeTruthy();
      expect(messages.accountManager).toBeTruthy();
      expect(messages.createPortalLogin).toBeTruthy();
      expect(messages.credentialShownOnce).toBeTruthy();
      expect(messages.performance).toBeTruthy();
      // The pickups page: reference/contact/window columns and the claim action.
      expect(messages.reference).toBeTruthy();
      expect(messages.parcels).toBeTruthy();
      expect(messages.pickupWindow).toBeTruthy();
      expect(messages.claimPickup).toBeTruthy();
      expect(messages.pickupNotClaimable).toBeTruthy();
      expect(messages.assignedToYou).toBeTruthy();
    }
  });

  it("has matching keys across all locales", () => {
    const enKeys = Object.keys(MESSAGES.en);
    const frKeys = Object.keys(MESSAGES.fr);
    const arKeys = Object.keys(MESSAGES.ar);
    expect(frKeys).toEqual(enKeys);
    expect(arKeys).toEqual(enKeys);
  });
});

describe("STATUS_LABELS", () => {
  const statuses = [
    "CREATED", "PICKUP_ASSIGNED", "PICKED_UP", "AT_HUB", "IN_TRANSIT",
    "OUT_FOR_DELIVERY", "DELIVERED", "FAILED_ATTEMPT", "RETURN_PENDING",
    "RETURNED", "CANCELLED",
  ];

  it("has labels for all statuses in all locales", () => {
    for (const locale of ["ar", "fr", "en"] as const) {
      for (const status of statuses) {
        expect(STATUS_LABELS[locale][status]).toBeTruthy();
      }
    }
  });
});
