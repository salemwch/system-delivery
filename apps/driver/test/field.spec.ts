import { describe, expect, it } from "vitest";

import { ApiError } from "../src/core/api";
import { MESSAGES, MESSAGE_KEYS, fill } from "../src/core/i18n";
import { mapsUrl, telUrl, wazeUrl, whatsappUrl } from "../src/core/links";
import {
  canComplete,
  cashCollected,
  collectedParcels,
  currentRoute,
  dayProgress,
  dayStops,
  findParcel,
  findShipment,
  manifestSchema,
  nextStop,
} from "../src/core/manifest";
import type { Manifest, Pending } from "../src/core/manifest";
import {
  GROUP_SEPARATOR,
  formatAmount,
  formatMoney,
  parseAmount,
  remaining,
  sumByCurrency,
} from "../src/core/money";
import { flushOutbox } from "../src/core/outbox";
import type { MediaSlot, OutboxPorts, ScanBatchResponse, SyncResponse } from "../src/core/outbox";
import { MemoryOutbox } from "./memory-outbox";

const tnd = (amountMinor: string) => ({ amountMinor, currency: "TND", currencyExponent: 3 });

// ── Money ───────────────────────────────────────────────────────────────────

describe("money", () => {
  it("formats TND with its three decimals in each language, by string arithmetic", () => {
    expect(formatMoney(tnd("12500"), "fr")).toBe("12,500 DT");
    expect(formatMoney(tnd("12500"), "en")).toBe("12.500 TND");
    expect(formatMoney(tnd("12500"), "ar")).toBe("12.500 د.ت");
    expect(formatAmount("5", 3, "en")).toBe("0.005");
    expect(formatAmount("0", 3, "en")).toBe("0.000");
    expect(formatAmount("-1500", 3, "en")).toBe("-1.500");
    expect(formatAmount("1234567890", 3, "en")).toBe(
      `1${GROUP_SEPARATOR}234${GROUP_SEPARATOR}567.890`,
    );
    expect(formatAmount("500", 0, "en")).toBe("500");
  });

  it("parses what a driver types, refusing more decimals than the currency has", () => {
    expect(parseAmount("12.5", 3)).toBe("12500");
    expect(parseAmount("12,500", 3)).toBe("12500");
    expect(parseAmount("12", 3)).toBe("12000");
    expect(parseAmount("0", 3)).toBe("0");
    expect(parseAmount(`1${GROUP_SEPARATOR}250,5`, 3)).toBe("1250500");
    // 4.005 * 1000 is 4004.999… in floating point; strings are exact.
    expect(parseAmount("4.005", 3)).toBe("4005");
    expect(parseAmount("12.5005", 3)).toBeNull();
    expect(parseAmount("abc", 3)).toBeNull();
    expect(parseAmount("", 3)).toBeNull();
    expect(parseAmount("-3", 3)).toBeNull();
  });

  it("sums per currency and never across, and what is left never goes below zero", () => {
    const sums = sumByCurrency([
      tnd("1000"),
      tnd("2500"),
      { amountMinor: "300", currency: "EUR", currencyExponent: 2 },
    ]);
    expect(sums).toEqual([
      { amountMinor: "300", currency: "EUR", currencyExponent: 2 },
      tnd("3500"),
    ]);
    expect(remaining([tnd("3500")], [tnd("1000")])).toEqual([tnd("2500")]);
    expect(remaining([tnd("3500")], [tnd("4000")])).toEqual([]);
    expect(remaining([tnd("3500")], [])).toEqual([tnd("3500")]);
  });
});

// ── The day's manifest ──────────────────────────────────────────────────────

const ROUTE = "018f7a00-0000-7000-8000-00000000a001";
const id = (n: number) => `018f7a00-0000-7000-8000-${String(n).padStart(12, "0")}`;

