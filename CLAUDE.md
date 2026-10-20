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

## Current state (updated 2026-10-19)

**Everything green:** `pnpm build` → ok · `pnpm test` → 1604/1604 (1381 api + 39 track + 47 merchant + 101 web + 36 driver) · `pnpm typecheck` → 0 (incl. `test/`) · `pnpm format:check` → 0 · `pnpm docs:spell` → 0 · MFA sign-in verified end to end · `pnpm lint` → 0 · `pnpm lint:rules` → 6/6 · `pnpm knip` → 0 · `pnpm sast` → 0 (443 targets, all four apps tracked and covered).

⚠️ `pnpm sast` scans **git-tracked files only** — an untracked app is silently invisible to it. Never pipe it to `tail`: the pipeline's exit status is the last command's, which hid a `RuleParseError` behind a green tick.

**You can log in for real:** `pnpm db:seed` → `POST /v1/auth/login` → token → `/v1/auth/me`.

### Done

| Area            | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo        | pnpm + Turborepo, Node 24 LTS, TS 5.9.3 (do not move to TS 7 until NestJS supports it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Local infra     | `pnpm dev:infra` — PG18+TimescaleDB+PostGIS, Valkey 8.1, MinIO (pinned by digest). OSRM `--profile routing`, Nominatim `--profile geocoding` (Tunisia OSM)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| DB roles        | `dp_app` (RLS, no DDL), `dp_migrator` (owns schema), `dp_relay` (outbox-only cross-tenant). Three least-privilege identities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Migrations      | 0000–0052 applied. Forward-only, checksum-locked, immutable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| RLS             | Data tables: ENABLE+FORCE. `tenants` registry: ENABLE only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Tenant FKs      | All 55 tenant-scoped FKs are composite `(tenant_id, id)` (0035/0036). 7 tests, one fails if a single-column FK reappears                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `shared/`       | config, documents, database (`withTenant`), errors (`DomainError`), http (RFC 9457, `ZodValidationPipe`, `requestFingerprint`), crypto (`FieldCipher`), money (`CurrencyService` ISO 4217), observability (OTel), valkey (ioredis 5.11.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `platform`      | Outbox, Feature, Tenant, Relay, EventPublisher. AuditService (append-only, monthly partitions). DeadLetterService. OperatingConfigService (failure taxonomy, working hours, holidays, SLA). 74 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `core-worker`   | Relay (FOR UPDATE SKIP LOCKED, backoff, alerts) + EventStreamConsumer (XREADGROUP, dedup, DLQ). 12 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `identity`      | Auth (Argon2id, jose, lockout, refresh rotation+reuse). RBAC. MERCHANT (I23/I24) + COMMERCIAL (I25) scopes. MfaService (TOTP). OtpService (driver phone login). UserService. 99 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `directory`     | Merchant, Recipient, Address services. COMMERCIAL ownership. Nominatim geocoding (`GEOCODER=manual`). MerchantApplicationService (202 for duplicates, 30/hr cap). AddressCorrectionService (0051: ≤2 km APPLIED, >2 km PENDING_REVIEW, idempotent). 76 tests                                                                                                                                                   |
| `network`       | Hub (ST_Covers/KNN), Zone, Geofence, City (normalised keys, bulk resolve, collision guard). 57 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `fleet`         | Vehicle, Driver (PII encrypted), Shift (own-only privacy gate, 0049). 19 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `shipment`      | `applyTo` = single status writer. Commands: create/pickup/deliver/fail/return/cancel. AddressBook, ParcelState (CSV `csvCell`), Amendment (one PENDING per parcel, COD refuses once COLLECTED). PodMediaService (0052: presigned PUT, magic bytes, SHA-256, malware port). `shared/storage`. 87 tests                                                               |
| `pickup`        | Scan-based parcel custody. EXPLICIT/MERCHANT_READY, zero-parcel reasons, offline batch sync, claim. `pickup.parcel_scanned` → shipment custody. 136 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `custody`       | ManifestService (open→seal→dispatch→receive→reconcile, 4 types), HubScanService. I14 immutability (DB trigger). 76 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `dispatch`      | Route (create→publish→start→complete), Assignment, bon de distribution. NN+2-opt sequencer (haversine/OSRM). DriverSyncService (per-item results, SHA-256 manifest versioning, feature flags). Money as strings+exponent. 51 tests                                                                                                                                                                             |
| `notification`  | 10 events. SMS (circuit breaker), FCM (no firebase-admin), SMTP (TLS 465, header-injection guard). EMAIL = merchant docs only. ChannelRouting (defaults console). TemplateService (per-tenant/locale, SMS segments). 29 tests                                                                                                                                                                                                           |
| `tracking`      | Telemetry (batched 1000/1s, TimescaleDB, Valkey presence 90s, geofence→arrived_at_stop). Realtime (`wss`, 1Hz, Valkey pub/sub). 59 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `support`       | QUESTION/CLAIM tickets, INTERNAL notes via RLS. Gapless `S-2026-00001`. Layer 3. 26 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `inventory`     | Consumables only. Append-only movements, VIEW level (`security_invoker`). OUT refuses negative except STOCKTAKE. Layer 3. 20 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `note`          | Staff remarks (shipment/merchant/driver). Immutable body (trigger), exclusive FKs. Layer 3. 22 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `complaint`     | Réclamation lifecycle, per-tenant SLA. COD_DISPUTE → REVERSING ledger tx (H8). 40 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `finance`       | Ledger (double-entry, zero-sum DEFERRABLE), remittance, settlement (separation-of-duties), reconciliation, invoices+credit notes (gapless, row-locked counter, TVA+timbre, printable A4), expenses (double-entry, HUB_CASH), bon de paiement. 113 tests                                                                                                                                                   |
| `apps/track`    | Public tracking — Next.js 16, server-only, ar/fr/en. 30 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/merchant` | Merchant portal — Next.js 16, sealed session. Dashboard, shipment CRUD, address book, `/register`. ar/fr/en RTL. 17 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/driver`   | Driver app (2026-10-19). **M1:** background location (expo-location, SQLCipher queue, shift-bound, OTP, Play disclosure). **M2:** full driver surface: onboarding, Today, stops, delivery (COD→sig/photo→name), failure, returns, scanner, pickups, cash+handover, profile. Offline outbox (`src/core/outbox.ts`: media first, per-parcel order, escalation). ar/fr/en RTL. 36 tests. **Field test not yet run** — docs/driver-field-test.md |
| `apps/web`      | Dispatcher board + admin — Next.js 16, 21 routes. Merchant CRUD, printable dockets, CSV import, SMS templates, zones, villes, pickups, MFA, role-gated sidebar (5 roles, COD redacted for DISPATCHER). Invoicing, amendments, applications, état colis, stock, expenses, support, notes, settings, badges. ar/fr/en RTL. 35 tests                                                                                                                                                                                                                                                                        |
| Enforcement     | `pnpm lint:rules` — 6 fixtures. `.semgrep.yml` — 10 custom rules. `pnpm sast`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CI/CD           | 5 jobs + ci-passed gate. Actions pinned by SHA. Dependabot + terraform fmt/validate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Terraform       | DigitalOcean — VPC, LB, managed PG18+Valkey, 2 droplets, OSRM, Spaces. `staging`+`production` × 4 modules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Key design decisions & traps

**Full reference:** [docs/design-decisions.md](./docs/design-decisions.md) · [docs/traps.md](./docs/traps.md).

Critical rules (silent data corruption or total feature failure if violated):

- **Driver = the login, never the body (I26).** Deliver/fail/return-complete resolve `drivers.id` from the token `sub` (`drivers (tenant_id, user_id)` unique, 0043). Deliver/fail also require the parcel to be in that driver's custody. An illegal transition reports SHIPMENT_INVALID_TRANSITION ahead of the 403. Test fixtures use `seedDriverLogin` and send `out_for_delivery` WITH `driverId`
- **Pickup collector = a USER (I27).** `assigned_driver_id`/`scanned_by_driver_id` hold user ids (0044). `assign` takes a `drivers.id` and stores its login. Only the assignee scans/collects. `pickup.parcel_scanned` carries `collectorUserId` + `driverId` (drivers.id or null)
- **Driver = the ROLE claim, never the login channel (F1).** `commandContextOf` and `TenantContextInterceptor` key on `roles.includes("DRIVER")`; `principal.actorType` only says how the session was opened
- **Driver read scope in RLS (I28, 0045).** `app.current_driver_id` via `withTenant`; ownership = `shipments.last_driver_id` (ONLY `applyTo`). No driver record → `NO_DRIVER` → empty. Child tables: `EXISTS` on parent. Routes by `routes.driver_id` (0047); stops only while a leg is visible (0048). Remittance: `assertRemitsOwnCash`. Shifts: `assertStartsOwnShift` (0049)
- **Idempotency is bound (I29, 0046).** `runCommand`: key ↔ shipment+caller+command+fingerprint. Replay → `Idempotency-Replayed: true`; mismatch → 422. `shipment-snapshot.ts` tracks columns (compile-time proof)
- **App-minted persisted ids: `generateUuidV7(tx)`** (PG `uuidv7()`), e.g. ledger `transactionId`, `attemptId`. Session/family/request ids stay `randomUUID()` (opaque v4 by design)
- **CI gates include `pnpm typecheck` (tests too), `pnpm format:check`, `pnpm docs:spell`, `pnpm audit --audit-level high`.** Run them locally; `pnpm build` does not type-check `test/`
- **Security overrides in `pnpm-workspace.yaml`**: exact versions, one reason per entry. ⚠️ `@nestjs/platform-fastify` pins its own `fastify` — `pnpm why fastify -r` must show ONE version. Fix vulnerable transitive with `pnpm update -r --depth Infinity <pkg>` first
- **GPS ping ≠ business event.** Raw telemetry never touches the outbox; only geofence ENTER crosses into the business plane
- **Two sub-tenant scopes.** MERCHANT → `app.current_merchant_id` from `mid` (0020, I24). COMMERCIAL → `account_manager_id` (0030, I25). `merchants` direct-compare; other tables EXISTS — swapping recurses forever. Neither combines with another role
- **Route `:id` / `:*Id` = UUID, checked by the global `UuidParamPipe`** (APP_PIPE in IdentityModule) → 400, never a 500 from the cast. Name a non-UUID param for what it is (`:code`, `:slug`)
- **Workload badges permission-gated per queue** (`QUEUE_PERMISSION`). Unguarded count on tenant-wide tables leaks to drivers/merchants
- **Request id must be UUID** — Fastify `genReqId` on the adapter, not pino's (silently ignored). Default `req-1` → 500 on every audited mutation
- **MFA bootstrap:** challenge token alongside `MFA_ENROLMENT_REQUIRED`, `TenantContext.run()` in controller for `@Public()` routes
- **RLS predicates: `CASE`, not `OR`** — SQL doesn't short-circuit; `''::uuid` errors
- **`AuditService.record` / `OutboxService.publish` take the caller's tx** — never their own
- **Invoice numbers from row-locked counter, never `nextval()`.** Gaps = destroyed invoice to auditor. `SELECT … FOR UPDATE` on `invoice_sequences`. ⚠️ Concurrency test on COLD sequence proves nothing — issue one first
- **Decimal → minor units by STRING arithmetic, never `Math.round(x * 10 ** n)`.** Use `toMinorUnits()`
- **⚠️ FK checks bypass RLS.** All 55 tenant-scoped FKs are composite. Rules: (a) `MATCH SIMPLE` skips NULL; (b) `ON DELETE SET NULL` must name its column (`SET NULL (child_id)`) or it nulls `tenant_id` too
- **CSV formula injection:** cells starting `=+−@\t\r` get apostrophe prefix. `csvCell` in `shipment/domain/parcel-state-csv.ts`
- **Unauthenticated endpoints answer identically** whether or not input is recognised (no enumeration oracle)
- **City matched on NORMALISED key.** `normaliseCityKey` (NFD, strip diacritics, fold Arabic). `search_keys` via `searchKeysFor` only
- **Array params: `ARRAY[$1,$2]::text[]`**, not `${jsArray}` — untyped binding fails at plan time
- **VAT on SUBTOTAL** (not per line), rounded half away from zero; timbre fiscal added after tax, never taxed
- **Notification routes keyed on EVENT name** (`shipment.return_initiated`), never status name
- **COD on return/cancel → `cod_status = 'CANCELLED'`**, not PENDING (inflates cash-in-field) or NOT_APPLICABLE (destroys amount)
- **Per-tenant defaults seeded at provisioning** (`TenantService.provision`), never via migration `CROSS JOIN tenants`
- **Migration + FORCE RLS:** seed BEFORE enabling FORCE; back-fill via `NO FORCE` … `FORCE`
- **Never pipe `pnpm sast` to `tail`** — pipeline exit status is last command's
- **Each Next app needs its own `apps/<app>/.env.local`** — Next loads env from app dir. Nest's `envFilePath` resolves against CWD: `[".env", "../../.env"]`
- **CSP needs a per-request NONCE in `proxy.ts`**, never a static header. `script-src 'self'` blocks Next's inline hydration. Set policy on REQUEST header too, or Next can't find the nonce
- **Server Action refreshes in place; only a render redirects.** Redirecting from action = blank form, no error. `canPersistCookies()` probes with no-op cookie write
- **Sidebar: `sticky top-0` alongside `h-dvh`** — `h-dvh` alone scrolls panel away
- **Normalise phone input in UI.** Tunisians type `24201314`, not `+21624201314`. `toE164()` in `apps/web/src/lib/phone.ts`; API stays strict
- **⚠️ GREEN TESTS ≠ APP BOOTS.** Suites construct by hand. `app-module.spec.ts` compiles both `AppModule` and `WorkerModule`. Cross-module data: RLS-filtered query, not cross-module injection
- **`RequirePermissions` controllers cannot live in `platform`** (layer 0) — cycle. Settings/flags served from identity, implemented in platform
- **Narrower `GRANT` doesn't revoke** — use `REVOKE`. `ALTER DEFAULT PRIVILEGES` grants dp_app full DML. 0042 revoked explicitly
- **Never rotate refresh token during a render.** `cookies().set()` throws in SC; rotation in Route Handler only (`session/refresh`)
- **Layout `redirect()` doesn't protect pages** — guard in **`src/proxy.ts`** (Next 16 middleware). Cookie PRESENCE only
- **`NULLIF(setting, '')` before casting GUC to uuid.** `CASE` doesn't short-circuit SubPlan. Migration 0031
- **ioredis `error` handler must throttle** — fires every reconnect (~2s). `ConnectionErrorLog` throttles by CODE (not message — address alternates), 30s restatement, recovery `info`
- **Dead dependency → API 500.** `fetch failed`/`cannot resolve tenant`: check ports 5432/6379/9000 first. ⚠️ Docker Desktop won't start → NEVER "Reset to factory defaults" (destroys volumes). Re-register: `wsl --import-in-place docker-desktop "$env:LOCALAPPDATA\Docker\wsl\main\ext4.vhdx"`
- **Misc:** `set_config(…, true)` not `SET LOCAL`. Drizzle: walk `.cause`. PostGIS: no raw geography. `inArray()` not `= ANY(…)`. OTel = first import. Ledger zero-sum DEFERRABLE. Never re-export `@Module` from barrel

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

| #   | Document                                                          | Contents                                                   |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| 01  | **[01-mvp-scope.md](./docs/01-mvp-scope.md)**                     | MVP boundary, ADR-005, roles, entities, MENA requirements  |
| 02  | **[02-domain-model.md](./docs/02-domain-model.md)**               | Frozen entities, lifecycles, state machines, 17 invariants |
| 03  | **[03-event-storming.md](./docs/03-event-storming.md)**           | 30+ events, 17 commands, 21 policies, read models          |
| 04  | [04-context-map.md](./docs/04-context-map.md)                     | 12 bounded contexts → NestJS modules, layering             |
| 05  | [05-api-contracts.md](./docs/05-api-contracts.md)                 | Request/response JSON, error registry, WebSocket           |
| 06  | [06-database-design.md](./docs/06-database-design.md)             | Tables, indexes, RLS policies, retention                   |
| 07  | [07-security-architecture.md](./docs/07-security-architecture.md) | Threat model, tenant isolation, OWASP                      |
| 08  | [08-frontend-architecture.md](./docs/08-frontend-architecture.md) | Four apps, i18n/RTL, offline-first driver app              |
| 09  | [09-infrastructure.md](./docs/09-infrastructure.md)               | Cloud, CI/CD, observability, DR                            |
| 10  | [10-development-roadmap.md](./docs/10-development-roadmap.md)     | V2+ sequencing (superseded by 01 for MVP)                  |

Reference: [architecture-blueprint.md](./docs/architecture-blueprint.md) (ADRs 001–004), [technology-decisions.md](./docs/technology-decisions.md), [api-strategy.md](./docs/api-strategy.md), [traps.md](./docs/traps.md).

---

## Architecture summary

- **NestJS modular monolith** (`core-api` + `core-worker`). Go/Python deferred (ADR-005).
- **Tunisia/MENA market.** COD is P0. Arabic/French/English, RTL first. **TND = 3 decimal places** — read exponent from `currencies`, never ×100.
- **Android-only driver app** at MVP. No iOS.
- **No AI/ML.** Deterministic substitutes only.
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
