# Load testing

Three k6 scenarios against the paths that carry the architecture's load-bearing
claims. Written because those claims — "10k/sec", "capping optimisation at 40
stops", "one frame per second per client" — were design decisions that had never
been measured.

## Running

```bash
pnpm --filter @delivery/api load:fixture   # seeds a tenant, 200 drivers, 2000 legs
pnpm dev                                   # or: node apps/api/dist/main.js
pnpm load:telemetry                        # ingest
pnpm load:dispatch                         # route optimisation
pnpm load:realtime                         # WebSocket fan-out (run with load:telemetry)
pnpm --filter @delivery/api load:cleanup   # ⚠️ always
```

⚠️ **Always clean up.** A run seeds 200 drivers and writes hundreds of thousands
of `driver_positions` rows into the **dev database** — the same one the test
suite uses. Leaving them makes the next `pnpm test` report timings that mean
nothing, and its outbox rows break the relay tests outright.

⚠️ **The dispatcher token lives 10 minutes** (`JWT_ACCESS_TTL_SECONDS`); driver
tokens live an hour. Re-seed before a dispatch or realtime run, or the whole run
401s.

## Results

Measured 2026-07-30 on the development laptop, with PostgreSQL, Valkey, MinIO and
Nominatim all co-resident. **These are not production numbers** — the point is
the shape of the curve and whether the design holds, not the absolute figures.
Re-run on the staging droplets before trusting them for capacity planning.

### Telemetry ingest — `POST /v1/telemetry`

| Stage                          | Rate                 | p90     | p95         | Accepted    |
| ------------------------------ | -------------------- | ------- | ----------- | ----------- |
| MVP (200 drivers, 1 batch/5 s) | 40 req/s             | 22.1 ms | **24.7 ms** | 2400/2400   |
| Headroom (ramp to 400 req/s)   | ~112 req/s sustained | 3.61 s  | 3.92 s      | 24950/24950 |

- **The MVP target passes with ~12× margin**: 24.7 ms p95 against the 300 ms p99
  budget in docs/09 §7. Zero rejected positions, zero failed batches.
- Each request does real work — JWT verification, the shift privacy gate (a
  database query), validation of 10 positions, and the buffered enqueue.
- The ceiling on this box is ~112 req/s ≈ **1,125 positions/sec**, about 28× the
  MVP requirement. Past that, latency climbs to seconds and k6 sheds iterations;
  nothing errors, which is the batched writer behaving as designed.
- 10k positions/sec (Tier 3) is **not** demonstrated here and should not be
  assumed. ADR-005 extracts this endpoint to Go before that tier.

### Route optimisation — `POST /v1/routes/:id/optimize`

50 routes × 40 stops, 5 concurrent dispatchers, haversine sequencer.

| Metric                                   | avg    | p95         | max     |
| ---------------------------------------- | ------ | ----------- | ------- |
| Optimisation                             | 118 ms | 149 ms      | 156 ms  |
| `GET /v1/routes` **during** optimisation | 9.0 ms | **12.0 ms** | 16.1 ms |

- **ADR-005's accepted risk does not materialise at 40 stops.** The board stayed
  at 12 ms p95 while five optimisations ran concurrently, so the single-threaded
  O(n²) sequencer is not starving the event loop. The cap is doing its job.
- Realistic load is ~50 optimisations per **day** (docs/01 §4.3). Five
  concurrent is already far beyond a real courier.
- Not yet measured with `ROUTING_OPTIMIZER=osrm`, which adds a network
  round-trip inside each optimisation and is a materially different profile.

### Realtime fan-out — `wss /v1/realtime`

20 dispatcher boards, 30-second sessions, with the telemetry scenario producing
positions concurrently.

| Metric                       | Result                       |
| ---------------------------- | ---------------------------- |
| Frames per second per client | **0.99997** (median and p95) |
| Handshake success            | 100% (20/20)                 |
| Subscription confirmed       | 95% (19/20) — see below      |

- **Coalescing works exactly as specified.** docs/05 §10 requires one `positions`
  frame per second per client regardless of fleet size; the measurement is 1.000
  per second with 200 drivers moving. Done naively this would be 200/sec/client.

## Open finding

**1 subscription in 20 never confirmed.** The socket opened (handshake 101) but
no `subscribed` frame came back, and that client received zero position frames
for its whole session — a dispatcher whose board silently stays empty.

Not yet diagnosed. It became visible only after the `subscribe_ok` metric was
changed to record a result per session: as first written it called `.add(true)`
on confirmation and nothing otherwise, so a session that never subscribed
vanished from the metric instead of failing it. **Silence read as success.**

Worth resolving before the dispatcher board is built on this channel.