function manifest(status = "IN_PROGRESS"): Manifest {
  return manifestSchema.parse({
    routeId: ROUTE,
    code: "R-1",
    status,
    plannedDate: "2026-10-19",
    driverId: id(90),
    vehicleId: id(91),
    startHubId: id(92),
    summary: { stopsTotal: 3, stopsCompleted: 0, codExpected: [tnd("17500")] },
    stops: [
      {
        id: id(1),
        sequence: 1,
        type: "PICKUP",
        status: "PENDING",
        latitude: 36.8,
        longitude: 10.18,
        plannedArrivalAt: null,
        addressId: id(51),
        address: { line1: "Rue du Lac", city: "Tunis", accessNotes: null },
        shipments: [
          {
            shipmentId: id(10),
            trackingNumber: "TN-PICK",
            recipientName: "Shop",
            recipientPhone: "+21624000000",
            parcelCount: 1,
            status: "ASSIGNED",
            cod: tnd("0"),
          },
        ],
      },
      {
        id: id(2),
        sequence: 2,
        type: "DELIVERY",
        status: "PENDING",
        latitude: 36.81,
        longitude: 10.19,
        plannedArrivalAt: "2026-10-19T09:30:00.000Z",
        addressId: id(52),
        address: { line1: "Avenue Habib Bourguiba", city: "Tunis", accessNotes: "2nd floor" },
        shipments: [
          {
            shipmentId: id(11),
            trackingNumber: "TN-0001",
            recipientName: "Amel",
            recipientPhone: "+21624201314",
            parcelCount: 1,
            status: "OUT_FOR_DELIVERY",
            cod: tnd("12500"),
          },
          {
            shipmentId: id(12),
            trackingNumber: "TN-0002",
            recipientName: "Amel",
            recipientPhone: "+21624201314",
            parcelCount: 2,
            status: "OUT_FOR_DELIVERY",
            cod: tnd("0"),
          },
        ],
      },
      {
        id: id(3),
        sequence: 3,
        type: "DELIVERY",
        status: "PENDING",
        latitude: null,
        longitude: null,
        plannedArrivalAt: null,
        addressId: null,
        address: null,
        shipments: [
          {
            shipmentId: id(13),
            trackingNumber: "TN-0003",
            recipientName: "Karim",
            recipientPhone: "+21698000000",
            parcelCount: 1,
            status: "OUT_FOR_DELIVERY",
            cod: tnd("5000"),
          },
        ],
      },
    ],
  });
}

describe("manifest read models", () => {
  it("lays unsent outcomes over the server's truth, parcel by parcel", () => {
    const pending: Pending[] = [{ shipmentId: id(11), outcome: "DELIVERED" }];
    const stops = dayStops([manifest()], pending);
    const second = stops[1];
    expect(second?.parcels.map((p) => [p.state, p.unsent])).toEqual([
      ["DELIVERED", true],
      ["TODO", false],
    ]);
    // One parcel left at the stop: still open, and only its cash is still to collect.
    expect(second?.open).toBe(true);
    expect(second?.cod).toEqual([]);
  });

  it("finds the next stop, counts parcels (not stops) and skips pickups in the totals", () => {
    const m = manifest();
    expect(nextStop([m], [])?.stop.id).toBe(id(1));
    const pending: Pending[] = [
      { shipmentId: id(11), outcome: "DELIVERED" },
      { shipmentId: id(12), outcome: "FAILED" },
    ];
    expect(dayProgress([m], pending)).toEqual({ total: 3, done: 2, delivered: 1, failed: 1 });
  });

  it("counts the cash of delivered COD parcels only, once each", () => {
    const pending: Pending[] = [
      { shipmentId: id(11), outcome: "DELIVERED" },
      { shipmentId: id(13), outcome: "FAILED" },
    ];
    expect(cashCollected([manifest()], pending)).toEqual([tnd("12500")]);
    expect(collectedParcels([manifest()], pending).map((p) => p.shipment.trackingNumber)).toEqual([
      "TN-0001",
    ]);
  });

  it("lets a route be completed only when nothing is left open", () => {
    const m = manifest();
    expect(canComplete(m, [])).toBe(false);
    const allDone = manifestSchema.parse({
      ...m,
      stops: m.stops.map((s) => ({ ...s, status: s.type === "PICKUP" ? "COMPLETED" : s.status })),
    });
    const pending: Pending[] = [id(11), id(12), id(13)].map((shipmentId) => ({
      shipmentId,
      outcome: "DELIVERED",
    }));
    expect(canComplete(allDone, pending)).toBe(true);
    expect(canComplete(manifestSchema.parse({ ...allDone, status: "PUBLISHED" }), pending)).toBe(
      false,
    );
  });

  it("finds a scanned parcel whatever the case, and the running route first", () => {
    const m = manifest();
    expect(findParcel([m], " tn-0003 ")).toEqual({
      routeId: ROUTE,
      stopId: id(3),
      shipmentId: id(13),
    });
    expect(findParcel([m], "TN-9999")).toBeNull();
    expect(findShipment([m], id(12))?.trackingNumber).toBe("TN-0002");
    const later = manifestSchema.parse({ ...m, routeId: id(99), code: "R-0", status: "PUBLISHED" });
    expect(currentRoute([later, m])?.routeId).toBe(ROUTE);
  });
});

