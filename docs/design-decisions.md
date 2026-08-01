# Key Design Decisions (not derivable from code)

Read this file before proposing changes to a module. These decisions were made deliberately and often after hitting the wrong alternative first.

---

## Encryption & Data

- `FIELD_ENCRYPTION_KEY` (base64 32 bytes) is REQUIRED — present in `.env`, placeholder in `.env.example`
- `shipment_events` partitioning deferred to keep unique constraints real (table is empty, retrofit is routine)
- Recipient counters are NOT written by shipment — they become a directory-side consumer
- `cod.collected` consumed by `ledger` group; `pod.captured` still published with no consumer
- DLQ replay/resolve admin path not built (rows land PENDING)

## Custody & Manifest

- Hub-ops commands (`arrived_at_hub`/`loaded`/`departed`) now live in `custody`. Custody transfers at manifest RECEIPT, never at seal (§3.11 rule 5). A RETURN manifest emits no `loaded` — its parcels are not at a hub
- Manifest hotspot H2 (who is liable for a missing parcel) is deliberately undecided — `manifest_discrepancies` records the facts and a resolution reason; no blame, no charge-back until the S2 policy call
- `custody` and `dispatch` are the only two sanctioned same-layer dependencies on `shipment`; both call it directly. `pickup` may NOT — it hands off via `pickup.parcel_scanned`

## Telemetry & Realtime

- **A GPS ping is NOT a business event** (event-storming §2.4, the single most important rule there). Raw telemetry never touches the outbox; only a geofence ENTER crosses into the business plane. A test asserts ingesting 20 batches produces zero `shipment.*` events
- `driver_positions` has **RLS + 90-day retention, NOT compression** — TimescaleDB 2.28 makes columnstore and row security mutually exclusive; forced RLS wins on the most privacy-sensitive table
- Migration ordering for a hypertable is load-bearing: table → hypertable → dimensions → **indexes → RLS → grants → compression/retention LAST**
- `driver_positions.location` is a **GENERATED** column from `lon`/`lat`, so the point cannot be built wrong per call site
- Realtime backpressure policy: drop superseded `positions` frames, **never** `shipment_updated` or `alert`
- WebSocket fan-out goes through **Valkey pub/sub per tenant**, not in-process. Without it two replicas means a dispatcher sees half the fleet
- `@types/ws` is in `knip.json` `ignoreDependencies`: needed to resolve `@fastify/websocket`'s types
- **A serialised flush must loop, not just await the in-flight one.** Exit condition is **no flush in flight AND nothing buffered**, never either alone
- **`TelemetryWriter` drops a failed group rather than re-buffering it** — deliberate; a test asserting exact row count must check `stats().failedFlushes` first
- **A user id is NOT a driver id.** `openShiftForUser` resolves the driver INSIDE the shift query

## Identity & Auth

- `TokenService.authenticate()` is the ONE implementation of "bearer token → Principal". Both `AuthGuard` and the WebSocket handshake call it
- **MERCHANT is the only role scoped BELOW the tenant.** Enforced by RLS via `app.current_merchant_id` (migration 0020), never by a `WHERE` clause
- A merchant token without `mid`, or a non-merchant token carrying one, is **rejected outright** by `TokenService`
- RLS predicates must use `CASE`, not `OR`: SQL does not guarantee short-circuit, `''::uuid` errors
- A transaction-local `set_config` reverts to the **empty string**, not unset. `deleteTenants` sets `NO_TENANT` for this reason
- `recipients` is tenant-scoped with no `merchant_id`, so MERCHANT holds **no** `recipient:*` permission
- **RM-R1 is closed (2026-07-29):** `recipients` stays tenant-scoped. Merchants use `GET /v1/address-book` (projection of their own shipments). See migration 0021
- **MFA bootstrap deadlock:** role in `MFA_REQUIRED_ROLES` cannot log in until enrolled, cannot enrol without a session. Solved by **challenge token alongside `MFA_ENROLMENT_REQUIRED`** — authorises enrolment on one account for five minutes. `verifyAccessToken` rejects `typ: "mfa"`, `verifyMfaChallenge` rejects access tokens
- **Driver login phone lives on `users`, not `drivers`.** `identity` (layer 0) must not depend on `fleet` (layer 1). Partial UNIQUE on `(tenant_id, phone) WHERE phone IS NOT NULL`
- **OTP anti-enumeration:** request answers identically for known and unknown numbers. `verify` checks code BEFORE resolving the driver
- **TOTP single-use:** `users.mfa_last_step` records highest step accepted. Tests: enrolment consumes current step, verification must use `currentCode(secret, 1)`
- **Role allow-list must derive from `ROLES`.** A hardcoded array predating MERCHANT caused zero-role merchant logins

## Audit

- **`audit_log` is append-only via REVOKE** (not narrower GRANT). Each partition needs the same REVOKE. A trigger catches the table owner
- **Audit trigger must let tenant cascade through.** Permits DELETE only when the tenant row is already gone
- **`AuditService.record` takes the caller's transaction** — a trail in its own tx would claim things that got rolled back
- **Request id must be a UUID** (Fastify `genReqId`), not pino's `genReqId` which is silently ignored on Fastify. Fastify default `req-1` → `audit_log.correlation_id` UUID column → 500 on every audited mutation

