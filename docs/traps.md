# Traps Already Hit — Do Not Repeat

Reference for implementation pitfalls discovered during the build. Read the section relevant to the module you're modifying.

---

## Core / Shared

- **ALS + RxJS:** `TenantContext.run(state, () => next.handle())` is silently broken. The handler runs on _subscribe_, after `run()` returns. Wrap the **subscription**, not the Observable. Test exists.
- **`SET LOCAL x = $1` is invalid SQL.** Use `set_config('app.current_tenant_id', $1, true)` — the `true` is transaction-local, which PgBouncer transaction pooling requires.
- **`FORCE` RLS applies to the table owner**, so a table with only a SELECT policy becomes uninsertable by everyone.
- **Direct migrator reads of tenant-scoped tables return 0 rows** without tenant context. Use `withTenantContext()` in tests.
- **`exactOptionalPropertyTypes`:** never assign `undefined` to an optional prop — spread conditionally.
- **Never re-export a `@Module` from a `shared/` barrel that also exports a service/token.** `AppConfigModule`'s decorator runs `NestConfigModule.forRoot({ validate })` at evaluation time, which validates the env synchronously. When the barrel re-exported it, importing `DatabaseService`/`AppConfigService`/`VALKEY_CLIENT` dragged that in and threw under test (no real env) — silently exiting CI 1 on an unhandled rejection. Barrels export services/tokens; composition roots import the `Module` from its file directly. Validation fires at bootstrap only.

## Database / Drizzle / PostGIS

- **Drizzle wraps the driver error.** A unique-violation's SQLSTATE `code` (`23505`) and `constraint_name` live on the postgres.js `PostgresError` exposed as `error.cause`, NOT on the top-level Drizzle error. `isUniqueViolation` (shared/database) walks the `.cause` chain — do not read `.code` off the caught error directly.
- **PostGIS `location` is opaque to Drizzle.** postgres.js returns `geography` as hex WKB. Write it with `ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography` in a `sql` expression and read it back as scalars via `ST_Y(location::geometry)` / `ST_X(...)` — never select the raw column. `numeric` also arrives as a string; convert at the boundary.
- **`dp_app` already has full DML via default privileges.** `initdb/02-roles.sql` runs `ALTER DEFAULT PRIVILEGES FOR ROLE dp_migrator … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dp_app`, so every migrator-created table grants `dp_app` all four by default. Append-only / no-delete is therefore enforced with **`REVOKE`**, never a narrower `GRANT` (which is a silent no-op).
- **Don't bind a `Date` inside a raw `sql` fragment** (`sql\`${col} <= ${date}\``): postgres.js mis-serialises it. Use Drizzle's column-aware comparators (`lte`/`gte`/`isNull`/`or`) and `exists(tx.select()...)` for correlated subqueries.
- **Binding a JS array to `= ANY($1::uuid[])` fails** with `malformed array literal`. Use Drizzle's **`inArray(col, ids)`** (→ `col IN (...)`). Building an array in SQL from a scalar (`ARRAY[${id}]::uuid[]`) is fine; the trap is only passing the JS array itself as one bind param.
- **Zone boundaries are GeoJSON in, GeoJSON out.** Write with `ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON(…)), 4326)::geography`; read with `ST_AsGeoJSON(boundary)::json`. Containment: `ST_Covers` ordered by `ST_Area ASC`; nearest-hub: `<->` KNN.
- **`ON CONFLICT` cannot use a PARTIAL unique index as its arbiter** without repeating the predicate. Use plain unique constraints when they work.
- **`route_stops.(route_id, sequence)` unique is `DEFERRABLE INITIALLY DEFERRED`.** Re-optimisation rewrites every stop's sequence in one tx; a non-deferred unique would trip on intermediate state.

## Outbox / Relay / Valkey

- **The outbox relay is cross-tenant by nature.** The `outbox` is FORCE-RLS, so even `dp_migrator` sees zero rows without tenant context. Hence `dp_relay` with a table-scoped permissive policy, not BYPASSRLS.
- **`dp_relay` is created in `initdb/02-roles.sql`**, which only runs on a fresh container. An existing local DB needs the role added manually (or `pnpm dev:infra:reset`); migration `0004` then grants it `outbox` access.
- **A blocking `XREADGROUP` needs its OWN Valkey connection with NO tight `commandTimeout`.** Each `EventStreamConsumer` gets a dedicated `new Redis(url, { maxRetriesPerRequest: null })` — blocking-safe, no commandTimeout. Two consumer groups now run (`notification`, `ledger`), each on its own connection.
- **A Valkey consumer group created with `XGROUP CREATE … $` starts at the stream TAIL.** In tests you MUST `ensureGroup()` BEFORE the event is XADDed, or the group's read position is already past it.
- **Consumer retry/DLQ needs XPENDING, not XAUTOCLAIM, for the delivery count.** `XPENDING … IDLE <ms> - + <n>` returns `[id, consumer, idle, deliveries]`. The consumer sweeps XPENDING, XCLAIMs to retry, and dead-letters those at max deliveries.
- **The event stream consumer runs as `dp_app` and sets tenant context PER EVENT** from the envelope's `tenantId`. The worker carries BOTH a `dp_relay` pool (relay) and a `dp_app` pool (consumer).

