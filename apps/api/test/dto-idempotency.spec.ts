import { describe, expect, it } from "vitest";

import {
  createSettlementSchema,
  submitRemittanceSchema,
} from "../src/modules/finance/domain/dtos.js";
import { startShiftSchema } from "../src/modules/fleet/domain/dtos.js";
import { createShipmentSchema } from "../src/modules/shipment/domain/dtos.js";

/**
 * Request schemas must survive being parsed TWICE.
 *
 * ⚠️ This is not a theoretical property — it is how every HTTP request works
 * here. The controller validates with `@Body(zodBody(schema))`, and the service
 * it calls takes `unknown` and validates again with the SAME schema, because
 * that service is also reachable from tests, bulk import and other services.
 *
 * A schema whose `.transform()` changes the type therefore has to accept its own
 * output. `amountMinor` did not: the first parse turned `12500` into `12500n`,
 * the second saw a bigint that matched neither union arm, and the request failed
 * with INVALID_UNION.
 *
 * The consequence was that **creating a COD shipment over HTTP always failed** —
 * the P0 feature of a cash-on-delivery market, unreachable through the API —
 * while every existing test passed, because a test calls the service directly
 * and parses exactly once. Only a request over the wire could find it.
 */

/** Parse, then parse the RESULT. Both must succeed and agree. */
function parsesTwice<T>(schema: { parse: (v: unknown) => T }, input: unknown): T {
  const once = schema.parse(input);
  const twice = schema.parse(once);
  expect(twice).toEqual(once);
  return twice;
}

describe("schema idempotency", () => {
  const shipment = {
    idempotencyKey: "k-1",
    recipientName: "Sonia Gharbi",
    recipientPhone: "+21620555111",
    senderName: "Boutique El Manar",
    senderPhone: "+21620000001",
    origin: { rawInput: "12 Rue de Rome, Tunis", countryCode: "TN" },
    destination: { rawInput: "5 Avenue Habib Bourguiba, Ariana", countryCode: "TN" },
    currency: "TND",
  };

  it("survives a COD amount being parsed twice", () => {
    const result = parsesTwice(createShipmentSchema, { ...shipment, codAmountMinor: 12_500 });
    // 12500 millimes is 12.500 TND. The value must not change on the way through.
    expect(result.codAmountMinor).toBe(12_500n);
  });

  it("survives a declared value being parsed twice", () => {
    const result = parsesTwice(createShipmentSchema, {
      ...shipment,
      declaredValueMinor: 99_000,
      codAmountMinor: 0,
    });
    expect(result.declaredValueMinor).toBe(99_000n);
  });

  it("accepts an amount as a string, and still round-trips", () => {
    // Clients that cannot represent large integers in JSON send a string.
    const result = parsesTwice(createShipmentSchema, { ...shipment, codAmountMinor: "45500" });
    expect(result.codAmountMinor).toBe(45_500n);
  });

  it("still REJECTS a negative amount", () => {
    // Idempotency must not have widened the schema into accepting nonsense.
    expect(() =>
      createShipmentSchema.parse({ ...shipment, codAmountMinor: -1 }),
    ).toThrow();
    expect(() =>
      createShipmentSchema.parse({ ...shipment, codAmountMinor: -1n }),
    ).toThrow();
  });

  it("still rejects a fractional amount", () => {
    // Minor units are integers. 12.5 millimes does not exist.
    expect(() =>
      createShipmentSchema.parse({ ...shipment, codAmountMinor: 12.5 }),
    ).toThrow();
  });

  it("survives dates being parsed twice", () => {
    // `z.coerce.date()` is already idempotent — a Date coerces to itself. This
    // pins that, so a future change to date handling cannot break the same way.
    const result = parsesTwice(createShipmentSchema, {
      ...shipment,
      codAmountMinor: 0,
      promisedTo: "2026-08-01T10:00:00Z",
    });
    expect(result.promisedTo).toBeInstanceOf(Date);
  });

  // The other two modules carrying a bigint transform. Same shape, same trap.
  it("holds for the finance schemas", () => {
    const remittance = parsesTwice(submitRemittanceSchema, {
      driverId: "019fb59d-15ca-7bea-bc06-07991643ae56",
      hubId: "019fb59d-1610-727f-a61f-0fa4cb352a9d",
      declaredAmountMinor: 45_000,
      currency: "TND",
    });
    expect(remittance.declaredAmountMinor).toBe(45_000n);

    const settlement = parsesTwice(createSettlementSchema, {
      merchantId: "019fb59d-1610-727f-a61f-0fa4cb352a9d",
      periodFrom: "2026-07-01",
      periodTo: "2026-07-31",
      currency: "TND",
      deliveryFeesMinor: 7_500,
    });
    expect(settlement.deliveryFeesMinor).toBe(7_500n);
  });

  it("holds for the fleet schemas", () => {
    const shift = parsesTwice(startShiftSchema, {
      driverId: "019fb59d-15ca-7bea-bc06-07991643ae56",
      vehicleId: "019fb59d-1610-727f-a61f-0fa4cb352a9d",
      openingCashMinor: 50_000,
    });
    expect(shift.openingCashMinor).toBe(50_000n);
  });
});
