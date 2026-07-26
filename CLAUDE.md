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

## Current state (updated 2026-07-26)

**Everything green:** `pnpm build` → ok · `pnpm test` → 227/227 · `pnpm knip` → 0.

**You can log in for real:** `pnpm db:seed` → `POST /v1/auth/login` → token → `/v1/auth/me`.

### Done

| Area | State |
|---|---|
| Monorepo | pnpm + Turborepo, Node 24 LTS, TS 5.9.3 (do not move to TS 7 until NestJS supports it) |
| Local infra | `pnpm dev:infra` — PG18+TimescaleDB+PostGIS, Valkey 8.1, MinIO. Images pinned by digest. OSRM behind `--profile routing` |
| DB roles | `dp_app` (RLS, no DDL), `dp_migrator` (owns schema), `dp_relay` (outbox-only cross-tenant). Three least-privilege identities |
| Migrations | 0000–0014 applied. Forward-only, checksum-locked, immutable. See individual migration files for DDL details |
| RLS | Data tables: ENABLE+FORCE. `tenants` registry: ENABLE only |
| `shared/` | config (Zod, fail-fast), database (`withTenant`), errors (`DomainError`), http (RFC 9457, `ZodValidationPipe`), crypto (`FieldCipher` AES-256-GCM), observability (OTel traces, `withSpan`, trace-context threading), valkey (ioredis 5.11.1) |
| `platform` | OutboxService, FeatureService, TenantService, OutboxRelayService, ValkeyStreamEventPublisher, EventPublisher port |
| `core-worker` | Relay (FOR UPDATE SKIP LOCKED, backoff, alerts) + EventStreamConsumer (XREADGROUP, dedup, DLQ). 12 tests |
| `identity` | Auth (Argon2id, jose, lockout, refresh rotation+reuse detection), RBAC (AuthGuard, PermissionGuard), AuthController. Provisioning+seed CLI |
| `directory` | MerchantService, RecipientService, AddressService (GeocodingProvider port). 16 tests |
| `network` | HubService (resolveForAddress via ST_Covers/KNN), ZoneService, GeofenceService (pure evaluate). 17 tests |
| `fleet` | VehicleService, DriverService (PII encrypted), ShiftService (privacy gate). 19 tests |
| `shipment` | ShipmentEventService.applyTo = single status writer. ShipmentService commands (create, pickup, deliver, fail, return, cancel). 16 tests |
| `dispatch` | RouteService (create→publish→start→complete), AssignmentService. Haversine NN+2-opt fallback. 22 tests |
| `notification` | EventStreamConsumer + NotificationEventHandler + NotificationService. ConsoleNotificationProvider. 9 tests |
| `finance` | **Inc1:** currencies + double-entry ledger (zero-sum DEFERRABLE trigger). **Inc2:** remittance (submit/confirm/dispute). **Inc3:** settlement (draft→approve→pay with separation-of-duties) + reconciliation (cashInField, dailyReconciliation). 24 tests |
| Enforcement | `pnpm lint:rules` — 6 fixtures. `.semgrep.yml` — 10 custom rules. `pnpm sast` |
| CI/CD | 5 jobs + ci-passed gate. Actions pinned by SHA. Dependabot |

### Key design decisions (not derivable from code)

- `FIELD_ENCRYPTION_KEY` (base64 32 bytes) is REQUIRED — present in `.env`, placeholder in `.env.example`
- `shipment_events` partitioning deferred to keep unique constraints real (table is empty, retrofit is routine)
- Recipient counters are NOT written by shipment — they become a directory-side consumer
- `cod.collected` consumed by `ledger` group; `pod.captured` still published with no consumer
- DLQ replay/resolve admin path not built (rows land PENDING)
- Hub-ops commands (`arrived_at_hub`/`loaded`/`departed`) deferred until manifest module
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

| Job | Use | Never alongside |
|---|---|---|
| Validation | **Zod** | class-validator, Joi, Yup |
| Data access | **Drizzle ORM** | Prisma, TypeORM, Knex |
| HTTP | **NestJS + Fastify** | Express adapter |
| Jobs | **BullMQ** (Valkey) | node-cron, setInterval |
| Events | **Outbox → Valkey Streams** | Kafka (until V2), EventEmitter2 |
| Cache | **Valkey** | Redis duplication, Memcached |
| Testing | **Vitest** + **Testcontainers** | Jest, mocked repos |
| HTTP client | **native `fetch`** | axios, got |
| Logging | **Pino** | Winston, console.* |
| Config | **Zod-validated ConfigService** | direct process.env |
| IDs | **UUIDv7** | uuid package, nanoid |
| Passwords | **argon2 (Argon2id)** | bcrypt |
| Money | **bigint minor units** | decimal.js, floats, ×100 |
| Observability | **OpenTelemetry** | custom trace headers |
| Routing | **OSRM** behind adapter | direct Google/Mapbox calls |

Adding alternatives requires an ADR in `/docs`.

### Performance

- No N+1 queries. Every list paginates. Every external call has timeout + circuit breaker.
- Prefer faster/simpler when correctness is equal.

### Security

- Zod `strict` mode at boundaries. Parameterised queries only. No secrets in code.
- Never log PII. Every mutating endpoint: authenticated, authorized, ownership-checked, idempotent.

---

## Documents

| # | Document | Contents |
|---|---|---|
| 01 | **[01-mvp-scope.md](./docs/01-mvp-scope.md)** | Authoritative MVP boundary, ADR-005, roles, entities, MENA requirements |
| 02 | **[02-domain-model.md](./docs/02-domain-model.md)** | Frozen entities, lifecycles, state machines, 17 invariants |
| 03 | **[03-event-storming.md](./docs/03-event-storming.md)** | 30+ events, 17 commands, 21 policies, read models |
| 04 | [04-context-map.md](./docs/04-context-map.md) | 12 bounded contexts → NestJS modules, layering |
| 05 | [05-api-contracts.md](./docs/05-api-contracts.md) | Request/response JSON, error registry, WebSocket |
| 06 | [06-database-design.md](./docs/06-database-design.md) | Tables, indexes, RLS policies, retention |
| 07 | [07-security-architecture.md](./docs/07-security-architecture.md) | Threat model, tenant isolation, OWASP |
| 08 | [08-frontend-architecture.md](./docs/08-frontend-architecture.md) | Four apps, i18n/RTL, offline-first driver app |
| 09 | [09-infrastructure.md](./docs/09-infrastructure.md) | Cloud, CI/CD, observability, DR |
| 10 | [10-development-roadmap.md](./docs/10-development-roadmap.md) | V2+ sequencing (superseded by 01 for MVP) |

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