// ── Links ───────────────────────────────────────────────────────────────────

describe("links", () => {
  it("builds dialler, WhatsApp and navigation links", () => {
    expect(telUrl("+216 24 201 314")).toBe("tel:+21624201314");
    expect(whatsappUrl("+216 24 201 314")).toBe("https://wa.me/21624201314");
    expect(whatsappUrl("12")).toBeNull();
    expect(mapsUrl({ latitude: 36.8, longitude: 10.18, label: null })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=36.8,10.18&travelmode=driving",
    );
    expect(mapsUrl({ latitude: null, longitude: null, label: "Rue du Lac, Tunis" })).toContain(
      "destination=Rue%20du%20Lac%2C%20Tunis",
    );
    expect(wazeUrl({ latitude: 36.8, longitude: 10.18, label: null })).toBe(
      "https://waze.com/ul?ll=36.8,10.18&navigate=yes",
    );
    expect(mapsUrl({ latitude: null, longitude: null, label: " " })).toBeNull();
  });
});

describe("i18n dictionary", () => {
  it("has exactly the declared keys in every language, and fills placeholders", () => {
    for (const messages of Object.values(MESSAGES)) {
      expect(Object.keys(messages).sort()).toEqual([...MESSAGE_KEYS].sort());
    }
    expect(fill("{n} parcels for {who}", { n: 3, who: "Amel" })).toBe("3 parcels for Amel");
    expect(fill("{missing} stays", {})).toBe("{missing} stays");
  });
});

// ── The outbox flush ────────────────────────────────────────────────────────

type Call = readonly [string, ...unknown[]];

