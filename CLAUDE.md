# Delivery Management Platform — Project Instructions

## Domain-first development

The domain model (docs/02-domain-model.md) is the source of truth. Read docs 01→02→03 before proposing any change. Never design tables before understanding the domain, never write business logic before defining rules, never create APIs before defining use cases. See the frozen domain model for entities, lifecycles, state machines, and invariants.

---

## Current phase: IMPLEMENTATION AUTHORIZED — Stage S0 (foundations)

Authorized 2026-07-22. Build within these limits:

1. **Follow [01-mvp-scope.md](./docs/01-mvp-scope.md) and ADR-005.** NestJS modular monolith only. **Do not create Go or Python services.**
2. **Do not build out-of-scope features.** If a request falls outside 01-mvp-scope §4, say so and ask before building it.
3. **S0 first:** monorepo, CI, Testcontainers, Terraform, PostgreSQL, tenancy/RLS, auth/RBAC, outbox, OpenTelemetry, module boundaries.
4. **SMS:** build only the `NotificationProvider` abstraction and config structure.
5. Anything ambiguous → ask, don't assume.

---

## Current state (updated 2026-07-29)

**Everything green:** `pnpm build` → ok · `pnpm test` → 678/678 · `pnpm lint` → 0 · `pnpm knip` → 0 · `pnpm sast` → 0.

**You can log in for real:** `pnpm db:seed` → `POST /v1/auth/login` → token → `/v1/auth/me`.

### Done

