# Delivery Management Platform — Project Instructions

## Current phase: IMPLEMENTATION AUTHORIZED — Stage S0 (foundations)

Authorized 2026-07-22. Build within these limits:

1. **Follow [01-mvp-scope.md](./docs/01-mvp-scope.md) and ADR-005.** NestJS modular monolith only. **Do not create Go or Python services.**
2. **Do not build out-of-scope features.** If a request falls outside 01-mvp-scope §4, say so and ask before building it.
3. **S0 first:** monorepo, CI, Testcontainers, Terraform, PostgreSQL, tenancy/RLS, auth/RBAC, outbox, OpenTelemetry, module boundaries. Feature work waits for the S0 gate.
4. **SMS:** build only the `NotificationProvider` abstraction and config structure. Provider selection and sender-ID registration are handled separately and must never block development.
5. Anything ambiguous → ask, don't assume.

---

## Current state (updated 2026-07-22)

**Everything green:** `pnpm verify` → exit 0 · `pnpm test` → 79/79 · `pnpm build` → ok · `pnpm sast` → 0 findings.

**You can log in for real:** `pnpm db:seed` provisions a Tunisian courier tenant + OWNER, prints a password and a login curl. Verified: seed → `POST /v1/auth/login` → token → `/v1/auth/me`.

### Done

