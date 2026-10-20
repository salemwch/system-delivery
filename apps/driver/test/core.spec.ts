import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ApiClient, ApiError } from "../src/core/api";
import type { Session, SessionStore } from "../src/core/api";
import { telemetryUploader } from "../src/core/endpoints";
import { MESSAGES, isRtl, pickLocale, toE164 } from "../src/core/i18n";
import { uuidV7 } from "../src/core/ids";
import { MotionClassifier, profileFor, sameRequest } from "../src/core/sampling";
import { FLUSH_AT_DEPTH, backoffMs, flush, shouldFlush } from "../src/core/telemetry";
import type { UploadOutcome, WirePosition } from "../src/core/telemetry";
import { MemoryTelemetryStore } from "./memory-store";

const random = (n: number) => new Uint8Array(randomBytes(n));
const point = (t: number): WirePosition => ({
  t: new Date(t).toISOString(),
  lat: 36.8,
  lon: 10.18,
});

describe("uuidV7", () => {
  it("is a valid version-7 UUID whose leading bits are the timestamp", () => {
    const id = uuidV7(random, 1_760_000_000_000);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(Number.parseInt(id.replace(/-/gu, "").slice(0, 12), 16)).toBe(1_760_000_000_000);
  });

  it("sorts by creation time", () => {
    const ids = [3, 1, 2].map((s) => uuidV7(random, 1_760_000_000_000 + s * 1000));
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]]);
  });
});

describe("sampling", () => {
  it("relaxes sampling on a low battery that is not charging, never the upload cadence", () => {
    const normal = profileFor("MOVING", { percent: 80, charging: false });
    const low = profileFor("MOVING", { percent: 15, charging: false });
    expect(low).toMatchObject({ lowBattery: true, accuracy: "BALANCED" });
    expect(low.timeIntervalMs).toBe(normal.timeIntervalMs * 2);
    expect(low.flushAfterMs).toBe(normal.flushAfterMs);
    expect(profileFor("MOVING", { percent: 15, charging: true }).lowBattery).toBe(false);
    expect(profileFor("MOVING", { percent: null, charging: false }).lowBattery).toBe(false);
  });

  it("speeds up at once and slows down only after two minutes still", () => {
    const motion = new MotionClassifier("STATIONARY");
    expect(motion.observe([{ t: 0, lat: 36.8, lon: 10.18, spd: 12 }])).toBe("MOVING");
    // A red light: 60 s still is not parked.
    expect(
      motion.observe([
        { t: 10_000, lat: 36.8, lon: 10.18, spd: 0 },
        { t: 70_000, lat: 36.8, lon: 10.18, spd: 0.1 },
      ]),
    ).toBe("MOVING");
    expect(motion.observe([{ t: 131_000, lat: 36.8, lon: 10.18, spd: 0 }])).toBe("STATIONARY");
    expect(motion.observe([{ t: 140_000, lat: 36.8, lon: 10.18, spd: 1.5 }])).toBe("SLOW");
  });

  it("derives speed from positions when the platform reports none, and ignores fixes out of order", () => {
    const motion = new MotionClassifier("STATIONARY");
    // ~111 m in 10 s ≈ 11 m/s.
    expect(
      motion.observe([
        { t: 0, lat: 36.8, lon: 10.18 },
        { t: 10_000, lat: 36.801, lon: 10.18 },
      ]),
    ).toBe("MOVING");
    expect(motion.observe([{ t: 5_000, lat: 40, lon: 12, spd: 0 }])).toBe("MOVING");
  });

  it("restarts the platform request only when it would change", () => {
    const a = profileFor("MOVING", { percent: 80, charging: false });
    expect(sameRequest(a, profileFor("MOVING", { percent: 60, charging: true }))).toBe(true);
    expect(sameRequest(a, profileFor("STATIONARY", { percent: 80, charging: false }))).toBe(false);
  });
});

