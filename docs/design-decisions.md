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
- **TWO roles are scoped BELOW the tenant, in two different shapes.** MERCHANT → one merchant, `app.current_merchant_id` from the token's `mid` (0020, I24). COMMERCIAL → a *set* of merchants, `app.current_account_manager_id` (0030, I25). Both in RLS, never a `WHERE` clause
- A merchant token without `mid`, or a non-merchant token carrying one, is **rejected outright** by `TokenService`
- **The commercial's scope is DERIVED, not a claim.** It is the user's own `sub` when `rol` contains COMMERCIAL — one function, `accountManagerScope()`. A third signed value could disagree with the other two; a derived one cannot
- **A commercial's portfolio needs TWO RLS predicates, not one.** `current_account_manager_allows(account_manager_id)` guards `merchants` with a direct column comparison; `current_portfolio_allows(merchant_id)` guards everything else with an EXISTS against `merchants`. Giving `merchants` the EXISTS form recurses until the stack dies
- **`merchant:onboard` exists so a commercial never needs `user:manage`.** It can only ever mint a MERCHANT login. Which merchant is enforced by a constraint trigger (`users_assert_merchant_in_portfolio`), not by service code — `identity` cannot import `directory`, so only Postgres can see both sides
- **Merchant ownership is set from ambient context, never from the DTO.** `MerchantService.create` reads `TenantContext.current()?.accountManagerId`. A body field would let a commercial write into a colleague's portfolio, or out of their own
- **MERCHANT and COMMERCIAL cannot be combined with any other role.** A hybrid keeps the wider role's permissions and the narrower role's visibility — it returns almost nothing and reads as data loss
- A commercial holds **no** `recipient:*` (same reasoning as MERCHANT) and no `merchant:block` / `merchant:assign_manager`
- **`pickup:claim`, not `pickup:assign`.** `POST /v1/pickups/:id/claim` reads the collector from the token, so it can only ever assign the caller. Granting `pickup:assign` instead would let a field salesperson route work to any driver in a fleet of hundreds. Both go through one private `assignTo()` so the state machine, outbox event and audit cannot drift
- **`pickup_requests.assigned_driver_id` has no FK to `drivers`, deliberately.** The person who physically collects is not always a driver — a commercial is the case that proves it. `scan`/`scanBatch` already record `ctx.actorId`, not a driver lookup
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
- **Each Next app needs its OWN `.env.local`.** Next loads env from the app directory, not the monorepo root, so `apps/web` threw `API_BASE_URL is not set` on every render until it had one. `apps/merchant` had one already — that is the pattern, not an accident. Root `.env` serves the API and the scripts; `.env.*` is gitignored
- **A layout `redirect()` does NOT protect its pages — `src/proxy.ts` does.** Next renders layout and page CONCURRENTLY: the page's first `apiFetch` hit `readSession()` → null → `NotAuthenticatedError` and returned a 500 stack trace before the layout's redirect could land. The proxy runs before rendering, so there is no race. It checks cookie PRESENCE only — the seal is AES-256-GCM and only the server opens it, so a forged cookie passes the proxy and is rejected by `readSession()`, which stays the authority
- **`proxy.ts`, NOT `middleware.ts`.** Next 16 renamed the convention (`PROXY_FILENAME = 'proxy'` in `next/dist/lib/constants`) and warns on the old name; shipping both files is an error, not a fallback. The handler is the DEFAULT export. `apps/web` and `apps/merchant` both have one; `apps/track` does not and must not — it is the public tracking page and has no session
- **`envFilePath` in Nest resolves against CWD too** — same bug, other stack. `[".env", "../../.env"]`, nearest-first
- **List endpoints return `{data, page:{nextCursor, hasMore}}`, not `{data, cursor, total}`.** `apps/web` modelled the latter, so `result.cursor` was `undefined`, `undefined !== null` was true — and "Load more" rendered on every page while linking nowhere. One `fetchPage()` translates the envelope now. **`hasMore` is the authority**: `nextCursor` is the last row's id and is non-null on the final page too
- **There is no `total`.** Cursor pagination exists so a list never pays for `COUNT(*)`; the fleet page rendered `(undefined)` for months by assuming otherwise
- **`PickupSummary` invented `parcelCount` and `scheduledAt`** — neither exists on `GET /v1/pickups`, so both rendered `undefined`. `merchantName` is now real: the list route resolves it via `MerchantService.namesByIds`, ONE batched `inArray` per page, never a join and never a lookup per row. `pickup` must not SELECT from `merchants` — directory owns that table
- **A merchant's pickup address is set at REGISTRATION**, via `pickupAddress` on `POST /v1/merchants`. There is no address API and exposing one is a bigger decision than onboarding needs; without this a merchant has nowhere to collect from and every pickup request for them fails on a missing `pickupAddressId`. Resolved BEFORE the merchant transaction opens — `AddressService.resolve` geocodes, and holding a write transaction across a third-party HTTP call pins a connection for someone else's timeout
- **Zod schemas that embed each other must be declared in dependency order.** `createMerchantSchema` references `resolveAddressSchema`; a `const` in its temporal dead zone is a ReferenceError at import time, which no type check catches
- **The Claim button renders only on ACCEPTED rows.** `ACCEPTED → ASSIGNED` is the sole transition into an assigned run (`pickup-status.ts`), so a button anywhere else is an offer the API refuses
- **`formatMoney` takes `number | bigint`.** COD sums arrive as decimal strings that can exceed `MAX_SAFE_INTEGER` in a 3-decimal currency. Integer division on BigInt, never float
- **Stats endpoints return `currencyExponent`.** A client that hardcodes ÷100 misprices every TND amount by ten
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