function fakePorts(overrides: Partial<OutboxPorts> = {}): { ports: OutboxPorts; calls: Call[] } {
  const calls: Call[] = [];
  const ok = (results: SyncResponse["results"] = []): SyncResponse => ({
    results,
    activeRoutes: [],
    routeUpdates: [],
    features: { POD_PHOTO_REQUIRED: false },
    serverTime: "2026-10-19T10:00:00.000Z",
  });
  const ports: OutboxPorts = {
    presign: (media): Promise<MediaSlot> => {
      calls.push(["presign", media.id]);
      return Promise.resolve({
        artifactId: `art-${media.id}`,
        objectKey: `pod/${media.id}.jpg`,
        uploadUrl: "https://store/put",
        requiredHeaders: { "content-type": media.contentType },
      });
    },
    upload: (media) => {
      calls.push(["upload", media.id]);
      return Promise.resolve();
    },
    completeMedia: (artifactId) => {
      calls.push(["complete", artifactId]);
      return Promise.resolve();
    },
    discardFile: (media) => {
      calls.push(["discard", media.id]);
      return Promise.resolve();
    },
    sync: (body) => {
      calls.push(["sync", body.pendingEvents]);
      return Promise.resolve(
        ok(
          body.pendingEvents.map((item) => ({
            idempotencyKey: (item as { idempotencyKey: string }).idempotencyKey,
            status: "ACCEPTED" as const,
            resultingStatus: "DELIVERED",
          })),
        ),
      );
    },
    scanBatch: (pickupId, scans): Promise<ScanBatchResponse> => {
      calls.push(["scanBatch", pickupId, scans]);
      return Promise.resolve({
        results: scans.map((_, index) => ({
          index,
          status: "ACCEPTED" as const,
          action: null,
          reason: null,
        })),
      });
    },
    collectPickup: (pickupId, body) => {
      calls.push(["collect", pickupId, body]);
      return Promise.resolve();
    },
    completePickup: (pickupId, body) => {
      calls.push(["completePickup", pickupId, body]);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { ports, calls };
}

const offline = () => Promise.reject(new ApiError(0, "NETWORK", "offline"));

describe("outbox flush", () => {
  it("slots the photo first, sends the delivery citing its key, then uploads and frees the file", async () => {
    const store = new MemoryOutbox();
    store.addMedia({
      id: "m1",
      shipmentId: id(11),
      purpose: "POD_PHOTO",
      uri: "file:///m1.jpg",
      contentType: "image/jpeg",
      sizeBytes: 200_000,
    });
    const delivery = store.add(
      "DELIVERED",
      id(11),
      {
        pod: { podType: "photo", recipientName: "Amel" },
        codCollected: true,
        occurredAt: "2026-10-19T09:31:00.000Z",
      },
      ["m1"],
    );
    const { ports, calls } = fakePorts();

    const report = await flushOutbox(store, ports);

    expect(calls.map((c) => c[0])).toEqual(["presign", "sync", "upload", "complete", "discard"]);
    const sent = calls[1]?.[1] as readonly Record<string, unknown>[];
    expect(sent[0]).toEqual({
      idempotencyKey: delivery.id,
      type: "DELIVERED",
      shipmentId: id(11),
      payload: {
        pod: { podType: "photo", recipientName: "Amel", photoObjectKeys: ["pod/m1.jpg"] },
        codCollected: true,
        occurredAt: "2026-10-19T09:31:00.000Z",
      },
    });
    expect(store.action(delivery.id).state).toBe("DONE");
    expect(store.media[0]?.state).toBe("UPLOADED");
    expect(report).toMatchObject({ sent: 1, offline: false, reachedServer: true });
  });

  it("keeps everything when offline, and sends nothing out of order", async () => {
    const store = new MemoryOutbox();
    store.addMedia({
      id: "m1",
      shipmentId: id(11),
      purpose: "POD_SIGNATURE",
      uri: "file:///m1.png",
      contentType: "image/png",
      sizeBytes: 9_000,
    });
    const delivery = store.add(
      "DELIVERED",
      id(11),
      { pod: { podType: "signature", recipientName: "A" }, occurredAt: "x" },
      ["m1"],
    );
    const { ports, calls } = fakePorts({ presign: offline });

    const report = await flushOutbox(store, ports);

    expect(report.offline).toBe(true);
    expect(calls.some((c) => c[0] === "sync")).toBe(false);
    expect(store.action(delivery.id).state).toBe("PENDING");
    expect(store.media[0]?.state).toBe("CAPTURED");
  });

  it("follows the server's verdict per item, and never drops a refused delivery", async () => {
    const store = new MemoryOutbox();
    const delivered = store.add("DELIVERED", id(11));
    const failed = store.add("FAILED", id(12));
    const retry = store.add("FAILED", id(13));
    const afterRetry = store.add("DELIVERED", id(13));
    const other = store.add("ADDRESS_CORRECTED", id(52));
    let round = 0;
    const { ports, calls } = fakePorts({
      sync: (body) => {
        round += 1;
        calls.push(["sync", body.pendingEvents]);
        const verdict = (key: string) =>
          key === delivered.id || key === failed.id
            ? {
                idempotencyKey: key,
                status: "REJECTED" as const,
                code: "SHIPMENT_INVALID_TRANSITION",
                detail: "no",
                action: "DISCARD_AND_REFRESH" as const,
              }
            : key === retry.id
              ? {
                  idempotencyKey: key,
                  status: "REJECTED" as const,
                  code: "LOCKED",
                  detail: "later",
                  action: "RETRY_LATER" as const,
                }
              : key === afterRetry.id
                ? {
                    idempotencyKey: key,
                    status: "REJECTED" as const,
                    code: "HELD_BEHIND_EARLIER_ITEM",
                    detail: "held",
                    action: "RETRY_LATER" as const,
                  }
                : { idempotencyKey: key, status: "ACCEPTED" as const, resultingStatus: "APPLIED" };
        return Promise.resolve({
          results: body.pendingEvents.map((item) =>
            verdict((item as { idempotencyKey: string }).idempotencyKey),
          ),
          activeRoutes: [],
          routeUpdates: [],
          features: {},
          serverTime: "now",
        });
      },
    });

    const report = await flushOutbox(store, ports);

    // A delivery happened in the street: refused or not, a person must see it.
    expect(store.action(delivered.id).state).toBe("ESCALATED");
    expect(store.action(failed.id).state).toBe("REFUSED");
    expect(store.action(retry.id)).toMatchObject({ state: "PENDING", attempts: 1, code: "LOCKED" });
    expect(store.action(afterRetry.id).state).toBe("PENDING");
    expect(store.action(other.id).state).toBe("DONE");
    // One batch: the waiting parcel holds back only its own later item.
    expect(round).toBe(1);
    expect(report).toMatchObject({ sent: 1, refused: 1, escalated: 1, offline: false });
  });

  it("batches pickup scans per pickup, then collects, in the order they happened", async () => {
    const store = new MemoryOutbox();
    const pickup = id(70);
    store.add("PICKUP_SCAN", pickup, { trackingNumber: "TN-1", scannedAt: "t1" });
    store.add("PICKUP_SCAN", pickup, { trackingNumber: "TN-2", scannedAt: "t2" });
    const collect = store.add("PICKUP_COLLECT", pickup, {});
    const { ports, calls } = fakePorts();

    await flushOutbox(store, ports);

    expect(calls.map((c) => c[0])).toEqual(["scanBatch", "collect", "sync"]);
    expect(calls[0]?.[2]).toEqual([
      { trackingNumber: "TN-1", scannedAt: "t1", idempotencyKey: "key-1" },
      { trackingNumber: "TN-2", scannedAt: "t2", idempotencyKey: "key-2" },
    ]);
    expect(calls[1]).toEqual(["collect", pickup, { idempotencyKey: collect.id }]);
    expect(store.actions.every((a) => a.state === "DONE")).toBe(true);
  });

  it("holds a collection behind a scan the server asked to retry", async () => {
    const store = new MemoryOutbox();
    const pickup = id(70);
    const scan = store.add("PICKUP_SCAN", pickup, { trackingNumber: "TN-1", scannedAt: "t1" });
    const collect = store.add("PICKUP_COLLECT", pickup, {});
    const { ports, calls } = fakePorts({
      scanBatch: () =>
        Promise.resolve({
          results: [
            {
              index: 0,
              status: "REJECTED" as const,
              action: "RETRY_LATER" as const,
              reason: "busy",
            },
          ],
        }),
    });

    await flushOutbox(store, ports);

    expect(calls.some((c) => c[0] === "collect")).toBe(false);
    expect(store.action(scan.id)).toMatchObject({ state: "PENDING", attempts: 1 });
    expect(store.action(collect.id).state).toBe("PENDING");
  });

  it("keeps a batch the server could not read, counts the attempt and stops", async () => {
    const store = new MemoryOutbox();
    const delivery = store.add("DELIVERED", id(11));
    const { ports } = fakePorts({
      sync: () => Promise.reject(new ApiError(400, "VALIDATION_FAILED", "bad envelope")),
    });

    const report = await flushOutbox(store, ports);

    expect(store.action(delivery.id)).toMatchObject({
      state: "PENDING",
      attempts: 1,
      code: "VALIDATION_FAILED",
    });
    expect(report.offline).toBe(false);
  });

  it("refreshes the day when there is nothing to send, and treats a lost session as later", async () => {
    const store = new MemoryOutbox();
    const m = manifest();
    const { ports, calls } = fakePorts({
      sync: (body) => {
        calls.push(["sync", body.knownRouteVersions]);
        return Promise.resolve({
          results: [],
          activeRoutes: [{ routeId: ROUTE, status: "IN_PROGRESS", version: "v2" }],
          routeUpdates: [{ routeId: ROUTE, version: "v2", manifest: m }],
          features: { POD_PHOTO_REQUIRED: true },
          serverTime: "now",
        });
      },
    });
    const report = await flushOutbox(store, ports);
    expect(calls).toEqual([["sync", {}]]);
    expect(store.routes.get(ROUTE)).toMatchObject({ version: "v2", active: true });
    expect(report.features).toEqual({ POD_PHOTO_REQUIRED: true });

    store.add("FAILED", id(12));
    const unauthenticated = fakePorts({
      sync: () => Promise.reject(new ApiError(401, "UNAUTHENTICATED", "expired")),
    });
    expect((await flushOutbox(store, unauthenticated.ports)).offline).toBe(true);
    expect(store.actions[0]?.state).toBe("PENDING");
  });
});
