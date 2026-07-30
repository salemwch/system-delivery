import http from "k6/http";
import { check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

/**
 * Telemetry ingest under load — the highest-volume path in the system.
 *
 * `docs/01-mvp-scope.md` §4.3 sizes MVP at **~40 events/sec across 200 drivers**
 * and calls Tier 3 **10,000 positions/sec**. `docs/06-database-design.md` §5.1
 * states the batched-write decision is "the difference between 10k/sec working
 * and not". Neither number had ever been measured.
 *
 * Two stages, and the second is the point:
 *
 *  1. **MVP** — 200 drivers reporting every 5 s, the real fleet shape. This must
 *     be comfortable, not merely survivable.
 *  2. **HEADROOM** — the same fleet at 10× the reporting rate. This is where the
 *     batched writer either holds or does not, and finding out here costs an
 *     afternoon rather than a production incident.
 *
 * ⚠️ Ingest returns **202 Accepted** by design: positions are buffered, not yet
 * durable. So request latency measures the ACCEPT path — auth, the shift privacy
 * gate, validation, and enqueue — and deliberately not the flush. That is the
 * honest thing to measure, because it is what a driver's phone waits for.
 *
 * Run:
 *   pnpm --filter @delivery/api load:fixture
 *   pnpm load:telemetry
 *   pnpm --filter @delivery/api load:cleanup
 */

const fixture = JSON.parse(open("./fixture.json"));

/** Positions per batch. The driver app buffers ~10 s of 1 Hz fixes offline. */
const POSITIONS_PER_BATCH = 10;

const rejected = new Counter("positions_rejected");
const accepted = new Counter("positions_accepted");
const batchAccepted = new Rate("batch_accepted");
const acceptLatency = new Trend("accept_latency_ms", true);

export const options = {
  scenarios: {
    // Stage 1 — the MVP fleet: 200 drivers, one batch each per 5 s ≈ 40 req/s.
    mvp: {
      executor: "constant-arrival-rate",
      rate: 40,
      timeUnit: "1s",
      duration: "60s",
      preAllocatedVUs: 40,
      maxVUs: 200,
      tags: { stage: "mvp" },
    },
    // Stage 2 — 10× headroom, started after stage 1 finishes so the two are
    // measured separately rather than one polluting the other's percentiles.
    headroom: {
      executor: "ramping-arrival-rate",
      startTime: "70s",
      startRate: 50,
      timeUnit: "1s",
      preAllocatedVUs: 100,
      maxVUs: 600,
      stages: [
        { target: 100, duration: "30s" },
        { target: 400, duration: "60s" },
        { target: 400, duration: "60s" },
      ],
      tags: { stage: "headroom" },
    },
  },
  thresholds: {
    // docs/09 §7: core-api p99 < 300 ms. Asserted on the MVP stage only —
    // headroom is an exploration, and failing the run for degradation at 10×
    // load would make the interesting stage unrunnable.
    "http_req_duration{stage:mvp}": ["p(99)<300"],
    // A dropped batch is a hole in a driver's trail. At MVP rates there is no
    // acceptable rate of them.
    "batch_accepted{stage:mvp}": ["rate>0.999"],
    // Positions rejected by the accuracy or clock-skew gates. The generator
    // produces clean fixes, so anything here is a bug, not noise.
    positions_rejected: ["count<1"],
  },
};

/** A plausible Tunis-area track: small deltas, as a moving vehicle produces. */
function positionsFor(vu, iteration) {
  const now = Date.now();
  const out = [];
  for (let i = 0; i < POSITIONS_PER_BATCH; i += 1) {
    const drift = (iteration * POSITIONS_PER_BATCH + i) * 0.00002;
    out.push({
      // Descending seconds so the batch reads oldest-first, as the app sends it.
      t: new Date(now - (POSITIONS_PER_BATCH - i) * 1000).toISOString(),
      lat: 36.8065 + ((vu % 50) - 25) / 500 + drift,
      lon: 10.1815 + ((vu % 37) - 18) / 500 + drift,
      // Well inside TELEMETRY_MAX_ACCURACY_M (200): a rejected fix would be
      // measuring the rejection path, not ingest.
      acc: 8,
      spd: 8.3,
      hdg: (vu * 7) % 360,
      bat: 80,
      mov: true,
    });
  }
  return out;
}

export default function () {
  // Each VU acts as one driver, wrapping around the fleet. Spreading load across
  // 200 distinct drivers matters: the shift gate and the presence key are both
  // per-driver, so a single-driver test would measure a warm path that does not
  // exist in production.
  const driver = fixture.drivers[(__VU - 1) % fixture.drivers.length];

  const response = http.post(
    `${fixture.baseUrl}/v1/telemetry`,
    JSON.stringify({
      shiftId: driver.shiftId,
      // A fresh id per batch. Reusing one would exercise the idempotent-replay
      // path — which is correct behaviour and the opposite of a write test.
      batchId: uuid(),
      positions: positionsFor(__VU, __ITER),
    }),
    {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${driver.token}`,
      },
      tags: { name: "POST /v1/telemetry" },
    },
  );

  const ok = response.status === 202;
  batchAccepted.add(ok);
  acceptLatency.add(response.timings.duration);

  check(response, {
    "202 accepted": (r) => r.status === 202,
  });

  if (ok) {
    const body = response.json();
    accepted.add(body.accepted);
    rejected.add(body.rejected);
  }
}

/** UUIDv4. k6 has no crypto.randomUUID, and the API requires a real UUID. */
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