| Area               | State                                                                                                                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo           | pnpm workspaces + **Turborepo** (`turbo.json`, remote-cache-ready). Node 24 LTS, TypeScript **5.9.3 (do not move to TS 7 until NestJS supports it)**                                                                                                                                      |
| Local infra        | `pnpm dev:infra` — PG18 + TimescaleDB 2.28.3 + PostGIS 3.6.4, Valkey 8.1, MinIO. Images pinned **by digest**. OSRM behind `--profile routing` (needs a Maghreb extract first)                                                                                                             |
| DB roles           | `dp_app` (NO BYPASSRLS, no DDL) vs `dp_migrator` (owns schema). Verified.                                                                                                                                                                                                                 |
| Migrations         | `0000` tenants+tenant_features, `0001` tenants-registry RLS fix, `0002` identity. Runner: `apps/api/src/shared/database/migrator.ts` — forward-only, checksum-locked (**applied migrations are immutable**)                                                                               |
| RLS                | Tenant-scoped **data** tables: ENABLE **+ FORCE**. The `tenants` **registry**: ENABLE only (the control plane must be able to provision).                                                                                                                                                 |
| `shared/`          | config (Zod-validated, fail-fast), database (`DatabaseService.withTenant`), errors (`DomainError` hierarchy), http (`ProblemDetailsFilter` RFC 9457, `ZodValidationPipe`)                                                                                                                 |
| `modules/platform` | Complete: schema (`tenants`, `tenant_features`, `outbox`), `OutboxService` (publishes in caller's tx), `FeatureService` (fail-closed flags), `TenantService.provision`. Migration `0003` = outbox.                                                                                        |
| Provisioning       | `identity.ProvisioningService` (tenant + owner atomically). `pnpm db:seed` CLI. Runs on the migration connection (control-plane; `dp_app` has only SELECT on `tenants`).                                                                                                                  |
| `modules/identity` | Complete: permissions catalogue, `PasswordService` (Argon2id + custom `needsRehash` PHC parser), `TokenService` (jose), `AuthService` (login, lockout, refresh rotation + reuse detection), `AccessService`, `AuthGuard`, `PermissionGuard`, `TenantContextInterceptor`, `AuthController` |
| Enforcement        | `pnpm lint:rules` — 6 fixtures proving boundary + invariant rules actually fire                                                                                                                                                                                                           |
| CI/CD              | `.github/workflows/ci.yml` — 5 jobs (static-analysis, test, secret-scan, dependency-audit, sast) + a `ci-passed` aggregate gate. Actions pinned by SHA. Dependabot (npm/actions/docker-compose). PR template with the DoD checklist.                                                      |
| SAST               | `.semgrep.yml` — 10 custom rules encoding this platform's invariants (tenant-context `set_config`, TND ×100, direct `shipments.status` writes, PII in logs, `Math.random` for secrets, banned `customer`). Run locally with `pnpm sast` (Docker; skips cleanly if absent).                |

### Next (in order)

1. **Outbox relay** — a worker that reads unpublished `outbox` rows in `seq` order and delivers them (Valkey Streams at MVP). `SELECT ... FOR UPDATE SKIP LOCKED`, idempotent, alerts on oldest-unpublished age. Needs Valkey wired into the app first.
2. **`directory` module** — `merchants`, `recipients` (unique on `(tenant, phone)`, snapshot on shipment), `addresses` (+ geocode confidence). Layer 1.
3. **`shipment` module** — the core aggregate: immutable `shipment_events`, status projection, state machine, POD. Layer 2. The SAST rule `no-direct-shipment-status-write` starts firing here.
4. Then `network` (hubs/zones/geofences), `fleet` (drivers/vehicles/shifts), `dispatch`.

**Note:** Valkey is in `docker-compose` and `VALKEY_URL` is configured, but no Valkey client is wired into the app yet. The outbox relay (step 1) is the first thing that needs it.

### Traps already hit — do not repeat

- **ALS + RxJS:** `TenantContext.run(state, () => next.handle())` is silently broken. The handler runs on _subscribe_, after `run()` returns. Wrap the **subscription**, not the Observable. Test exists.
- **`SET LOCAL x = $1` is invalid SQL.** Use `set_config('app.current_tenant_id', $1, true)` — the `true` is transaction-local, which PgBouncer transaction pooling requires.
- **`FORCE` RLS applies to the table owner**, so a table with only a SELECT policy becomes uninsertable by everyone.
- **Direct migrator reads of tenant-scoped tables return 0 rows** without tenant context. Use `withTenantContext()` in tests.
- **`exactOptionalPropertyTypes`:** never assign `undefined` to an optional prop — spread conditionally.
- **`eslint-plugin-boundaries` v7:** `capture` binds positionally to pattern wildcards; a leading `**` eats the capture slot. Needs `import/resolver: typescript` or every import classifies as "unknown" and rules silently pass.
- **Privileged roles (OWNER/FINANCE/PLATFORM_ADMIN) cannot log in without MFA** — fail-closed. Seed them with `mfa_enabled = true` in tests.

---

## Engineering standards — non-negotiable

These apply to **every** line of code generated in this repo.

### Correctness and completeness

- **Ship production-ready code.** No `TODO`, no `FIXME`, no `// implement later`, no stubbed function bodies, no placeholder returns. If something genuinely cannot be completed, stop and say why — do not emit a skeleton and call it done.
- **Cover every path, not just the happy one.** For each unit: valid input, invalid input, empty/null/boundary values, concurrent access, partial failure, timeout, retry, and the offline case. The driver app is offline-first — "what happens with no network" is a required answer, not an edge case.
- **Every error is handled deliberately.** No silently swallowed exceptions, no bare `catch {}`. Errors either recover, or surface as a typed domain error, or propagate — decided explicitly.
- **Verify before claiming done.** Run the lint, the types, and the tests. A rule that does not fire and a test that does not run are worse than none — they manufacture false confidence. (This exact failure already occurred once with the boundary rules; `pnpm lint:rules` exists because of it.)

### Types

- **`any` is banned.** Enforced by `@typescript-eslint/no-explicit-any`. Use `unknown` plus a narrowing guard when the shape is genuinely unknown.
- **No type assertions to escape a problem.** `as` is permitted only for genuinely unrepresentable narrowing, with a comment explaining why. Never `as any`, never `as unknown as T`.
- **Define real types for real concepts.** Domain values get named types (`TenantId`, `AmountMinor`, `TrackingNumber`), not bare `string`/`number`. A function taking four strings in a row is a bug waiting to happen.
- **No non-null assertions (`!`)** to silence the compiler. Handle the null case.
- **TypeScript strict mode plus** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noPropertyAccessFromIndexSignature`. Already configured in `tsconfig.base.json` — do not weaken them.

### One tool per job

**Never introduce a second library that does a job an existing one already does.** Two things solving one problem means two mental models, two failure modes, two upgrade paths, and inconsistent code. If a better tool exists, **replace** the incumbent and remove it — never run both.

| Job                           | Use                                                                                       | Never use alongside it                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Schema validation & types     | **Zod** — one schema drives DTO validation, OpenAPI generation, and shared frontend types | class-validator, class-transformer, Joi, Yup, ajv                                       |
| Data access                   | **Drizzle ORM**                                                                           | Prisma, TypeORM, Sequelize, Knex, raw `pg` in application code                          |
| HTTP framework                | **NestJS + Fastify adapter**                                                              | Express adapter, bare Fastify, Koa                                                      |
| Background jobs               | **BullMQ** (on Valkey)                                                                    | Agenda, bee-queue, node-cron, `setInterval`                                             |
| Event distribution            | **Transactional outbox → Valkey Streams**                                                 | RabbitMQ, Kafka (until V2), `EventEmitter2`, NestJS CQRS `EventBus`, pg `LISTEN/NOTIFY` |
| Cache / presence / rate limit | **Valkey**                                                                                | Redis client duplication, Memcached, in-process caches for shared state                 |
| Testing                       | **Vitest**                                                                                | Jest, Mocha, AVA, Chai                                                                  |
| Integration test infra        | **Testcontainers** (real PostgreSQL)                                                      | sqlite substitutes, mocked repositories, a hand-rolled compose stack                    |
| HTTP client                   | **native `fetch`**                                                                        | axios, got, node-fetch, request                                                         |
| Logging                       | **Pino** (structured JSON)                                                                | Winston, bunyan, `console.*`                                                            |
| Config                        | **Zod-validated ConfigService**                                                           | direct `process.env` reads, convict, dotenv at call sites                               |
| IDs                           | **`uuidv7()` in PostgreSQL 18 / `crypto.randomUUID`**                                     | `uuid` package, nanoid, cuid, sequential integers                                       |
| Password hashing              | **argon2 (Argon2id)**                                                                     | bcrypt, scrypt, pbkdf2                                                                  |
| Money                         | **`bigint` minor units + `Currency.exponent` + `Intl.NumberFormat`**                      | decimal.js, dinero.js, big.js, floats, hardcoded ×100                                   |
| Object storage                | **`@aws-sdk/client-s3`** (works with MinIO and Spaces)                                    | MinIO SDK, s3fs, provider-specific clients                                              |
| Observability                 | **OpenTelemetry**                                                                         | bespoke metric emitters, statsd, custom trace headers                                   |
| Routing / matrices            | **OSRM** behind an adapter                                                                | direct Google/Mapbox matrix calls in business code                                      |

Adding anything to the left column, or introducing an alternative, requires an ADR in `/docs` explaining what it replaces and why.

### Performance and design

- **Prefer the faster, simpler solution** when correctness is equal — but never trade correctness, security, or tenant isolation for speed.
- **No N+1 queries.** Batch, join, or use a data loader. Hot-path queries need a reviewed `EXPLAIN (ANALYZE, BUFFERS)` plan.
- **No unbounded work.** Every list endpoint paginates, every queue consumer has concurrency limits, every external call has a timeout and a circuit breaker.
- **Measure before optimising**, then keep the measurement.

### Security (see [07-security-architecture.md](./docs/07-security-architecture.md))

- Validate at the boundary with Zod in `strict` mode; reject unknown properties.
- Parameterised queries only. Never string-concatenate SQL.
- No secrets in code, images, or committed files.
- Never log PII. Structured logging with a redaction layer.
- Every mutating endpoint: authenticated, authorized, object-level ownership checked, idempotent.

---

## Documents

### Build sequence (numbered — read in order)

| #   | Document                                                          | Contents                                                                                                                                            |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | **[01-mvp-scope.md](./docs/01-mvp-scope.md)**                     | **Authoritative MVP boundary** — ADR-005 (reduced topology), in/out scope, roles, entities, MENA requirements, success metrics, timeline            |
| 02  | **[02-domain-model.md](./docs/02-domain-model.md)**               | **Frozen entities** — 17 entities with fields, relationships, business rules, lifecycles; aggregate map; 17 cross-entity invariants; state machines |
| 03  | **[03-event-storming.md](./docs/03-event-storming.md)**           | **Source of truth for the event-driven design** — 30+ events with producer/consumers/payload, 17 commands, 21 policies, read models, hotspots       |
| 04  | [04-context-map.md](./docs/04-context-map.md)                     | 12 bounded contexts → NestJS modules; ownership, layering, import rules, extraction order                                                           |
| 05  | [05-api-contracts.md](./docs/05-api-contracts.md)                 | Concrete request/response JSON for every MVP endpoint; error registry; WebSocket protocol                                                           |
| 06  | [06-database-design.md](./docs/06-database-design.md)             | Tables, indexes, constraints, partitioning, RLS policies, retention, Timescale hypertables                                                          |
| 07  | [07-security-architecture.md](./docs/07-security-architecture.md) | Threat model, authN/authZ, **tenant isolation deep-dive**, encryption, fraud controls, OWASP mapping, CI gates                                      |
| 08  | [08-frontend-architecture.md](./docs/08-frontend-architecture.md) | Four apps, i18n/RTL architecture, offline-first driver app, **wireframes**, performance budgets                                                     |
| 09  | [09-infrastructure.md](./docs/09-infrastructure.md)               | Cloud, containers, CI/CD, observability, DR, cost model                                                                                             |
| 10  | [10-development-roadmap.md](./docs/10-development-roadmap.md)     | V2 → Enterprise sequencing. **Superseded by 01-mvp-scope.md for the MVP phase**                                                                     |

### Reference (unnumbered — background and rationale)

| Document                                                      | Contents                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture-blueprint.md](./docs/architecture-blueprint.md) | Master rationale — market analysis, ADR-001 (architecture), ADR-002 (real-time transport), ADR-003 (routing tools), **ADR-004 (event backbone)**, risks, business answers |
| [technology-decisions.md](./docs/technology-decisions.md)     | Language/framework analysis, version pinning, official documentation sources                                                                                              |
| [api-strategy.md](./docs/api-strategy.md)                     | API conventions and rationale behind 05 (versioning, idempotency, pagination)                                                                                             |
| ~~ai-strategy.md~~                                            | **DEFERRED — no AI/ML in the system. Reference only; do not implement.**                                                                                                  |

**Read 01 → 02 → 03 before proposing any change.** Everything downstream derives from the domain model and event catalog; changing one without the others creates contradictions.

---

## Architecture summary (authoritative decisions)

- **Hybrid architecture split by runtime profile, not business domain.** Target state: one NestJS modular monolith (`core-api`) plus three specialist services extracted because their runtime characteristics differ irreconcilably — `tracking-gateway` (Go), `optimization-service` (Go + OSRM/VROOM), `ml-service` (Python).
- **At MVP the specialists are deferred (ADR-005).** MVP ships **TypeScript only**: `core-api` + `core-worker` + OSRM. Telemetry and realtime live as modules inside `core-api`, behind the same boundary rules and a separate connection pool, so extraction later is mechanical. Extraction triggers are in [01-mvp-scope.md §3](./docs/01-mvp-scope.md#3-adr-005--mvp-deployment-topology).
- **Market is Tunisia/MENA.** COD is P0. Arabic/French/English with **RTL from the first screen**. **TND has 3 decimal places** — minor-unit conversion must read the currency exponent from the `currencies` table, never hardcode ×100.
- **Android-only driver app** at MVP. No iOS.
- **No AI/ML anywhere in the system** (decision 2026-07-22). Use deterministic substitutes: OSRM for ETAs, historical-median SQL for service time, rule-based checks for fraud. Do not introduce models, inference services, or LLM calls without an explicit new decision.
- **PostgreSQL 18 + PostGIS is the system of record.** TimescaleDB for telemetry, Valkey for ephemeral state. **MongoDB is not used** — see technology-decisions.md §6.1.
- **Events, not point-to-point calls.** Transactional outbox → Valkey Streams (MVP) → Redpanda (V2). Publishers never know their consumers.
- **Custody is an append-only event log**; `shipments.status` is a derived projection, never mutated directly.
- **Tenant isolation is enforced by PostgreSQL RLS**, not by application code alone.
- **Complexity is deferred with numeric triggers**: no Kubernetes, Kafka, MQTT, or feature store at MVP.

---

## Non-negotiable conventions (apply to all future code)

- Money: **integer minor units + explicit ISO 4217 currency**. Never floats.
- Time: **`TIMESTAMPTZ` in UTC**; every location entity carries an IANA timezone.
- Units: distances in **metres**, durations in **seconds**. Never mixed.
- Identifiers: **UUIDv7** externally. Sequential integers are never exposed in an API.
- Every tenant-scoped table has `tenant_id NOT NULL` + a forced RLS policy.
- Tenant context is set with **`SET LOCAL`** inside the request transaction — never `SET` (it leaks across pooled connections).
- Every mutating endpoint requires an **`Idempotency-Key`**.
- Every event carries **`tenant_id`**, `event_id`, `correlation_id`, and is named `domain.fact` in **past tense**.
- Every consumer is **idempotent on `event_id`**.
- Cross-module imports of another module's internals are **forbidden** and enforced by lint. Import from the module barrel only.
- **No business logic branches on a literal `tenantId`.** Per-tenant differences go through `TenantFeature` flags — fail-closed, checked in the API guard, the UI, _and_ event consumers.
- UI layout uses **CSS logical properties only** (`ms-4`, never `ml-4`) — Arabic RTL is a first-class layout, not an afterthought.
- Every ML prediction and every solver call has a **documented, always-available fallback**.
- **Pin all versions.** No `latest`, no floating ranges in production manifests.
- No secrets in the repo, in images, or in committed env files.

---

## Working preferences

- Consult the **official documentation for the pinned version** before implementing against any technology. Sources are listed in technology-decisions.md §9.
- For significant decisions, present 2–3 alternatives with trade-offs and a recommendation.
- Prefer small, reversible commits over large refactors.
- If uncertain or missing context, list what is needed and stop rather than guessing.
- Open questions requiring business input are tracked in blueprint §12 and in each document's "Open Items" table.