## Shipment / Dispatch

- **`no-direct-shipment-status-write` only matches a LITERAL `status:` key.** A conditional-spread write (`...(cond ? {} : { status })`) silently evades it. The sanctioned writer `ShipmentEventService.applyTo` writes `status: newStatus` as a direct literal key.
- **The custody `sequence` is generated under a `FOR UPDATE` lock on the shipment row**, via `shipments.last_sequence`. Multi-event commands derive distinct idempotency keys (`${key}`, `${key}#delivered`).
- **Dispatch is the ONE sanctioned same-layer caller of `shipment` — and it must never write shipment state.** It goes through `ShipmentService.recordEvent`, ALWAYS behind `checkTransition`.
- **Two shipments to the same coordinates are two stops, not one.** `AddressService.resolve` inserts a fresh address row per shipment (no dedup). Real merge happens only when legs share an address entity.
- **`OptimizationProvider` is a port; the MVP binding always reports `usedFallback: true`.** The `HeuristicOptimizationProvider` (haversine NN+2-opt) IS the fallback; it returns `Promise.resolve(...)` (not `async`) to avoid `require-await`.

## Notification

- **Notification events must be SELF-CONTAINED (event-storming §2.2).** The PRODUCER puts `recipientPhone`/`recipientName`/`trackingNumber` in the event payload. A handler that can't find a recipient in the payload SKIPS (clean no-op).

## Finance / Ledger

- **The ledger zero-sum invariant is a DEFERRABLE INITIALLY DEFERRED constraint trigger**, checked at COMMIT. `LedgerService.postTransaction` also validates in app code, but the trigger is the hard guarantee. `ledger_entries` is append-only; corrections are `REVERSAL` entries.
- **Ledger idempotency is `ledger_entries.source_event_id`** (partial-unique, independent of `processed_events`). A malformed money event THROWS (→DLQ), never skips — losing a financial record is never acceptable.
- **Finance accounts are created LAZILY by owner**, not atomically with the driver/hub/merchant. `LedgerService.ensureAccount` find-or-creates on first money movement (`ON CONFLICT DO NOTHING` + re-read).
- **`currencies` is a GLOBAL reference table** (no `tenant_id`, no RLS, app read-only) — the one non-tenant-scoped table besides `tenants`.

## Observability / OTel

- **OTel instrumentation must be the FIRST thing loaded.** A bare side-effecting import (`import "./instrumentation.js"`) as the literal first line of `main.ts`/`worker.ts`.
- **postgres.js has NO OpenTelemetry instrumentation.** `@opentelemetry/instrumentation-pg` targets `pg` (node-postgres). DB spans are emitted manually in `DatabaseService`.
- **Telemetry is gated on `OTEL_EXPORTER_OTLP_ENDPOINT`.** The trace-context helpers use an EXPLICIT `W3CTraceContextPropagator`, not the global `propagation` API (which is a no-op without SDK). The observability barrel exports helpers ONLY, never `telemetry.ts`.

## Lint / Boundaries / SAST

- **`eslint-plugin-boundaries` v7:** `capture` binds positionally to pattern wildcards; a leading `**` eats the capture slot. Needs `import/resolver: typescript` or every import classifies as "unknown" and rules silently pass.
- **Privileged roles (OWNER/FINANCE/PLATFORM_ADMIN) cannot log in without MFA** — fail-closed. Seed them with `mfa_enabled = true` in tests.
- **`pnpm sast` scans only git-TRACKED files.** `git add` new files before running or the scan proves nothing about new code.

## PII / Crypto

- **PII at rest = `FieldCipher` (AES-256-GCM), not pgcrypto.** Columns hold `v1:iv:tag:ct`. Read models expose only `hasX` booleans; plaintext via explicit `revealPii` (gated by `pii:export`). `CryptoModule` is `@Global`; the crypto barrel exports the class+token ONLY, never the Module.
