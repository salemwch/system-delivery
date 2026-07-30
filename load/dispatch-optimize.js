import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";

/**
 * Route optimisation under load.
 *
 * ADR-005 accepted running the sequencer in-process on one explicit condition
 * (docs/01 §4.3): *"a CPU spike in sequencing could briefly affect API latency.
 * Mitigated by capping synchronous optimization at 40 stops."* This measures
 * whether that mitigation actually holds, because if it does not, the whole
 * "no Go service at MVP" decision is built on an untested assumption.
 *
 * Nearest-neighbour construction plus 2-opt is **O(n²) per pass** on a single
 * thread. The question is not whether one optimisation is fast — it is whether
 * several concurrent ones make a dispatcher's board unusable while they run.
 *
 * ⚠️ The realistic figure is ~50 runs/day (docs/01 §4.3), so 5 concurrent
 * dispatchers is already well beyond a real courier. It is deliberately
 * pessimistic: this scenario exists to find the ceiling, not to confirm the floor.
 *
 * Run with `ROUTING_OPTIMIZER=osrm` too — an OSRM matrix call adds a network
 * round-trip inside the optimisation, which is a materially different profile.
 */

const fixture = JSON.parse(open("./fixture.json"));

const optimizeOk = new Rate("optimize_ok");
const optimizeMs = new Trend("optimize_ms", true);
const usedFallback = new Rate("used_fallback");

export const options = {
  scenarios: {
    // A FIXED amount of real work, not "whatever fits in 60 seconds". Each
    // iteration consumes 40 legs from a finite pool, so a duration-based run
    // spends most of its time spinning on an empty pool and reports failures
    // that are an artefact of the harness rather than the system.
    dispatchers: {
      executor: "shared-iterations",
      vus: 5,
      iterations: 50,
      maxDuration: "5m",
    },
  },
  thresholds: {
    // Deliberately looser than the 300 ms API budget: this is a deliberate,
    // interactive action a dispatcher waits on with a spinner, not a page load.
    // docs/01 §4.3 sizes it in milliseconds for ≤40 stops.
    optimize_ms: ["p(95)<2000", "p(99)<5000"],
    optimize_ok: ["rate>0.99"],
    // Every read on this board must stay responsive WHILE optimisations run.
    // This is the actual subject of the test — the ADR's accepted risk.
    "http_req_duration{name:GET /v1/routes}": ["p(99)<300"],
  },
};

const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${fixture.dispatcherToken}`,
};

export default function () {
  // Claimed BEFORE creating anything: a route with no legs to plan is not work,
  // and creating one anyway would report a failure the system did not cause.
  const legs = takeLegs();
  if (legs.length === 0) {
    return;
  }

  const created = http.post(
    `${fixture.baseUrl}/v1/routes`,
    JSON.stringify({ plannedDate: new Date().toISOString().slice(0, 10) }),
    { headers, tags: { name: "POST /v1/routes" } },
  );

  if (!check(created, { "route created": (r) => r.status === 201 || r.status === 200 })) {
    optimizeOk.add(false);
    return;
  }
  const routeId = created.json().id;

  // Added in ONE call, not 40: the subject is the sequencer, and 40 round-trips
  // of setup would dominate the measurement.
  const stops = http.post(
    `${fixture.baseUrl}/v1/routes/${routeId}/stops`,
    JSON.stringify({ legIds: legs }),
    { headers, tags: { name: "POST /v1/routes/:id/stops" } },
  );
  check(stops, { "stops added": (r) => r.status === 200 || r.status === 201 });

  const optimized = http.post(`${fixture.baseUrl}/v1/routes/${routeId}/optimize`, "{}", {
    headers,
    tags: { name: "POST /v1/routes/:id/optimize" },
  });

  const ok = optimized.status === 200;
  optimizeOk.add(ok);
  optimizeMs.add(optimized.timings.duration);

  if (ok) {
    const body = optimized.json();
    // `usedFallback` is the monitored signal for a degraded OSRM. Under load it
    // answers a second question: does the road-network path degrade only because
    // OSRM is saturated by the very concurrency being tested?
    if (typeof body.usedFallback === "boolean") {
      usedFallback.add(body.usedFallback);
    }
  }

  // The board read, issued while other VUs are mid-optimisation. If the
  // single-threaded sequencer starves the event loop, THIS is what shows it.
  const board = http.get(`${fixture.baseUrl}/v1/routes?limit=20`, {
    headers,
    tags: { name: "GET /v1/routes" },
  });
  check(board, { "board readable during optimisation": (r) => r.status === 200 });
}

/** Stops per route — the cap docs/01 §4.3 says synchronous optimisation holds to. */
const STOPS_PER_ROUTE = 40;

/** Must match `scenarios.dispatchers.vus` — k6 exposes no VU count at runtime. */
const DISPATCHER_VUS = 5;

/**
 * Claims the next unclaimed slice of the leg pool for this VU.
 *
 * Partitioned by VU rather than shared, because k6 VUs do not share memory: each
 * gets its own contiguous block, so two VUs cannot claim the same leg no matter
 * how the iterations interleave.
 */
function takeLegs() {
  const perVu = Math.floor(fixture.legIds.length / DISPATCHER_VUS);
  const base = (__VU - 1) * perVu;
  const offset = __ITER * STOPS_PER_ROUTE;
  if (offset + STOPS_PER_ROUTE > perVu) {
    return [];
  }
  return fixture.legIds.slice(base + offset, base + offset + STOPS_PER_ROUTE);
}