| Area           | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo       | pnpm + Turborepo, Node 24 LTS, TS 5.9.3 (do not move to TS 7 until NestJS supports it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Local infra    | `pnpm dev:infra` — PG18+TimescaleDB+PostGIS, Valkey 8.1, MinIO. Images pinned by digest. OSRM behind `--profile routing`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| DB roles       | `dp_app` (RLS, no DDL), `dp_migrator` (owns schema), `dp_relay` (outbox-only cross-tenant). Three least-privilege identities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Migrations     | 0000–0025 applied. Forward-only, checksum-locked, immutable. See individual migration files for DDL details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| RLS            | Data tables: ENABLE+FORCE. `tenants` registry: ENABLE only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `shared/`      | config (Zod, fail-fast), database (`withTenant`), errors (`DomainError`), http (RFC 9457, `ZodValidationPipe`), crypto (`FieldCipher` AES-256-GCM), observability (OTel traces, `withSpan`, trace-context threading), valkey (ioredis 5.11.1)                                                                                                                                                                                                                                                                                                                                                                                                      |
| `platform`     | OutboxService, FeatureService, TenantService, OutboxRelayService, ValkeyStreamEventPublisher, EventPublisher port. **AuditService** — append-only trail, monthly partitions, secret redaction, `GET /v1/audit`. 26 tests                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `core-worker`  | Relay (FOR UPDATE SKIP LOCKED, backoff, alerts) + EventStreamConsumer (XREADGROUP, dedup, DLQ). 12 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `identity`     | Auth (Argon2id, jose, lockout, refresh rotation+reuse detection), RBAC (AuthGuard, PermissionGuard), AuthController. Provisioning+seed CLI. MERCHANT role + `users.merchant_id` sub-tenant scope (I23/I24). UserService + UserController — create/list/disable/enable/reset-password, generated passwords returned once, session revocation, last-OWNER guard. **MfaService** — real TOTP (otpauth 9.5.1), two-phase enrolment, encrypted secret, single-use replay guard, hashed recovery codes, bootstrap path. **OtpService** — driver phone login, hashed single-use codes, attempt cap, per-phone rate limit, no enumeration oracle. 80 tests |
| `directory`    | MerchantService, RecipientService, AddressService (GeocodingProvider port). 16 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `network`      | HubService (resolveForAddress via ST_Covers/KNN), ZoneService, GeofenceService (pure evaluate). 17 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fleet`        | VehicleService, DriverService (PII encrypted), ShiftService (privacy gate). 19 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `shipment`     | ShipmentEventService.applyTo = single status writer. ShipmentService commands (create, pickup, deliver, fail, return, cancel). AddressBookService — the merchant's own recipients, projected from RLS-narrowed shipments (resolves RM-R1). 16 tests                                                                                                                                                                                                                                                                                                                                                                                                |
| `pickup`       | Scan-based parcel-level custody. EXPLICIT/MERCHANT_READY selection, zero-parcel outcome reasons, offline batch sync. `pickup.parcel_scanned` → `pickup-scan` consumer → shipment custody. 136 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `custody`      | ManifestService (open→seal→dispatch→receive→reconcile, 4 types), HubScanService (hub inbound). Makes AT_HUB/IN_TRANSIT reachable. I14 immutability enforced by DB trigger. 76 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `dispatch`     | RouteService (create→publish→start→complete), AssignmentService. Haversine NN+2-opt fallback. 22 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `notification` | EventStreamConsumer + NotificationEventHandler + NotificationService. ConsoleNotificationProvider. 9 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tracking`     | **telemetry:** ingest on a dedicated pool, batched writer (1000 rows/1s, bounded, sheds oldest), TimescaleDB hypertable, Valkey presence (90s TTL = the offline signal), geofence → `shipment.arrived_at_stop`. **realtime:** `wss /v1/realtime` on `@fastify/websocket`, 1Hz coalesced frames, tenant-verified subscriptions, Valkey pub/sub across replicas. 58 tests                                                                                                                                                                                                                                                                            |
| `complaint`    | ComplaintService — réclamation lifecycle, per-tenant SLA, append-only trail. **COD_DISPUTE resolution posts a REVERSING ledger transaction (closes hotspot H8).** 40 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `finance`      | **Inc1:** currencies + double-entry ledger (zero-sum DEFERRABLE trigger). **Inc2:** remittance (submit/confirm/dispute). **Inc3:** settlement (draft→approve→pay with separation-of-duties) + reconciliation (cashInField, dailyReconciliation). 24 tests                                                                                                                                                                                                                                                                                                                                                                                          |
| Enforcement    | `pnpm lint:rules` — 6 fixtures. `.semgrep.yml` — 10 custom rules. `pnpm sast`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| CI/CD          | 5 jobs + ci-passed gate. Actions pinned by SHA. Dependabot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Key design decisions (not derivable from code)

- `FIELD_ENCRYPTION_KEY` (base64 32 bytes) is REQUIRED — present in `.env`, placeholder in `.env.example`
- `shipment_events` partitioning deferred to keep unique constraints real (table is empty, retrofit is routine)
- Recipient counters are NOT written by shipment — they become a directory-side consumer
- `cod.collected` consumed by `ledger` group; `pod.captured` still published with no consumer
- DLQ replay/resolve admin path not built (rows land PENDING)
- Hub-ops commands (`arrived_at_hub`/`loaded`/`departed`) now live in `custody`. Custody transfers at manifest RECEIPT, never at seal (§3.11 rule 5). A RETURN manifest emits no `loaded` — its parcels are not at a hub
- Manifest hotspot H2 (who is liable for a missing parcel) is deliberately undecided — `manifest_discrepancies` records the facts and a resolution reason; no blame, no charge-back until the S2 policy call
- `custody` and `dispatch` are the only two sanctioned same-layer dependencies on `shipment`; both call it directly. `pickup` may NOT — it hands off via `pickup.parcel_scanned`
- **A GPS ping is NOT a business event** (event-storming §2.4, the single most important rule there). Raw telemetry never touches the outbox; only a geofence ENTER crosses into the business plane. A test asserts ingesting 20 batches produces zero `shipment.*` events
- `driver_positions` has **RLS + 90-day retention, NOT compression** — a deliberate deviation from 06-database-design §5.1. TimescaleDB 2.28 makes columnstore and row security mutually exclusive ("columnstore cannot be used on table with row security"); forced RLS wins on the most privacy-sensitive table in the system. Revisit at ADR-005's extraction trigger
- Migration ordering for a hypertable is load-bearing: table → hypertable → dimensions → **indexes → RLS → grants → compression/retention LAST**. Both `CREATE INDEX` and `ENABLE ROW LEVEL SECURITY` are rejected once columnstore is on
- `driver_positions.location` is a **GENERATED** column from `lon`/`lat`, so the point cannot be built wrong per call site and the writer stays a plain multi-row INSERT
- `TokenService.authenticate()` is the ONE implementation of "bearer token → Principal". Both `AuthGuard` and the WebSocket handshake call it, so a socket and a request can never disagree about identity
- Realtime backpressure policy: drop superseded `positions` frames, **never** `shipment_updated` or `alert`. A position is a sample the next one supersedes; a status change is a fact that happened once
- WebSocket fan-out goes through **Valkey pub/sub per tenant**, not in-process. Without it two API replicas means a dispatcher silently sees half the fleet — a bug that only appears on the second instance
- `@types/ws` is in `knip.json` `ignoreDependencies`: it is needed to resolve `@fastify/websocket`'s types, which knip cannot see
- **MERCHANT is the only role scoped BELOW the tenant.** Every other role sees the whole tenant, so RLS alone isolates it. A merchant sees only rows matching `users.merchant_id` inside a tenant that also holds rivals — enforced by RLS via `app.current_merchant_id` (migration 0020), never by a `WHERE` clause a query might forget
- A merchant token without `mid`, or a non-merchant token carrying one, is **rejected outright** by `TokenService` — a MERCHANT claim with no scope would read as "no narrowing" and see the whole tenant
- RLS predicates must use `CASE`, not `OR`: SQL does not promise to short-circuit `OR`, so `setting = '' OR col = setting::uuid` still evaluates `''::uuid` and errors
- A transaction-local `set_config` reverts to the **empty string**, not unset. A pooled connection reused with no context makes `current_setting(...)::uuid` a cast error — `deleteTenants` in the test harness sets `NO_TENANT` for exactly this reason
- `recipients` is tenant-scoped with no `merchant_id`, so MERCHANT deliberately holds **no** `recipient:*` permission — granting it would leak a competitor's customer list. Restore once the table is merchant-scoped (docs/02 §3.19)
- **RM-R1 is closed (2026-07-29): `recipients` stays tenant-scoped and merchants never read it.** One row per person is the point — history, address quality, and above all the repeat-refuser block-list have to accumulate across the tenant, and a per-merchant book splits all three. It is also not implementable: measured on PG 18, with the conflicting row hidden by a SELECT policy, `INSERT` gives 23505, `ON CONFLICT DO UPDATE … RETURNING` gives **42501**, `DO NOTHING … RETURNING` gives no id, and `UPDATE … WHERE phone` matches 0 rows — so a merchant could never create a parcel for an existing buyer. Merchants use `GET /v1/address-book`, a projection of their own shipments (already narrowed by 0020). See migration 0021
- **`mfa_enabled` used to lie, and the fix has a deadlock in it.** The flag was set true at provisioning so privileged accounts could log in at all — no enrolment, no challenge, so OWNER/FINANCE/PLATFORM_ADMIN were password-only. Now real: but a role in `MFA_REQUIRED_ROLES` cannot log in until enrolled and cannot enrol without a session. Broken by issuing a **challenge token alongside `MFA_ENROLMENT_REQUIRED`** — it authorises enrolment on one account for five minutes and nothing else. `verifyAccessToken` rejects `typ: "mfa"`, and `verifyMfaChallenge` rejects an access token, so the two can never be confused
- **The phone that logs a driver in lives on `users`, not on `drivers`.** Resolving phone → `drivers` → `users` would make `identity` (layer 0) depend on `fleet` (layer 1), and the port-and-adapter workaround produced a circular module reference. `users.phone` already existed, authentication identity is an identity concern, and `drivers.phone` stays the operational contact number — the two may legitimately differ. Partial UNIQUE on `(tenant_id, phone) WHERE phone IS NOT NULL`
- **OTP request must answer identically for a known and an unknown number.** Only the SMS is conditional. A different response — including a different rate-limit shape — lets anyone enumerate a courier's fleet one number at a time. `verify` also checks the code BEFORE resolving the driver, or the ordering itself answers the question
- **A TOTP code must be single-use, not merely valid.** A code stays good for its whole 30-second step plus drift, so one captured by a phishing proxy is replayable. `users.mfa_last_step` records the highest step accepted; anything at or below it is refused. Consequence for tests: enrolment consumes the current step, so a follow-up verification must use `currentCode(secret, 1)`
- **`audit_log` is append-only, and the REVOKE is what makes it so.** `initdb`'s `ALTER DEFAULT PRIVILEGES` grants `dp_app` full DML on every table `dp_migrator` creates, so `GRANT SELECT, INSERT` alone is a **no-op that reads like a restriction**. Each new partition needs the same REVOKE — privileges are checked on the table named in the query, so `DELETE FROM audit_log_202608` would otherwise bypass the parent. A trigger backs both up and catches the table owner, whom grants do not restrain
- **The audit trigger must let a tenant cascade through.** Deleting a tenant cascades to `audit_log`, and a blanket DELETE rejection blocks tenant deletion entirely. The trigger permits a delete only when the tenant row is already gone — a cascade fires after the parent is removed. Same pattern as the I14 manifest trigger
- **`AuditService.record` takes the caller's transaction**, exactly like `OutboxService.publish`. A trail written in its own transaction survives a rolled-back action and claims something happened that did not
- **A serialised flush must loop, not just await the in-flight one.** `TelemetryWriter.flush()` awaited the running flush and returned — but that flush had already taken the buffer, so rows enqueued in between stayed in memory while the caller was told everything was written. On `onApplicationShutdown` that silently discarded the last positions of every driver's trail. Surfaced as a flaky "19 of 20 positions" failure only under full-suite load
- **A role allow-list written by hand will drift, and it drifts silently.** `AuthService.rolesOf` filtered against a hardcoded array that predated MERCHANT, so every merchant login authenticated with **zero roles and therefore zero permissions** — a portal that 403s on every request while the token looks valid. Both `rolesOf` and `UserService` now narrow through `isRole`, which derives from `ROLES`. Any future role must be added in exactly one place
- Parcel QR encodes the **bare tracking number** — not a URL, not JSON — so a scanned label drops straight into the existing scan endpoints, stays sparse, and carries no hostname
- OSRM binding deferred until Maghreb extract loaded (`dev:infra --profile routing`)

### Traps — read before modifying any module

**See [docs/traps.md](./docs/traps.md)** for the full reference. Critical ones:

- `set_config(…, true)` not `SET LOCAL`. Drizzle errors: walk `.cause` chain. PostGIS: never select raw geography column. `REVOKE` for restrictions (not narrower `GRANT`). Don't bind `Date` in raw `sql` fragments. Don't pass JS arrays to `= ANY($1::uuid[])` — use `inArray()`. Events must be self-contained (no cross-module lookups in consumers). OTel instrumentation = bare side-effecting import as first line. Finance accounts are lazy by owner. Ledger zero-sum is a DEFERRABLE trigger. Never re-export a `@Module` from a barrel.

---

## Engineering standards — non-negotiable

### Correctness

- **Ship production-ready code.** No `TODO`, no `FIXME`, no stubs, no placeholder returns.
- **Cover every path.** Valid, invalid, empty/null/boundary, concurrent, partial failure, timeout, retry, offline.
- **Every error handled deliberately.** No bare `catch {}`.
- **Verify before claiming done.** Run lint, types, and tests.

### Types

- **`any` is banned** (enforced by lint). Use `unknown` + narrowing.
- **No type assertions to escape problems.** Never `as any`, never `as unknown as T`.
- **Named types for domain values** (`TenantId`, `AmountMinor`, `TrackingNumber`).
- **No `!` non-null assertions.** Handle the null case.
- **TypeScript strict mode** + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc. Do not weaken.

### One tool per job

| Job           | Use                             | Never alongside                 |
| ------------- | ------------------------------- | ------------------------------- |
| Validation    | **Zod**                         | class-validator, Joi, Yup       |
| Data access   | **Drizzle ORM**                 | Prisma, TypeORM, Knex           |
| HTTP          | **NestJS + Fastify**            | Express adapter                 |
| Jobs          | **BullMQ** (Valkey)             | node-cron, setInterval          |
| Events        | **Outbox → Valkey Streams**     | Kafka (until V2), EventEmitter2 |
| Cache         | **Valkey**                      | Redis duplication, Memcached    |
| Testing       | **Vitest** + **Testcontainers** | Jest, mocked repos              |
| HTTP client   | **native `fetch`**              | axios, got                      |
| Logging       | **Pino**                        | Winston, console.*              |
| Config        | **Zod-validated ConfigService** | direct process.env              |
| IDs           | **UUIDv7**                      | uuid package, nanoid            |
| Passwords     | **argon2 (Argon2id)**           | bcrypt                          |
| Money         | **bigint minor units**          | decimal.js, floats, ×100        |
| Observability | **OpenTelemetry**               | custom trace headers            |
| Routing       | **OSRM** behind adapter         | direct Google/Mapbox calls      |

Adding alternatives requires an ADR in `/docs`.

### Performance

- No N+1 queries. Every list paginates. Every external call has timeout + circuit breaker.
- Prefer faster/simpler when correctness is equal.

### Security

- Zod `strict` mode at boundaries. Parameterised queries only. No secrets in code.
- Never log PII. Every mutating endpoint: authenticated, authorized, ownership-checked, idempotent.

---

## Documents

| #   | Document                                                          | Contents                                                                |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 01  | **[01-mvp-scope.md](./docs/01-mvp-scope.md)**                     | Authoritative MVP boundary, ADR-005, roles, entities, MENA requirements |
| 02  | **[02-domain-model.md](./docs/02-domain-model.md)**               | Frozen entities, lifecycles, state machines, 17 invariants              |
| 03  | **[03-event-storming.md](./docs/03-event-storming.md)**           | 30+ events, 17 commands, 21 policies, read models                       |
| 04  | [04-context-map.md](./docs/04-context-map.md)                     | 12 bounded contexts → NestJS modules, layering                          |
| 05  | [05-api-contracts.md](./docs/05-api-contracts.md)                 | Request/response JSON, error registry, WebSocket                        |
| 06  | [06-database-design.md](./docs/06-database-design.md)             | Tables, indexes, RLS policies, retention                                |
| 07  | [07-security-architecture.md](./docs/07-security-architecture.md) | Threat model, tenant isolation, OWASP                                   |
| 08  | [08-frontend-architecture.md](./docs/08-frontend-architecture.md) | Four apps, i18n/RTL, offline-first driver app                           |
| 09  | [09-infrastructure.md](./docs/09-infrastructure.md)               | Cloud, CI/CD, observability, DR                                         |
| 10  | [10-development-roadmap.md](./docs/10-development-roadmap.md)     | V2+ sequencing (superseded by 01 for MVP)                               |

Reference: [architecture-blueprint.md](./docs/architecture-blueprint.md) (ADRs 001–004), [technology-decisions.md](./docs/technology-decisions.md) (pinning, docs sources), [api-strategy.md](./docs/api-strategy.md), [traps.md](./docs/traps.md).

---

## Architecture summary

- **NestJS modular monolith** (`core-api` + `core-worker`). Go/Python specialists deferred (ADR-005).
- **Tunisia/MENA market.** COD is P0. Arabic/French/English, RTL first. **TND = 3 decimal places** — read exponent from `currencies`, never ×100.
- **Android-only driver app** at MVP. No iOS.
- **No AI/ML.** Deterministic substitutes only (OSRM, historical-median SQL, rule-based).
- **PostgreSQL 18 + PostGIS** system of record. Valkey for ephemeral state. No MongoDB.
- **Transactional outbox → Valkey Streams** (MVP) → Redpanda (V2). Publishers never know consumers.
- **Custody = append-only event log**; `shipments.status` is a derived projection.
- **Tenant isolation = PostgreSQL RLS**, not application code alone.
- **No Kubernetes, Kafka, MQTT at MVP** — complexity deferred with numeric triggers.

---

## Non-negotiable conventions

- Money: **integer minor units + ISO 4217 currency**. Never floats.
- Time: **TIMESTAMPTZ in UTC**; locations carry IANA timezone.
- Units: distances in **metres**, durations in **seconds**.
- IDs: **UUIDv7** externally. No exposed sequential integers.
- Every tenant-scoped table: `tenant_id NOT NULL` + forced RLS.
- Tenant context: **`SET LOCAL`** inside request tx — never `SET`.
- Every mutating endpoint: **`Idempotency-Key`**.
- Events: `tenant_id`, `event_id`, `correlation_id`, named `domain.fact` past tense.
- Every consumer: **idempotent on `event_id`**.
- Cross-module imports: **forbidden** (lint-enforced). Import from barrel only.
- No business logic branching on literal `tenantId` — use `TenantFeature` flags.
- UI: **CSS logical properties only** (`ms-4`, never `ml-4`).
- **Pin all versions.** No `latest`, no floating ranges.
- No secrets in repo, images, or committed env files.

---

## Working preferences

- Consult official docs for pinned versions before implementing.
- 2–3 alternatives with trade-offs for significant decisions.
- Small, reversible commits over large refactors.
- If uncertain, list what's needed and stop.