describe("telemetry pipeline", () => {
  const ids = () => {
    let n = 0;
    return () => `00000000-0000-7000-8000-${String((n += 1)).padStart(12, "0")}`;
  };

  it("flushes when full or old enough, never when empty", () => {
    expect(shouldFlush(0, null, 30_000, 0)).toBe(false);
    expect(shouldFlush(FLUSH_AT_DEPTH, 0, 30_000, 1)).toBe(true);
    expect(shouldFlush(3, 0, 30_000, 29_999)).toBe(false);
    expect(shouldFlush(3, 0, 30_000, 30_000)).toBe(true);
  });

  it("sends oldest first, one shift per batch, and empties the queue", async () => {
    const store = new MemoryTelemetryStore();
    await store.append("shift-a", [point(1), point(2)]);
    await store.append("shift-b", [point(3)]);
    const sent: string[] = [];
    const report = await flush({
      store,
      upload: (batch) => {
        sent.push(`${batch.shiftId}:${String(batch.positions.length)}`);
        return Promise.resolve({ kind: "ACCEPTED", accepted: batch.positions.length, rejected: 0 });
      },
      newId: ids(),
      random: Math.random,
      attempt: 0,
    });
    expect(sent).toEqual(["shift-a:2", "shift-b:1"]);
    expect(report).toMatchObject({ sentBatches: 2, sentPoints: 3, retryInMs: null });
    expect(await store.depth()).toBe(0);
  });

  it("re-sends the SAME batch id after a lost response, so the server de-duplicates", async () => {
    const store = new MemoryTelemetryStore();
    await store.append("shift-a", [point(1), point(2)]);
    const seen: string[] = [];
    let fail = true;
    const upload = (batch: { batchId: string }): Promise<UploadOutcome> => {
      seen.push(batch.batchId);
      if (fail) {
        fail = false;
        return Promise.resolve({ kind: "TRANSIENT", reason: "TIMEOUT" });
      }
      return Promise.resolve({ kind: "ACCEPTED", accepted: 2, rejected: 0 });
    };
    const newId = ids();
    const first = await flush({ store, upload, newId, random: () => 0.5, attempt: 0 });
    expect(first.retryInMs).toBe(2_500);
    // New points arrive while offline: they must not join the sealed batch.
    await store.append("shift-a", [point(3)]);
    await flush({ store, upload, newId, random: () => 0.5, attempt: 1 });
    expect(seen[0]).toBe(seen[1]);
    expect(seen).toHaveLength(3);
    expect(await store.depth()).toBe(0);
  });

  it("drops what the server can never take, and stops on a closed shift", async () => {
    const store = new MemoryTelemetryStore();
    await store.append("shift-a", [point(1)]);
    await store.append("shift-b", [point(2)]);
    const outcomes: UploadOutcome[] = [{ kind: "INVALID", status: 400 }, { kind: "OUTSIDE_SHIFT" }];
    const report = await flush({
      store,
      upload: () => Promise.resolve(outcomes.shift() ?? { kind: "TRANSIENT", reason: "x" }),
      newId: ids(),
      random: Math.random,
      attempt: 0,
    });
    expect(report).toMatchObject({ droppedBatches: 2, shiftClosed: true });
    expect(await store.depth()).toBe(0);
  });

  it("keeps the data and asks for sign-in when the session is gone", async () => {
    const store = new MemoryTelemetryStore();
    await store.append("shift-a", [point(1)]);
    const report = await flush({
      store,
      upload: () => Promise.resolve({ kind: "UNAUTHENTICATED" }),
      newId: ids(),
      random: Math.random,
      attempt: 0,
    });
    expect(report.needsSignIn).toBe(true);
    expect(await store.depth()).toBe(1);
  });

  it("backs off exponentially with jitter, capped at five minutes", () => {
    expect(backoffMs(0, () => 0.999)).toBeLessThan(5_000);
    expect(backoffMs(3, () => 0.999)).toBeLessThan(40_000);
    expect(backoffMs(30, () => 0.999)).toBeLessThan(300_000);
    expect(backoffMs(2, () => 0)).toBe(0);
  });
});

