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

## Current state (updated 2026-08-05)

**Everything green:** `pnpm build` → ok · `pnpm test` → 980/980 (896 api + 30 track + 17 merchant + 37 web) · `pnpm lint` → 0 · `pnpm lint:rules` → 6/6 · `pnpm knip` → 0 · `pnpm sast` → 0 (308 targets, `apps/web` now tracked and covered).

⚠️ `pnpm sast` scans **git-tracked files only** — an untracked app is silently invisible to it. Never pipe it to `tail`: the pipeline's exit status is the last command's, which hid a `RuleParseError` behind a green tick.

**You can log in for real:** `pnpm db:seed` → `POST /v1/auth/login` → token → `/v1/auth/me`.

### Done

| Area           | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo       | pnpm + Turborepo, Node 24 LTS, TS 5.9.3 (do not move to TS 7 until NestJS supports it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Local infra    | `pnpm dev:infra` — PG18+TimescaleDB+PostGIS, Valkey 8.1, MinIO. Images pinned by digest. OSRM behind `--profile routing`, Nominatim behind `--profile geocoding` (both share the Tunisia OSM extract)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| DB roles       | `dp_app` (RLS, no DDL), `dp_migrator` (owns schema), `dp_relay` (outbox-only cross-tenant). Three least-privilege identities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Migrations     | 0000–0030 applied. Forward-only, checksum-locked, immutable. See individual migration files for DDL details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| RLS            | Data tables: ENABLE+FORCE. `tenants` registry: ENABLE only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `shared/`      | config (Zod, fail-fast), database (`withTenant`), errors (`DomainError`), http (RFC 9457, `ZodValidationPipe`), crypto (`FieldCipher` AES-256-GCM), **money (`CurrencyService` + `currencies` — ISO 4217 reference, exponent cached per process)**, observability (OTel traces, `withSpan`, trace-context threading), valkey (ioredis 5.11.1)                                                                                                                                                                                                                                                                                                      |
| `platform`     | OutboxService, FeatureService, TenantService, OutboxRelayService, ValkeyStreamEventPublisher, EventPublisher port. **AuditService** — append-only trail, monthly partitions, secret redaction, `GET /v1/audit` (26 tests). **DeadLetterService** — list/replay/resolve/discard, idempotent against `processed_events` (20 tests). **OperatingConfigService** — per-tenant failure taxonomy, working hours, holidays, SLA templates, and the working-calendar arithmetic that schedules re-attempts (28 tests)                                                                                                                                      |
| `core-worker`  | Relay (FOR UPDATE SKIP LOCKED, backoff, alerts) + EventStreamConsumer (XREADGROUP, dedup, DLQ). 12 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `identity`     | Auth (Argon2id, jose, lockout, refresh rotation+reuse detection), RBAC (AuthGuard, PermissionGuard), AuthController. Provisioning+seed CLI. MERCHANT role + `users.merchant_id` sub-tenant scope (I23/I24). **COMMERCIAL role + portfolio scope (I25)** — `accountManagerScope()` derives it from `sub`+`rol`; `POST /v1/users/merchant-login` mints a MERCHANT login under `merchant:onboard`, never `user:manage`. UserService + UserController — create/list/disable/enable/reset-password, generated passwords returned once, session revocation, last-OWNER guard. **MfaService** — real TOTP (otpauth 9.5.1), two-phase enrolment, encrypted secret, single-use replay guard, hashed recovery codes, bootstrap path. **OtpService** — driver phone login, hashed single-use codes, attempt cap, per-phone rate limit, no enumeration oracle. 80 tests + 19 commercial-portfolio |
| `directory`    | MerchantService, RecipientService, AddressService. **`merchants.account_manager_id` — the COMMERCIAL who owns the account; set from ambient context on create, moved only via `PUT /v1/merchants/:id/account-manager` (`merchant:assign_manager`, audited both sides).** **Geocoding is real: self-hosted Nominatim behind the port, chained so low-confidence results fall through to a commercial provider. `GEOCODER=manual` by default.** 35 tests                                                                                                                                                                                          |
| `network`      | HubService (resolveForAddress via ST_Covers/KNN), ZoneService, GeofenceService (pure evaluate). 17 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fleet`        | VehicleService, DriverService (PII encrypted), ShiftService (privacy gate). 19 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `shipment`     | ShipmentEventService.applyTo = single status writer. ShipmentService commands (create, pickup, deliver, fail, initiateReturn, **completeReturn**, cancel) — the full RTO lifecycle (2.8). AddressBookService — the merchant's own recipients, projected from RLS-narrowed shipments (resolves RM-R1). 35 tests                                                                                                                                                                                                                                                                                                                                     |
| `pickup`       | Scan-based parcel-level custody. EXPLICIT/MERCHANT_READY selection, zero-parcel outcome reasons, offline batch sync. **`POST /:id/claim` (`pickup:claim`) — the caller takes the run themselves; collector from the token, never the body, so a COMMERCIAL never needs `pickup:assign`.** `pickup.parcel_scanned` → `pickup-scan` consumer → shipment custody. 136 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `custody`      | ManifestService (open→seal→dispatch→receive→reconcile, 4 types), HubScanService (hub inbound). Makes AT_HUB/IN_TRANSIT reachable. I14 immutability enforced by DB trigger. 76 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `dispatch`     | RouteService (create→publish→start→complete), AssignmentService. **One** NN+2-opt sequencer over an injectable cost: haversine by default, OSRM road matrix when `ROUTING_OPTIMIZER=osrm`, falling back per request. 46 tests                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `notification` | EventStreamConsumer + NotificationEventHandler (9 events: customer SMS, merchant SMS, driver PUSH) + NotificationService. **HttpSmsProvider** (vendor-neutral, circuit breaker) · **FcmPushProvider** (no firebase-admin) · **ChannelRoutingProvider** · **TemplateService** — per-tenant per-locale overrides, placeholder validation, SMS segment estimation. 29 tests                                                                                                                                                                                                                                                                           |
| `tracking`     | **telemetry:** ingest on a dedicated pool, batched writer (1000 rows/1s, bounded, sheds oldest), TimescaleDB hypertable, Valkey presence (90s TTL = the offline signal), geofence → `shipment.arrived_at_stop`. **realtime:** `wss /v1/realtime` on `@fastify/websocket`, 1Hz coalesced frames, tenant-verified subscriptions, Valkey pub/sub across replicas. 59 tests                                                                                                                                                                                                                                                                            |
| `complaint`    | ComplaintService — réclamation lifecycle, per-tenant SLA, append-only trail. **COD_DISPUTE resolution posts a REVERSING ledger transaction (closes hotspot H8).** 40 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `finance`      | **Inc1:** currencies + double-entry ledger (zero-sum DEFERRABLE trigger). **Inc2:** remittance (submit/confirm/dispute). **Inc3:** settlement (draft→approve→pay with separation-of-duties) + reconciliation (cashInField, dailyReconciliation). 24 tests                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/track`   | **Public tracking page** — Next.js 16 + React 19, server-rendered, ZERO client components. ar/fr/en with locale in the PATH. 30 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/merchant`| **Merchant portal** — Next.js 16 + React 19, server-rendered with client form components. AES-256-GCM sealed session cookie (httpOnly, token never in browser JS). Dashboard, shipment CRUD, address book, ar/fr/en RTL. 17 tests                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `apps/web`     | **Dispatcher board + admin console** — Next.js 16 + React 19, server-rendered, 21 routes. Merchant write surface: register, detail + per-merchant stats, mint portal login (password shown once), reassign account manager. Pickups: claim button on ACCEPTED rows, gated on `pickup:claim`. AES-256-GCM sealed session (separate secret from merchant). Role-gated sidebar (OWNER, DISPATCHER, HUB_OPERATOR, FINANCE, PLATFORM_ADMIN). COD amounts redacted for DISPATCHER. MFA login flow (challenge + bootstrap enrolment). Dashboard, shipments, dispatch, fleet, network, merchants, pickups, custody, finance (ledger/remittances/settlements), complaints, users, audit. ar/fr/en RTL. 25 tests |
| Enforcement    | `pnpm lint:rules` — 6 fixtures. `.semgrep.yml` — 10 custom rules. `pnpm sast`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| CI/CD          | 5 jobs + ci-passed gate. Actions pinned by SHA. Dependabot + terraform fmt/validate job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Terraform      | DigitalOcean per docs/09 §2 — VPC, LB, managed PG18 (PostGIS+Timescale) + Valkey, 2 app droplets, OSRM compute, Spaces. `staging` and `production` compose the same four modules                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Key design decisions & traps

**Full reference:** [docs/design-decisions.md](./docs/design-decisions.md) (architectural rationale) · [docs/traps.md](./docs/traps.md) (implementation pitfalls).

Most critical rules (the ones that cause silent data corruption or total feature failure if violated):

- **GPS ping ≠ business event.** Raw telemetry never touches the outbox; only geofence ENTER crosses into the business plane
- **Two sub-tenant roles, two different scope shapes.** MERCHANT → one merchant, `app.current_merchant_id` from the token's `mid` (0020, I24); token without `mid` → rejected. COMMERCIAL → a *set* of merchants via `merchants.account_manager_id`, `app.current_account_manager_id` (0030, I25), derived from `sub`+`rol` and never a claim. `merchants` uses a direct-comparison predicate; every other table an EXISTS — swapping them recurses forever
- **Neither may be combined with another role.** Wider permissions + narrower visibility reads as data loss, not misconfiguration
- **Request id must be UUID** — Fastify `genReqId` on the adapter, not pino's (which is silently ignored). Default `req-1` → 500 on every audited mutation
- **MFA bootstrap:** challenge token alongside `MFA_ENROLMENT_REQUIRED`, `TenantContext.run()` in controller for `@Public()` routes
- **RLS predicates: `CASE`, not `OR`** — SQL doesn't short-circuit; `''::uuid` errors
- **`AuditService.record` / `OutboxService.publish` take the caller's tx** — never their own
- **Notification routes keyed on EVENT name** (`shipment.return_initiated`), never status name (`shipment.return_pending`)
- **COD on return/cancel → `cod_status = 'CANCELLED'`**, not PENDING (inflates cash-in-field) or NOT_APPLICABLE (destroys amount)
- **Per-tenant defaults seeded at provisioning** (`TenantService.provision`), never migration `CROSS JOIN tenants`
- **Migration + FORCE RLS:** seed BEFORE enabling FORCE; back-fill via `NO FORCE` … `FORCE` (DML filtered, constraint validation not)
- **Never pipe `pnpm sast` to `tail`** — pipeline exit status is last command's
- **Each Next app needs its own `apps/<app>/.env.local`** — Next loads env from the app dir, not the repo root. Nest's `envFilePath` resolves against CWD for the same reason: `[".env", "../../.env"]`
- **Never rotate a refresh token during a render.** `cookies().set()` throws in a Server Component, and the API revokes the whole family on reuse — a render spends the token, cannot store the replacement, and the next request is locked out permanently. Rotation belongs in a Route Handler (`session/refresh`); `currentSession()` only redirects there
- **A layout `redirect()` does not protect its pages.** Layout and page render concurrently, so the page throws first and returns 500. Guard routes in **`src/proxy.ts`** — Next 16 renamed `middleware.ts` and warns on the old name; the handler is the DEFAULT export. It checks cookie PRESENCE only, never validity
- **Never cast a GUC to uuid without `NULLIF(setting, '')`.** `CASE` guarantees ordered evaluation of *scalar* branches only — an `EXISTS` inside a branch becomes a SubPlan the executor may run regardless, so the cast hits `''` and raises 22P02 on every non-scoped request. Cost one migration (0031) to learn
- **`set_config(…, true)` not `SET LOCAL`**. Drizzle errors: walk `.cause` chain. PostGIS: never select raw geography. `REVOKE` for restrictions. `inArray()` not `= ANY($1::uuid[])`. Events self-contained. OTel = first import. Finance accounts lazy. Ledger zero-sum DEFERRABLE. Never re-export `@Module` from barrel

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