## Notification

- **SMS provider is deliberately vendor-neutral** (MVP-O1 open). Generic JSON body, reads id from `messageId`/`message_id`/`id`/`sid`
- **Both channels default to `console`.** Fail-safe = "did not send"
- **FCM without `firebase-admin`.** `node:crypto` + `fetch`. Token refresh serialised
- **Arabic SMS = 70 chars/segment (UCS-2).** `estimateSegments` catches cost triples. `é` IS GSM-7
- **Notification routes keyed on EVENT name, never status name.** `outboxEventName()` is the only version

## Shipment & Returns

- **`allowsReattempt` checks REASON before attempt count.** CUSTOMER_REFUSED → no retry. Fails OPEN on unknown code
- **`completeReturn` closes RETURN_PENDING → RETURNED.** Without it parcels stayed "coming back" forever
- **Returned/cancelled COD needs `cod_status = 'CANCELLED'`** (migration 0027). PENDING inflated cash-in-field daily
- **Returns go through `spawnReturnLeg`** — both automatic and manual paths
- **A bon de retour is refused unless RETURN_PENDING or RETURNED**

## Operating Config & SLA

- **`sla_templates` CHECK must match `shipments.service_level`** — SAME_DAY vs SCHEDULED mismatch caused silent fallback
- **Scheduling in WORKING hours, never elapsed.** `weekendDays` configurable (Gulf = Fri–Sat)
- **Working hours are LOCAL wall-clock, not UTC.** `Intl.DateTimeFormat` for conversion
- **Per-tenant defaults seeded at provisioning, not migration.** `CROSS JOIN tenants` = only tenants at deploy time. Defaults in `operating-defaults.ts`, `TenantService.provision` seeds them

## Migration Traps

- **Seed cross-tenant rows BEFORE enabling FORCE RLS** — otherwise rejected by `WITH CHECK`
- **Migration cannot back-fill a FORCE-RLS table silently.** DML filtered, constraint validation not. Use `NO FORCE` … `FORCE`
- **`z.record(z.enum([...]), …)` demands EVERY key.** Use explicit optional-keys + non-empty refine

## DLQ

- **Resolve ≠ discard.** Resolve = effect achieved another way; discard = will never happen (needs reason)
- **Replay checks `processed_events` FIRST** to prevent double-posting
- **`REPLAY_HANDLERS` is separate from `EVENT_HANDLER`** — different binding, different lifecycle

## Infrastructure

- **Terraform targets DigitalOcean** (docs/09 §2). AWS at V2. Staging keeps production's shape
- **Cost function INJECTED into one sequencer.** Duration SUMMED from matrix, never distance ÷ flat speed
- **OSRM takes lon,lat; unroutable pair → `null` → `Infinity`** (never 0 or NaN)
- **Money formatting in `shared/money`, not `finance`.** `currencies` is global, no `tenant_id`
- **Documents render print-ready HTML, never PDF bytes.** Arabic glyph shaping needs a browser. `unicode-bidi: isolate` for LTR numbers in RTL pages
- Parcel QR = **bare tracking number** (not URL, not JSON)

## Frontend

- **`@Global()` module still needs one IMPORT.** `ValkeyModule` was worker-only; API graph couldn't resolve `VALKEY_CLIENT`
- **Locale in PATH, not query parameter.** Layout can't read `searchParams`; `dir`/`lang` on `<html>` requires it
- **`en-GB` needs explicit `hourCycle: "h23"`** for 24-hour time in Tunisia
- **WebSocket `message` listener attached SYNCHRONOUSLY** before handshake await. Early frames queued + capped

## Geocoding

- **Nominatim jsonv2 renames `class` to `category`** — reading wrong one silently scored 0.4, blocked auto-dispatch
- **Confidence from GRANULARITY, never `importance`** (PageRank prominence ≠ address precision)
- **Chain falls through on LOW CONFIDENCE, not null.** Governorate centroid ≠ street address
- **`countrycodes` on every geocode is load-bearing** — 'Ariana' matches Iran without it

## Routing

- **OSRM off by default** (`ROUTING_OPTIMIZER=haversine`). One `/table` call per optimisation, never per pair
- **Every failure degrades to haversine + `usedFallback`** flag

## Observability

- **Measured, not assumed** (see [load/README.md](../load/README.md)). Ingest 24.7ms p95 / 300ms budget. **10k positions/sec NOT demonstrated**
- **k6 `Rate` must record both success and failure.** Success-only metrics hide defects as silence
- **Never pipe `pnpm sast` to `tail`** — pipeline exit status is last command's

## Tracking Page

- **Tenant resolution via SECURITY DEFINER function** (`resolve_tenant_id_by_slug`). FORCE RLS on `tenants` creates chicken-and-egg; broader RLS would expose all tenant metadata. Migration 0029
