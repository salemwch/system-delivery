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

## Driver identity

- **Never take a `driverId` from a driver's request body.** Resolve it from the login: `select id from drivers where user_id = <sub>`. Migration 0043 makes that lookup unique. A user id is not a driver id. Delivery and failure also require the parcel to be in that driver's custody (I26). A body field let any `shipment:deliver` holder book a colleague's COD.
- **A pickup collector is a USER, the custody holder is a DRIVER.** `pickup_requests.assigned_driver_id` and `pickup_shipments.scanned_by_driver_id` hold user ids despite their names (0044). `pickup.parcel_scanned` carries `collectorUserId` (who) and `driverId` (a `drivers.id` or null). Only the assignee may scan or collect (I27). Never put a user id in a driver-id field.
- **Driver test fixtures need a real login.** Use `seedDriverLogin` from `test/database.harness.ts`, and send `out_for_delivery` WITH that `driverId`. Without one, the parcel is in a DRIVER custody nobody holds and every delivery is refused.
- **"Is this caller a driver?" is the ROLE claim, never the login channel.** `principal.actorType === "driver"` only means a phone-code session; a DRIVER who used a password is still a driver. `commandContextOf` and `TenantContextInterceptor` both key on `roles.includes("DRIVER")` (audit F1).
- **Driver reads are scoped in RLS (I28).** `app.current_driver_id` is always written by `withTenant`, like the other two scopes. Ownership is `shipments.last_driver_id`, set ONLY by `ShipmentEventService.applyTo` when an event names a driver; nothing else may write it. A new child table of `shipments` must narrow by `EXISTS` on its parent for driver sessions, or it becomes a way around the scope. ⚠️ Scoping the parcels is not scoping the PII: 0045 hid a colleague's shipments, but `routes`/`route_stops` stayed tenant-wide, so a driver's manifest call returned every foreign stop's address and coordinates with an empty parcel list (0047). Any table a driver can reach over HTTP that carries a location or a person needs its own driver predicate. And scope it by the PARCEL, not the container: a route-level check left a driver the stop's address on their own cancelled route after the parcel was re-planned to a colleague. A stop is visible only if one of its legs is (0048). Shifts follow the same rule (0049): a driver starts a shift only for their own driver record and sees only their own shifts, because a shift switches location collection on and off and carries cash figures.
- **Building the driver app on Windows: Ninja 1.10 cannot read paths past 260 characters**, and pnpm's store paths exceed that, so every native module fails with `ninja: manifest 'build.ninja' still dirty after 100 tries` even with Windows long paths enabled. Fix on the machine, not in the repo: a copy of the SDK's CMake 3.22.1 with Ninja ≥ 1.12 (1.13.2 used), named in the git-ignored `apps/driver/android/local.properties` as `cmake.dir`. Linux (CI, EAS) is unaffected. Build only the phone's ABI locally: `-PreactNativeArchitectures=arm64-v8a`.
- **The driver app's native config fails late.** The `expo-splash-screen` plugin with no `image` prebuilds fine and then breaks `processDebugResources` (`drawable/splashscreen_logo not found`): configure it only together with an image asset. `npx expo install` writes `~` ranges: re-pin to the exact version it resolved. Every new native library needs `expo prebuild --platform android --clean` (it deletes `local.properties`: restore `cmake.dir`) and a rebuild; a Metro reload is not enough.
- **Metro in this monorepo serves the driver bundle at `/apps/driver/index.bundle`**, not `/index.bundle` (its root is the workspace). `curl "http://localhost:8081/apps/driver/index.bundle?platform=android&dev=true"` → 200 proves every module resolves without a phone.
- **A stop settles only through `RouteService.settleStopsForShipment`**, called after each sync item. A route cannot be completed while a stop is PENDING/ARRIVED, so a new path that records a delivery outcome (an online driver route, a hub action) must call it too, or the driver's route stays open forever.
- **The cash handover is not idempotent.** `POST /v1/finance/remittances` takes no key: the app sends it once and, on a lost answer, tells the driver to check with the hub. Never put it in the outbox until the endpoint takes an idempotency key.
- **`DEV_LOG_SMS_BODIES=true` is the free dev SMS inbox**, and only that: the console provider then logs each SMS recipient and body (driver sign-in codes included). The config refuses it with `NODE_ENV=production`. Test data for the phone: `pnpm --filter @delivery/api dev:field-day`.
- **Importing `testcontainers` replaces `fetch`'s transport.** It installs its own, newer undici as Node's global dispatcher, which refuses an explicit `content-length` header beside a Buffer body (`invalid content-length header`). In CI every spec imports it (the database harness falls back to a container), so a test that sends `content-length` itself fails there and passes locally. Let `fetch` derive the length from the body, as a phone does. Production never imports it.
- **A `bigint` in a response body is a 500.** Fastify serializes a schemaless response with `JSON.stringify`, which throws `Do not know how to serialize a BigInt`. `GET /v1/routes/:id/manifest` returned the service view (`codAmountMinor: bigint`) and failed on every call, `0n` included, while every service test passed. Money leaves as a decimal string with its currency and exponent (`manifest-response.ts`, shipment `toResponse`). A new response type carrying money needs an HTTP test.
- **Device time goes through `resolveDeviceTime`** (`shared/http`). More than 5 minutes ahead is a 400, slightly ahead is clamped to now. Without it one phone with a wrong clock records deliveries in the future and outranks every later event.
- **POD keys are issued, never accepted.** `confirmDelivery` checks every cited `signatureObjectKey` / `photoObjectKeys` against `pod_artifacts` for that parcel (0052). A test POD with an invented key is now a 422; use `id_check` where media is not the point.
- **RLS is not authorization for counts.** `GET /v1/workload` once returned every badge to any session, so a driver read the tenant-wide number of merchant applications, draft expenses and low-stock items: those tables are tenant-wide by design and RLS hides nothing there. Each count is now gated by the permission of its queue's own list route (`QUEUE_PERMISSION` in `identity/api/workload.controller.ts`, a total record, so a new queue without a permission does not compile). Anything that aggregates across modules needs the same treatment.
- **Route ids are validated by a global pipe, keyed on the NAME.** `UuidParamPipe` (APP_PIPE in `IdentityModule`) rejects a malformed `:id` / `:somethingId` with 400; before it, the `::uuid` cast failed in PostgreSQL and every malformed id was a 500. A route param that holds a UUID must be named `id` or end in `Id`; one that does not hold a UUID must not (`:code`, `:slug`, `:trackingNumber`). Test modules that hand-build the pipeline must bind the pipe too.
- **Idempotency keys go through `runCommand` (I29), never a bare "is this key in shipment_events?" check.** That check was tenant-wide and ran before authorization. A test that "replays" with a fresh random caller each time is two callers, and correctly gets 422.

## Idempotency

- **Binding:** `caller` for client keys (shipment, caller, command, request fingerprint must all match); `fact` for server-derived keys of internal orchestration (shipment and command only), so a second dispatcher can retry a half-published route. Never expose a `fact` command over HTTP.
- **Replay returns the RECORDED outcome**, decoded through `shipment-snapshot.ts`. Its `_SnapshotIsShipment` type proof fails compilation when a `shipments` column changes and the codec does not. Fix the codec; do not loosen the proof.

## PII / Crypto

- **PII at rest = `FieldCipher` (AES-256-GCM), not pgcrypto.** Columns hold `v1:iv:tag:ct`. Read models expose only `hasX` booleans; plaintext via explicit `revealPii` (gated by `pii:export`). `CryptoModule` is `@Global`; the crypto barrel exports the class+token ONLY, never the Module.