describe("ApiClient", () => {
  class Store implements SessionStore {
    constructor(public session: Session | null) {}
    load() {
      return Promise.resolve(this.session);
    }
    save(session: Session) {
      this.session = session;
      return Promise.resolve();
    }
    clear() {
      this.session = null;
      return Promise.resolve();
    }
  }
  const session = (overrides: Partial<Session> = {}): Session => ({
    tenantId: "018f7a00-0000-7000-8000-000000000001",
    userId: "018f7a00-0000-7000-8000-0000000000aa",
    accessToken: "old",
    refreshToken: "r1",
    expiresAt: Date.now() + 600_000,
    ...overrides,
  });
  const issued = (access: string, refresh: string) =>
    new Response(
      JSON.stringify({
        status: "AUTHENTICATED",
        accessToken: access,
        refreshToken: refresh,
        expiresIn: 900,
        user: {
          id: "018f7a00-0000-7000-8000-0000000000aa",
          tenantId: "018f7a00-0000-7000-8000-000000000001",
          roles: ["DRIVER"],
        },
      }),
      { status: 200 },
    );

  it("refreshes once for any number of concurrent 401s, then retries each call", async () => {
    let refreshes = 0;
    const fetcher = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (path.endsWith("/v1/auth/refresh")) {
        refreshes += 1;
        return new Promise((resolve) => setTimeout(() => resolve(issued("new", "r2")), 10));
      }
      const auth = new Headers(init?.headers).get("authorization");
      return Promise.resolve(
        auth === "Bearer new"
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), { status: 401 }),
      );
    };
    const store = new Store(session());
    const api = new ApiClient({
      baseUrl: "https://api",
      sessions: store,
      fetch: fetcher,
      deviceId: "d",
    });
    const schema = z.object({ ok: z.literal(true) });

    const results = await Promise.all([1, 2, 3].map(() => api.request("GET", "/x", schema)));
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshes).toBe(1);
    expect(store.session?.refreshToken).toBe("r2");
  });

  it("clears the session when the refresh is refused", async () => {
    const fetcher = (): Promise<Response> =>
      Promise.resolve(new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), { status: 401 }));
    const store = new Store(session({ expiresAt: Date.now() - 1 }));
    const api = new ApiClient({
      baseUrl: "https://api",
      sessions: store,
      fetch: fetcher,
      deviceId: "d",
    });
    await expect(api.request("GET", "/x", z.unknown())).rejects.toMatchObject({ status: 401 });
    expect(store.session).toBeNull();
  });

  it("maps problems, timeouts and contract drift to typed errors", async () => {
    const store = new Store(session());
    const answer = (response: Response | Error) =>
      new ApiClient({
        baseUrl: "https://api",
        sessions: store,
        fetch: () =>
          response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
        deviceId: "d",
      });
    await expect(
      answer(
        new Response(JSON.stringify({ code: "TELEMETRY_OUTSIDE_SHIFT" }), { status: 422 }),
      ).request("GET", "/x", z.unknown()),
    ).rejects.toMatchObject({ status: 422, code: "TELEMETRY_OUTSIDE_SHIFT", transient: false });
    await expect(
      answer(new TypeError("Network request failed")).request("GET", "/x", z.unknown()),
    ).rejects.toMatchObject({
      status: 0,
      code: "NETWORK",
      transient: true,
    });
    await expect(
      answer(new Response(JSON.stringify({ unexpected: 1 }), { status: 200 })).request(
        "GET",
        "/x",
        z.object({ ok: z.boolean() }),
      ),
    ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    const limited = new Response(JSON.stringify({ code: "RATE_LIMITED" }), {
      status: 429,
      headers: { "retry-after": "30" },
    });
    await expect(answer(limited).request("GET", "/x", z.unknown())).rejects.toMatchObject({
      transient: true,
      retryAfterMs: 30_000,
    });
  });

  it("classifies telemetry answers for the pipeline", async () => {
    const outcome = (response: Response | Error) =>
      telemetryUploader(
        new ApiClient({
          baseUrl: "https://api",
          sessions: new Store(session()),
          fetch: () =>
            response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
          deviceId: "d",
        }),
      )({ batchId: "b", shiftId: "s", positions: [point(1)] });
    expect(
      await outcome(new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: 202 })),
    ).toEqual({
      kind: "ACCEPTED",
      accepted: 1,
      rejected: 0,
    });
    expect(
      await outcome(
        new Response(JSON.stringify({ code: "TELEMETRY_OUTSIDE_SHIFT" }), { status: 422 }),
      ),
    ).toEqual({ kind: "OUTSIDE_SHIFT" });
    expect(
      await outcome(new Response(JSON.stringify({ code: "VALIDATION_FAILED" }), { status: 400 })),
    ).toEqual({
      kind: "INVALID",
      status: 400,
    });
    expect(await outcome(new Response("", { status: 503 }))).toMatchObject({ kind: "TRANSIENT" });
    expect(await outcome(new TypeError("offline"))).toMatchObject({
      kind: "TRANSIENT",
      reason: "NETWORK",
    });
    expect(ApiError).toBeTypeOf("function");
  });
});

describe("i18n", () => {
  it("has every string in every language, non-empty", () => {
    const keys = Object.keys(MESSAGES.fr).sort();
    for (const locale of ["ar", "en"] as const) {
      expect(Object.keys(MESSAGES[locale]).sort()).toEqual(keys);
    }
    for (const messages of Object.values(MESSAGES)) {
      for (const value of Object.values(messages)) {
        expect(typeof value === "string" && value.trim().length > 0).toBe(true);
      }
    }
  });

  it("picks the device language, French by default, Arabic right-to-left", () => {
    expect(pickLocale(["ar-TN", "fr-FR"])).toBe("ar");
    expect(pickLocale(["de-DE", "en-GB"])).toBe("en");
    expect(pickLocale(["de-DE"])).toBe("fr");
    expect(isRtl("ar")).toBe(true);
    expect(isRtl("fr")).toBe(false);
  });

  it("normalises phone numbers exactly as the web app does", () => {
    expect(toE164("24201314")).toBe("+21624201314");
    expect(toE164("24 201 314")).toBe("+21624201314");
    expect(toE164("+216 24 201 314")).toBe("+21624201314");
    expect(toE164("0021624201314")).toBe("+21624201314");
    expect(toE164("24 201 314")).toBe("+21624201314");
    expect(toE164("2420131")).toBeNull();
    expect(toE164("")).toBeNull();
  });
});
