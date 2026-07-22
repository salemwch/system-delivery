# Technology Decisions

> Covers **Phase 3** (technology stack analysis) and **Phase 11** (documentation collection).
> Parent document: [architecture-blueprint.md](./architecture-blueprint.md)
> **Status:** DRAFT — awaiting approval. Nothing installed.

---

## 1. Decision Summary

| Concern | Choice | One-line rationale |
|---|---|---|
| Core business API | **TypeScript + NestJS on Node.js 24 LTS** | Highest feature velocity for a small team; one language shared with both frontends; NestJS supplies the module boundaries ADR-001 depends on |
| GPS ingest & WebSocket fan-out | **Go 1.26** | Tens of thousands of concurrent connections at predictable memory and GC cost |
| Route optimization | **Go orchestrator + OSRM & VROOM (C++)** | CPU-bound work isolated from the request path; the solvers already exist and are excellent |
| ML / AI services | **Python 3.14 + FastAPI** | The tabular-ML ecosystem is Python; reimplementing it elsewhere is indefensible |
| Web frontends | **Next.js 16 + React 19 + TypeScript + Tailwind** | Shared language and types with the API; SSR for the public tracking page's SEO and cold-load speed |
| Driver mobile app | **React Native via Expo SDK 57 (New Architecture)** | One codebase, one language across the platform; **highest-risk choice — see §5.3** |
| System of record | **PostgreSQL 18 + PostGIS** | ACID, relational, geospatial, mature — logistics is a transactional domain |
| Telemetry store | **TimescaleDB 2.25** (PostgreSQL extension) | Time-series scale without adding a second database technology |
| Cache / presence / jobs | **Valkey 8** | BSD-licensed, Linux Foundation governed, Redis-wire-compatible, faster and cheaper on managed tiers |
| Event backbone | **Valkey Streams → Redpanda** | See [ADR-004](./architecture-blueprint.md#54-event-driven-architecture--adr-004) |
| Search | **OpenSearch 3.x** | Apache-2.0, no licensing ambiguity, sufficient for shipment and audit search |
| ORM / data access | **Drizzle ORM** | SQL-first, no hidden query generation, first-class RLS and raw-SQL support |
| Containerisation | **Docker** everywhere; **Kubernetes only from V2** | See [09-infrastructure.md](./09-infrastructure.md) |

---

## 2. Phase 3 — Backend Language Analysis

### 2.1 Evaluation matrix

Scored 1–5 for **this domain**, not in the abstract. Weights reflect what actually determines success for a 3–5 engineer team building a logistics SaaS.

| Criterion | Weight | Node.js + NestJS | Go | Java + Spring Boot | Rust |
|---|---|---|---|---|---|
| Development speed (business CRUD/workflow) | ×5 | **5** | 3 | 3 | 1 |
| Raw throughput / latency | ×3 | 3 | **5** | 4 | **5** |
| Concurrency at 10k+ connections | ×3 | 3 | **5** | 4 | **5** |
| CPU-bound compute | ×2 | 1 | 4 | 4 | **5** |
| Ecosystem for logistics/web/API | ×4 | **5** | 4 | **5** | 2 |
| ML/data-science ecosystem | ×2 | 2 | 2 | 3 | 2 |
| Hiring pool / cost | ×4 | **5** | 3 | 4 | 1 |
| Onboarding time for a new engineer | ×3 | **5** | 4 | 3 | 1 |
| Long-term maintainability of business logic | ×4 | 4 | 4 | **5** | 4 |
| Memory efficiency / infra cost | ×2 | 2 | **5** | 2 | **5** |
| Type safety (compile-time guarantees) | ×3 | 4 | 3 | 4 | **5** |
| Shared code/types with frontend | ×3 | **5** | 1 | 1 | 1 |
| Operational simplicity (deploy artifact) | ×2 | 3 | **5** | 2 | **5** |
| **Weighted total (max 200)** | | **156** | **145** | **136** | **111** |

The matrix is close between Node and Go, which is the honest result — and it is precisely why the answer is *not* "pick one."

### 2.2 Per-language assessment

**Node.js + NestJS + TypeScript**

- *Strengths:* Unmatched velocity for the CRUD-and-workflow work that constitutes ~80 % of this platform. NestJS provides opinionated modules, DI, guards, interceptors, and pipes — the structural discipline ADR-001's modular monolith requires, out of the box. One language across API, dispatcher dashboard, admin console, customer page, and driver app means shared DTOs, shared validation schemas, and an engineer who can fix a bug anywhere. Largest hiring pool at the lowest cost. NestJS 11 defaults to SWC for transpilation (much faster builds) and Vitest for testing.
- *Weaknesses:* Single-threaded event loop — one CPU-bound operation blocks every concurrent request. Higher memory per connection than Go. Runtime type erasure means validation must be explicit at every boundary. Dependency-tree size is an ongoing supply-chain surface.
- *Verdict:* **Chosen for `core-api`.** Its weaknesses are precisely the workloads we extracted into other services.

**Go**

- *Strengths:* Goroutines make 50k concurrent WebSocket connections a routine engineering problem rather than a research project. Predictable, low-latency GC (Go 1.26 enables the Green Tea collector by default). Single static binary — no runtime, tiny containers, trivial deployment. Excellent standard library for networking. Strong Kafka, MQTT, and Postgres clients.
- *Weaknesses:* More verbose for business logic; complex domain modelling is slower to write than in TypeScript. Weaker ORM story (deliberately). Smaller hiring pool than Node. Generics are still relatively young in ecosystem adoption.
- *Verdict:* **Chosen for `tracking-gateway` and the `optimization-service` orchestrator.** These are network- and CPU-shaped problems, which is exactly Go's centre of mass — and both have small, stable surface areas, limiting the cost of the second language.

**Java + Spring Boot**

- *Strengths:* The most mature enterprise ecosystem in existence; battle-tested in logistics specifically. Superb tooling, profiling, and observability. Virtual threads (Project Loom) have largely closed the concurrency gap. Very strong for large teams and long-lived codebases.
- *Weaknesses:* Highest ceremony-to-value ratio for a small team. JVM memory footprint raises infrastructure cost meaningfully at our scale. Slower iteration loop. Would introduce a language shared with nothing else in our stack.
- *Verdict:* **Rejected.** This is the right answer for a 50-engineer organisation with existing JVM operations. It is the wrong answer for a 4-engineer team optimising for time-to-first-customer. Worth revisiting only if the team's existing expertise is overwhelmingly JVM — an input we do not yet have (see Blueprint Q4).

**Rust**

- *Strengths:* Best-in-class performance and memory efficiency with compile-time memory safety. No GC pauses. Excellent for the tracking gateway in principle.
- *Weaknesses:* Development velocity for business logic is 2–4× slower than TypeScript, and the borrow checker's cost is highest exactly where the domain model is still changing — which describes every day of the first year. Hiring is genuinely difficult and expensive. Web/ORM ecosystem, while improving, remains thinner.
- *Verdict:* **Rejected.** Correct for a stable, extreme-throughput component; wrong for a system whose requirements are still being discovered. If `tracking-gateway` ever becomes both performance-critical and specification-stable, it is a small, isolated, ~5k-line candidate for rewrite — which is exactly why we isolated it.

### 2.3 Workload → language assignment

| Workload | Language | Justification |
|---|---|---|
| REST API, business rules, workflow | TypeScript / NestJS | Velocity dominates; this is where requirements churn most |
| Auth, tenancy, RBAC | TypeScript / NestJS | Belongs with the business logic it protects, and inside the RLS transaction |
| Real-time GPS ingest | Go | 10k events/sec sustained writes, connection-heavy |
| WebSocket fan-out to dispatchers | Go | 5k concurrent persistent connections |
| Route optimization | Go + C++ (OSRM/VROOM) | CPU-bound; must not share an event loop with API requests |
| AI/ML inference & training | Python | Ecosystem reality |
| Background workers (notifications, webhooks, exports) | TypeScript / NestJS | Same image as `core-api`, different entrypoint — no extra codebase |
| Outbox relay | TypeScript (MVP) → Go (V2) | Trivial at MVP; Go once throughput justifies it |
| Data/analytics transforms | SQL first, Python where SQL is insufficient | Most analytics belongs in the database, not in application code |

### 2.4 Why multi-language is justified here

The standing preference is a single language, and it is a good default. It is overridden only because **three workloads have runtime characteristics that no single runtime serves well simultaneously**: 10k concurrent sockets (Go), multi-second CPU-bound solving (C++), and gradient-boosted-tree inference (Python).

The cost is bounded deliberately:
- **~85 % of all code and ~100 % of business logic is TypeScript.** Feature work almost never crosses a language boundary.
- The Go services have **narrow, stable contracts** (telemetry ingest; optimize-route). They change rarely.
- The Python service is inference endpoints plus scheduled training jobs — no business rules.
- Every service ships as a Docker image with a uniform health-check, logging, metrics, and tracing convention, so **operationally they are identical** regardless of language.

**Reject the alternative "all-Go" or "all-TypeScript" framings:** all-Go would slow business delivery by an estimated 30–40 % and would still need Python for ML. All-TypeScript would put the GPS firehose and the solver on an event loop, which is the specific failure this architecture exists to prevent.

---

## 3. Backend Framework & Library Decisions

### 3.1 NestJS version strategy

| Consideration | Decision |
|---|---|
| Version at kickoff | **NestJS 11.1.x** (11.1.28 published 2026-07-08) |
| NestJS 12 | Targeted for early Q3 2026 — i.e. imminent. **Do not adopt at `.0`.** Re-evaluate once 12.x has ~3 months of patch releases; it modernises around ESM and refreshes default tooling, which is a migration to schedule deliberately rather than absorb during MVP |
| Node.js runtime | **Node.js 24 LTS** (Active LTS, EOL 2028-04-30) — not Node 26. Note the ecosystem shift: from October 2026 Node moves to one major per year, and all releases become LTS. Plan the Node 27 evaluation for ~Q2 2027 |
| HTTP adapter | **Fastify** rather than Express — measurably higher throughput and a better-typed plugin model; NestJS supports it as a first-class adapter |

### 3.2 Data access — ORM decision

| Option | Assessment | Verdict |
|---|---|---|
| **Drizzle ORM** | SQL-first with full TypeScript inference. Generated SQL is predictable and reviewable. Supports raw SQL, CTEs, window functions, and PostGIS types without fighting the abstraction. Lightweight migrations. **Critically: it does not obscure the `SET LOCAL` / RLS session handling our multi-tenancy depends on.** | **✅ Chosen** |
| Prisma | Best-in-class DX and schema language, but historically an opinionated query engine that makes complex geospatial and analytical SQL awkward, and adds a layer between the developer and the query plan. In a system where query performance is a scaling constraint, that opacity is a liability | ❌ |
| TypeORM | Widely used with NestJS, but a long history of correctness and maintenance concerns; decorator-heavy entity model encourages the cross-module coupling ADR-001 forbids | ❌ |
| Raw SQL + query builder only | Maximum control, but loses type safety across a large schema and slows delivery | ❌ (Drizzle gives both) |

**Non-negotiable rule regardless of ORM:** every query touching a tenant-scoped table executes inside a transaction with `SET LOCAL app.current_tenant_id`. This is enforced by a single interceptor, not by developer discipline.

### 3.3 Supporting libraries (roles, not yet pinned)

| Need | Choice | Note |
|---|---|---|
| Validation | Zod | Single schema reused for DTO validation, OpenAPI generation, and shared frontend types |
| Job queue | BullMQ on Valkey | Mature, observable, supports delayed/repeatable jobs and priorities |
| Auth primitives | Argon2id hashing, `jose` for JWT | Never hand-roll crypto |
| Testing | Vitest (NestJS 11 default), Supertest, Testcontainers | Testcontainers gives real PostgreSQL in CI — essential for testing RLS policies, which cannot be verified against a mock |
| Observability | OpenTelemetry SDK | Vendor-neutral traces/metrics/logs across all three languages |
| Feature flags / entitlements | In-house, backed by PostgreSQL + Valkey cache | Entitlements are billing-coupled; a third-party flag service is the wrong owner |

---

## 4. Frontend Decisions

| Application | Choice | Rationale |
|---|---|---|
| **Customer tracking page** | Next.js 16, server-rendered | Public, SEO-relevant, must load fast on poor mobile connections and cold caches. Server rendering also keeps the tracking token off the client bundle |
| **Dispatcher dashboard** | Next.js 16 in SPA mode (client-heavy) | A live, stateful, WebSocket-driven map application. Server rendering adds nothing; the initial payload is a shell and everything after is real-time |
| **Admin / tenant console** | Next.js 16 | Standard CRUD; shares the component library |
| React version | React 19.2 (bundled with Next.js 16) | View Transitions and `useEffectEvent` are directly useful for the dispatcher board |
| Styling | Tailwind CSS + a headless component primitive library | Dispatcher UI is dense and custom; utility-first avoids fighting a component framework's opinions |
| Client state | TanStack Query (server state) + Zustand (UI state) | Do not put server data in a global store; caching, invalidation, and refetch are TanStack Query's job |
| Maps | **MapLibre GL** with Mapbox tiles | MapLibre is BSD-licensed and avoids SDK lock-in while retaining Mapbox tile quality. Rendering 5,000 markers requires WebGL — a DOM-marker approach will not survive Tier 2 |
| Tables/virtualisation | TanStack Table + TanStack Virtual | A dispatcher list of 10,000 shipments must virtualise or the tab freezes |

**Dispatcher board performance budget** (the product's most important screen): first meaningful paint <1.5 s, marker update at 60 fps with 2,000 visible drivers, assignment action round-trip <300 ms perceived (optimistic UI with rollback).

---

## 5. Mobile Decisions

### 5.1 Framework analysis

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **React Native + Expo** | Shared TypeScript and types with the whole platform; one team maintains web and mobile; Expo SDK 57 ships React Native 0.86 with the New Architecture (Fabric/TurboModules/JSI) always enabled since SDK 55; EAS Build removes most native toolchain pain; OTA updates let us fix a driver-app bug the same day — genuinely valuable when 500 drivers are blocked | Background location and battery optimisation require native modules and careful platform-specific work; heavy background services are where cross-platform abstractions leak most | **✅ Chosen — with the mitigation in §5.3** |
| Native Kotlin + Swift | Best possible background location, battery, and OS integration | Two codebases, two skill sets, roughly 2× the mobile effort. Requires a macOS runner and iOS specialists | ❌ for MVP |
| Flutter | Excellent performance and consistent rendering | Dart is a fourth language shared with nothing else; no code or type reuse with our TypeScript platform | ❌ |
| PWA | No app stores, instant updates | Background geolocation on iOS is effectively unavailable. **Disqualifying** — the driver app's core function is background tracking | ❌ |

### 5.2 Customer-facing mobile

None at MVP. The tracking page is a mobile web page reached from an SMS link — this is the industry norm (Onfleet, DispatchTrack) and avoids asking a recipient to install an app to receive one parcel.

### 5.3 The background-location risk — stated plainly

**This is the single highest-risk technical choice in the stack.** The driver app must track location reliably in the background, across Android Doze, App Standby, aggressive OEM battery killers (Xiaomi, Huawei, Oppo are notoriously hostile), and iOS background execution limits — while not draining the battery and while satisfying both app stores' background-location review policies.

Mitigation plan:
1. **Spike this first, before any other mobile work** (Roadmap M0). Build a bare tracking app and field-test on real devices for one week, including low-end Android and aggressive-OEM handsets, before committing to the framework.
2. Use a proven, maintained background-geolocation module rather than composing one from primitives.
3. **Isolate the location layer behind an interface** in the app. If React Native proves inadequate, we replace one native module — writing the location service in Kotlin/Swift and exposing it to the RN layer — rather than rewriting the app.
4. Prepare the store-review justification, in-app disclosure, and privacy manifest entries **early** (Blueprint risk P4).
5. Define measurable acceptance criteria before the spike: <6 %/hour battery drain during an active shift, >95 % of expected GPS batches received over an 8-hour shift, and correct recovery after force-stop and device reboot.

**Decision gate:** if the spike fails these criteria, escalate to native Android-first with an explicit iOS decision (which, per the standing constraint, requires your confirmation and a macOS runner).

---

## 6. Data Layer Summary

Full design in [06-database-design.md](./06-database-design.md). Summary of *why each store exists* — a store without a distinct, defensible job is deleted:

| Store | Job | Why not something already in the stack |
|---|---|---|
| PostgreSQL 18 + PostGIS | System of record; all transactional and relational data; geospatial queries | — |
| TimescaleDB 2.25 | GPS telemetry at ~10k writes/sec with 90–95 % compression | It is a PostgreSQL **extension**, not a new database — same client, same SQL, same backups, same operational knowledge |
| Valkey 8 | Cache, driver presence, rate limiting, job queue, pub/sub fan-out, MVP event streams | Postgres cannot serve sub-millisecond presence lookups at this rate without becoming the bottleneck |
| OpenSearch 3.x | Full-text shipment search, audit-log investigation | Postgres full-text is adequate to ~10M rows; beyond that, relevance ranking and faceting on the dispatcher search bar need a real search engine. **Deferred to V2** |
| Object storage (S3-compatible) | POD photos, signatures, exports, ML artifacts | Binary blobs never belong in a relational database |
| Redpanda (V2) | Durable, replayable event log | Valkey Streams are memory-bound; ML backfill and analytics rebuild need retention measured in months |

### 6.1 Why not MongoDB as the primary store — explicitly

This is worth stating directly, since a MongoDB toolchain is present in the environment.

| Requirement | PostgreSQL | MongoDB |
|---|---|---|
| Multi-row ACID across shipment + driver + route + ledger in one dispatch decision | Native, trivial | Multi-document transactions exist but are a performance and complexity tax, and are the *normal* case here, not the exception |
| Financial correctness (COD double-entry) | Constraints, foreign keys, exact `NUMERIC`/integer minor units, serialisable isolation | Weaker constraint enforcement; correctness moves into application code, where it is untested |
| Row-Level Security for tenant isolation | **Native, database-enforced** | No equivalent. Tenant isolation would depend entirely on application code being correct — the single highest-severity risk in the platform |
| Geospatial queries (nearest driver, geofences, polygon zones) | PostGIS — the reference implementation in the industry | Geo indexes exist but are far less capable (no true geography type semantics, limited spatial predicates) |
| Time-series telemetry at 10k/sec | TimescaleDB extension | Time-series collections exist; TimescaleDB is more mature for this shape |
| Relational reporting (SLA by hub by carrier by week) | SQL, window functions, CTEs | Aggregation pipelines become unmaintainable at this complexity |
| Schema flexibility for tenant custom fields | **`JSONB` with GIN indexes** — the actual argument for a document store, already available | Native |

**Conclusion:** MongoDB's genuine advantage — flexible schemas — is fully covered by PostgreSQL's `JSONB`, while PostgreSQL's advantages (ACID, RLS, PostGIS, SQL analytics) have no MongoDB equivalent. For a transactional, money-handling, multi-tenant, geospatial domain, PostgreSQL is the correct system of record and the decision is not close.

*Where a document store would be legitimate:* a high-volume, schema-varying integration payload archive (raw inbound orders from dozens of marketplaces before normalisation). Even there, `JSONB` in a partitioned table is sufficient at our scale, and adding a database technology for one use case is a poor trade.

---

## 7. Authoritative Version Pinning

Versions verified against official sources on **2026-07-22**. Anything marked *"pin at kickoff"* changes fast enough that it should be locked to the then-current patch at project start and recorded here.

| Component | Pinned version | Support status |
|---|---|---|
| Node.js | **24.x LTS** | Active LTS, EOL 2028-04-30 |
| NestJS | **11.1.28** | Current stable; v12 deferred (see §3.1) |
| TypeScript | 5.x — pin at kickoff | — |
| Go | **1.26.5** | Current stable (2026-07-07) |
| Python | **3.14.6** | Current stable (2026-06-10); 3.15 in beta — not for production |
| PostgreSQL | **18.4** | Current stable. PG 19 in beta, GA expected ~Sep/Oct 2026 — **do not adopt at .0** |
| PostGIS | 3.x compatible with PG 18 — pin at kickoff | — |
| TimescaleDB | **2.28.x** | Requires PG 16+; we are on 18 ✅ |
| Valkey | 8.1+ | BSD-3-Clause, Linux Foundation |
| Redpanda (V2) | pin at V2 kickoff | Kafka API compatible |
| OpenSearch (V2) | 3.x | Apache-2.0 |
| Next.js | **16.2.x** | Note: a security release landed 2026-07-21 — pin to that patch or later |
| React | **19.2** | Bundled with Next.js 16 |
| Expo SDK | **57** | Ships React Native 0.86; New Architecture always enabled |
| React Native | **0.86** | Via Expo SDK 57 |
| Kubernetes (V2) | **1.35 or 1.36** | 1.36.2 current (2026-06-09); 1.34 EOL 2026-10-27. Target N-1 for stability |
| Docker Engine | pin at kickoff | — |
| OSRM | pin at kickoff (latest tagged release) | — |
| VROOM | pin at kickoff (latest tagged release) | C++20 |

**Policy:** no floating tags anywhere — no `latest`, no `^`/`~` ranges in production manifests, no unpinned base images. Lockfiles committed. Renovate/Dependabot proposes upgrades as reviewable PRs with CI gates; upgrades are never automatic in production.

---

## 8. Explicitly Rejected Technologies

| Technology | Why rejected |
|---|---|
| Microservices framework / service mesh (Istio, Linkerd) | Solves a problem we designed away in ADR-001. Revisit only past ~15 engineers |
| GraphQL as the primary API | Adds resolver complexity, caching difficulty, and query-cost attack surface. Our clients are known and few; REST + OpenAPI serves them better and is what partner integrators expect. Reconsider only as an internal BFF if dashboard over-fetching becomes measurable |
| MongoDB as system of record | See §6.1 |
| RabbitMQ | See [ADR-004](./architecture-blueprint.md#54-event-driven-architecture--adr-004) — queue, not log; no replay |
| Kafka at MVP | Correct destination, wrong timing. Redpanda at V2 |
| Kubernetes at MVP | Operational cost with no benefit at Tier 1. See [09-infrastructure.md](./09-infrastructure.md) |
| Elasticsearch (vs OpenSearch) | Licensing ambiguity; OpenSearch is Apache-2.0 and sufficient |
| Redis (vs Valkey) | Redis 8 is AGPLv3 — copyleft with real implications for a product we may distribute for self-hosting. Valkey is BSD-3 under Linux Foundation governance, faster, and cheaper on managed tiers |
| Serverless (Lambda) for the core API | Cold starts hurt the dispatcher board; persistent DB connections are awkward; long-running WebSockets are a poor fit. Appropriate only for isolated event handlers later |
| Building our own routing/VRP solver | 30 years of research already exists. Our differentiation is domain workflow, not graph algorithms |
| An LLM chatbot as a headline feature | Explicitly out of scope. See [ai-strategy.md](./ai-strategy.md) |

---

## 9. Phase 11 — Documentation Sources

**Standing instruction for implementation:** before writing code against any technology below, the official documentation for the **pinned version** must be consulted. Version-specific docs only — not blog posts, not Stack Overflow answers, not tutorial sites. Where a decision departs from official guidance, the rationale is recorded in an ADR.

### 9.1 Core backend

| Technology | Official documentation |
|---|---|
| Node.js 24 API | https://nodejs.org/docs/latest-v24.x/api/ |
| Node.js release policy | https://nodejs.org/en/about/previous-releases |
| NestJS | https://docs.nestjs.com/ |
| TypeScript | https://www.typescriptlang.org/docs/ |
| Fastify | https://fastify.dev/docs/latest/ |
| Drizzle ORM | https://orm.drizzle.team/docs/overview |
| Zod | https://zod.dev/ |
| BullMQ | https://docs.bullmq.io/ |
| Vitest | https://vitest.dev/guide/ |
| Testcontainers | https://testcontainers.com/ |

### 9.2 Go services

| Technology | Official documentation |
|---|---|
| Go language & toolchain | https://go.dev/doc/ |
| Go standard library | https://pkg.go.dev/std |
| Go 1.26 release notes | https://go.dev/doc/go1.26 |
| Effective Go | https://go.dev/doc/effective_go |
| Go concurrency patterns | https://go.dev/blog/pipelines |
| pgx (PostgreSQL driver) | https://pkg.go.dev/github.com/jackc/pgx/v5 |
| gorilla/websocket | https://pkg.go.dev/github.com/gorilla/websocket |

### 9.3 Databases

| Technology | Official documentation |
|---|---|
| PostgreSQL 18 manual | https://www.postgresql.org/docs/18/index.html |
| PostgreSQL indexing | https://www.postgresql.org/docs/18/indexes.html |
| PostgreSQL Row-Level Security | https://www.postgresql.org/docs/18/ddl-rowsecurity.html |
| PostgreSQL partitioning | https://www.postgresql.org/docs/18/ddl-partitioning.html |
| PostgreSQL performance tips | https://www.postgresql.org/docs/18/performance-tips.html |
| PostgreSQL replication | https://www.postgresql.org/docs/18/high-availability.html |
| PostGIS | https://postgis.net/documentation/ |
| TimescaleDB (Tiger Data) | https://www.tigerdata.com/docs |
| PgBouncer | https://www.pgbouncer.org/config.html |
| Valkey | https://valkey.io/topics/ |
| Valkey Streams | https://valkey.io/topics/streams-intro/ |
| OpenSearch | https://opensearch.org/docs/latest/ |

### 9.4 Messaging & events

| Technology | Official documentation |
|---|---|
| Redpanda | https://docs.redpanda.com/ |
| Apache Kafka | https://kafka.apache.org/documentation/ |
| MQTT 5.0 specification | https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html |
| EMQX broker | https://docs.emqx.com/en/emqx/latest/ |
| gRPC | https://grpc.io/docs/ |
| Protocol Buffers | https://protobuf.dev/ |
| CloudEvents (envelope reference) | https://cloudevents.io/ |

### 9.5 Routing & geospatial

| Technology | Official documentation |
|---|---|
| OSRM HTTP API | https://project-osrm.org/docs/v5.24.0/api/ |
| OSRM backend wiki (setup, profiles) | https://github.com/Project-OSRM/osrm-backend/wiki |
| VROOM | http://vroom-project.org/ |
| VROOM API & usage | https://github.com/VROOM-Project/vroom/wiki/Usage |
| Valhalla (alternative) | https://valhalla.github.io/valhalla/ |
| Mapbox platform | https://docs.mapbox.com/ |
| MapLibre GL JS | https://maplibre.org/maplibre-gl-js/docs/ |
| Google Maps Platform | https://developers.google.com/maps/documentation |
| OpenStreetMap data | https://wiki.openstreetmap.org/wiki/Downloading_data |

### 9.6 Frontend & mobile

| Technology | Official documentation |
|---|---|
| Next.js | https://nextjs.org/docs |
| React | https://react.dev/ |
| Tailwind CSS | https://tailwindcss.com/docs |
| TanStack Query | https://tanstack.com/query/latest/docs |
| Expo SDK | https://docs.expo.dev/ |
| Expo New Architecture guide | https://docs.expo.dev/guides/new-architecture/ |
| React Native | https://reactnative.dev/docs/getting-started |
| Android background location | https://developer.android.com/develop/sensors-and-location/location/background |
| Android foreground services | https://developer.android.com/develop/background-work/services/fgs |
| Apple Core Location | https://developer.apple.com/documentation/corelocation |
| Google Play location policy | https://support.google.com/googleplay/android-developer/answer/9799150 |
| Firebase Cloud Messaging | https://firebase.google.com/docs/cloud-messaging |

### 9.7 AI / ML

| Technology | Official documentation |
|---|---|
| Python 3.14 | https://docs.python.org/3.14/ |
| FastAPI | https://fastapi.tiangolo.com/ |
| LightGBM | https://lightgbm.readthedocs.io/en/stable/ |
| XGBoost | https://xgboost.readthedocs.io/en/stable/ |
| scikit-learn | https://scikit-learn.org/stable/documentation.html |
| Polars | https://docs.pola.rs/ |
| MLflow (experiment tracking) | https://mlflow.org/docs/latest/index.html |

### 9.8 Security

| Topic | Official source |
|---|---|
| OWASP ASVS | https://owasp.org/www-project-application-security-verification-standard/ |
| OWASP API Security Top 10 | https://owasp.org/API-Security/ |
| OWASP Cheat Sheet Series | https://cheatsheetseries.owasp.org/ |
| OWASP Top 10 | https://owasp.org/www-project-top-ten/ |
| GDPR text | https://gdpr-info.eu/ |
| OAuth 2.0 Security BCP | https://datatracker.ietf.org/doc/html/rfc9700 |
| JWT best practices | https://datatracker.ietf.org/doc/html/rfc8725 |
| Argon2 (password hashing) | https://datatracker.ietf.org/doc/html/rfc9106 |
| CIS Benchmarks | https://www.cisecurity.org/cis-benchmarks |

### 9.9 Infrastructure & operations

| Technology | Official documentation |
|---|---|
| Docker | https://docs.docker.com/ |
| Docker Compose | https://docs.docker.com/compose/ |
| Kubernetes | https://kubernetes.io/docs/home/ |
| Kubernetes release/support policy | https://kubernetes.io/releases/ |
| Helm | https://helm.sh/docs/ |
| Terraform | https://developer.hashicorp.com/terraform/docs |
| GitHub Actions | https://docs.github.com/en/actions |
| OpenTelemetry | https://opentelemetry.io/docs/ |
| Prometheus | https://prometheus.io/docs/introduction/overview/ |
| Grafana | https://grafana.com/docs/grafana/latest/ |
| Traefik | https://doc.traefik.io/traefik/ |
| AWS documentation | https://docs.aws.amazon.com/ |
| Sentry | https://docs.sentry.io/ |

### 9.10 API & standards

| Topic | Source |
|---|---|
| OpenAPI 3.1 specification | https://spec.openapis.org/oas/v3.1.0.html |
| JSON Schema | https://json-schema.org/specification |
| HTTP semantics (RFC 9110) | https://datatracker.ietf.org/doc/html/rfc9110 |
| Idempotency-Key header draft | https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header |
| Problem Details for HTTP APIs (RFC 9457) | https://datatracker.ietf.org/doc/html/rfc9457 |
| UUIDv7 (RFC 9562) | https://datatracker.ietf.org/doc/html/rfc9562 |
| ISO 8601 / date-time handling | https://www.iso.org/iso-8601-date-and-time-format.html |

---

## Sources

Version and status claims in §7 verified against:

- [Node.js — Previous Releases / EOL](https://endoflife.date/nodejs) · [Evolving the Node.js Release Schedule](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule) · [Node.js moves to one major release per year (InfoQ)](https://www.infoq.com/news/2026/06/nodejs-release-changes/)
- [NestJS releases](https://releasealert.dev/npmjs/@nestjs/core) · [NestJS 12 is Coming — Trilon](https://trilon.io/blog/nestjs-12-is-coming)
- [Go release history](https://go.dev/doc/devel/release) · [Go 1.26 release notes](https://go.dev/doc/go1.26)
- [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/) · [PostgreSQL 18.4 release announcement](https://www.postgresql.org/about/news/postgresql-184-1710-1614-1518-and-1423-released-3297/)
- [TimescaleDB changelog — Tiger Data](https://www.tigerdata.com/docs/get-started/news/new)
- [Valkey vs Redis licensing analysis](https://dev.to/synsun/redis-vs-valkey-in-2026-what-the-license-fork-actually-changed-1kni) · [Valkey readiness 2026](https://devops-daily.com/posts/is-valkey-ready-to-replace-redis-2026)
- [Kubernetes releases](https://kubernetes.io/releases/) · [Kubernetes EOL](https://endoflife.date/kubernetes)
- [Next.js 16](https://nextjs.org/blog/next-16) · [Next.js EOL timeline](https://endoflife.date/nextjs)
- [Expo SDK 57 changelog](https://expo.dev/changelog/sdk-57) · [Expo New Architecture guide](https://docs.expo.dev/guides/new-architecture/)
- [Python versions status](https://devguide.python.org/versions/) · [Python downloads](https://www.python.org/downloads/)
- [VROOM project](http://vroom-project.org/) · [VROOM usage wiki](https://github.com/VROOM-Project/vroom/wiki/Usage) · [PyVRP paper — VROOM solver-quality assessment](https://arxiv.org/pdf/2403.13795)
- [Fleetbase platform overview](https://fleetbase.io/platform) · [Fleetbase repository](https://github.com/fleetbase/fleetbase/blob/main/README.md)
