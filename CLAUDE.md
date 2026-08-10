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

## Current state (updated 2026-08-09)

**Everything green:** `pnpm build` → ok · `pnpm test` → 1371/1371 (1212 api + 39 track + 33 merchant + 87 web) · MFA sign-in verified end to end · `pnpm lint` → 0 · `pnpm lint:rules` → 6/6 · `pnpm knip` → 0 · `pnpm sast` → 0 (443 targets, all four apps tracked and covered).

⚠️ `pnpm sast` scans **git-tracked files only** — an untracked app is silently invisible to it. Never pipe it to `tail`: the pipeline's exit status is the last command's, which hid a `RuleParseError` behind a green tick.

**You can log in for real:** `pnpm db:seed` → `POST /v1/auth/login` → token → `/v1/auth/me`.

### Done

| Area | State |
|---|---|
| Monorepo | pnpm + Turborepo, Node 24 LTS, TS 5.9.3 (do not move to TS 7 until NestJS supports it) |
| Local infra | `pnpm dev:infra` — PG18+TimescaleDB+PostGIS, Valkey 8.1, MinIO. Images pinned by digest. OSRM behind `--profile routing`, Nominatim behind `--profile geocoding` (both share the Tunisia OSM extract) |
| DB roles | `dp_app` (RLS, no DDL), `dp_migrator` (owns schema), `dp_relay` (outbox-only cross-tenant). Three least-privilege identities |
| Migrations | 0000–0042 applied. Forward-only, checksum-locked, immutable |
| RLS | Data tables: ENABLE+FORCE. `tenants` registry: ENABLE only |
| Tenant FKs | All 55 tenant-scoped FKs are composite `(tenant_id, id)` (0035/0036). 7 tests, one fails if a single-column FK reappears |
| `shared/` | config (Zod), documents (`BASE_PRINT_CSS`, `DocumentLocale`, `directionOf`, `formatDocumentDate`), database (`withTenant`), errors (`DomainError`), http (RFC 9457, `ZodValidationPipe`), crypto (`FieldCipher` AES-256-GCM), money (`CurrencyService` + `currencies` ISO 4217), observability (OTel, `withSpan`), valkey (ioredis 5.11.1) |
| `platform` | OutboxService, FeatureService, TenantService, OutboxRelayService, ValkeyStreamEventPublisher, EventPublisher port. AuditService (append-only, monthly partitions, 26 tests). DeadLetterService (list/replay/resolve/discard, 20 tests). OperatingConfigService (failure taxonomy, working hours, holidays, SLA, calendar arithmetic, 28 tests) |
| `core-worker` | Relay (FOR UPDATE SKIP LOCKED, backoff, alerts) + EventStreamConsumer (XREADGROUP, dedup, DLQ). 12 tests |
| `identity` | Auth (Argon2id, jose, lockout, refresh rotation+reuse detection), RBAC (AuthGuard, PermissionGuard). MERCHANT role + `users.merchant_id` (I23/I24). COMMERCIAL role + portfolio scope (I25) — `accountManagerScope()`. MfaService (real TOTP, two-phase enrolment, encrypted secret, hashed recovery codes). OtpService (driver phone login, hashed codes, attempt cap, rate limit). UserService + UserController. 80+19 tests |
| `directory` | MerchantService, RecipientService, AddressService. `merchants.account_manager_id` — COMMERCIAL ownership. Self-hosted Nominatim geocoding (`GEOCODER=manual` default). MerchantApplicationService — applications as own entity; approving creates the merchant; public intake returns 202 for duplicates (no enumeration oracle); 30/hr per-tenant cap. 60 tests |
| `network` | HubService (ST_Covers/KNN), ZoneService, GeofenceService. CityService — per-tenant coverage+tariff, `normaliseCityKey` (accents+Arabic forms→GIN `search_keys`), bulk resolve, collision guard. 57 tests |
| `fleet` | VehicleService, DriverService (PII encrypted), ShiftService (privacy gate). 19 tests |
| `shipment` | ShipmentEventService.applyTo = single status writer. Commands: create, pickup, deliver, fail, initiateReturn, completeReturn, cancel (full RTO). AddressBookService. ParcelStateService — état colis: grouped query pivoted in TS, CSV with formula-injection defence (`csvCell`). ShipmentAmendmentService — one PENDING per parcel, COD refuses once COLLECTED, publishes `shipment.amended`. 61 tests |
| `pickup` | Scan-based parcel-level custody. EXPLICIT/MERCHANT_READY selection, zero-parcel outcome reasons, offline batch sync. `POST /:id/claim` (`pickup:claim`). `pickup.parcel_scanned` → consumer → shipment custody. 136 tests |
| `custody` | ManifestService (open→seal→dispatch→receive→reconcile, 4 types), HubScanService. I14 immutability (DB trigger). 76 tests |
| `dispatch` | RouteService (create→publish→start→complete), AssignmentService. Bon de distribution (driver sign-off, ordered stops, refuses no-driver or mixed currencies). NN+2-opt sequencer: haversine default, OSRM when `ROUTING_OPTIMIZER=osrm`. 46 tests |
| `notification` | EventStreamConsumer + NotificationEventHandler (10 events). HttpSmsProvider (circuit breaker), FcmPushProvider (no firebase-admin), SmtpEmailProvider (hand-rolled SMTP, implicit TLS 465, header-injection guard). EMAIL = merchant-document channel only. ChannelRoutingProvider (defaults all to console). TemplateService (per-tenant/locale, placeholder validation, SMS segment estimation). 29 tests |
| `tracking` | Telemetry: dedicated pool, batched writer (1000/1s), TimescaleDB hypertable, Valkey presence (90s TTL), geofence→`shipment.arrived_at_stop`. Realtime: `wss /v1/realtime` on `@fastify/websocket`, 1Hz coalesced frames, Valkey pub/sub. 59 tests |
| `support` | Threaded tickets (QUESTION) and complaints (CLAIM) as separate tables. INTERNAL notes hidden by RLS, not query filter. Status moves with reply; internal note moves nothing. Gapless `S-2026-00001`. Layer 3. 26 tests |
| `inventory` | Consumables (NOT parcels). Append-only movement log; level is a VIEW over `SUM(movements)` with `security_invoker`. OUT refuses negative except STOCKTAKE. Transfers: both legs or neither. Layer 3. 20 tests |
| `note` | Staff remarks on shipment/merchant/driver. Body immutable (trigger). Subject = three exclusive composite FKs (`num_nonnulls = 1`). Pin, resolve/reopen. Layer 3. 22 tests |
| `complaint` | ComplaintService — réclamation lifecycle, per-tenant SLA. COD_DISPUTE resolution posts a REVERSING ledger transaction (H8). 40 tests |
| `finance` | **Inc1:** currencies + double-entry ledger (zero-sum DEFERRABLE trigger). **Inc2:** remittance (submit/confirm/dispute). **Inc3:** settlement (draft→approve→pay, separation-of-duties) + reconciliation. **Inc4:** invoices+credit notes — gapless numbering from row-locked counter, immutable once issued, per-tenant TVA+timbre fiscal, printable A4 ar/fr/en. **Inc5:** expenses — DRAFT→APPROVED posts real double-entry (DEBIT EXPENSE, CREDIT source); HUB_CASH balance. **Inc6:** bon de paiement — receipt for merchant money, shows arithmetic line by line, printable before payment. `invoice:draft`/`invoice:issue` separate permissions. 89+24 tests |
| `apps/track` | Public tracking — Next.js 16 + React 19, server-rendered, ZERO client components. ar/fr/en with locale in path. 30 tests |
| `apps/merchant` | Merchant portal — Next.js 16, AES-256-GCM sealed session cookie. Dashboard, shipment CRUD, address book, public `/register` application. ar/fr/en RTL. 17 tests |
| `apps/web` | Dispatcher board + admin — Next.js 16, 21 routes. Full merchant write surface, printable dockets, CSV bulk import, SMS templates, zones, villes tariff editor, pickups (accept/claim), MFA login, role-gated sidebar (OWNER/DISPATCHER/HUB_OPERATOR/FINANCE/PLATFORM_ADMIN). COD redacted for DISPATCHER. Invoicing UI, amendment queue, merchant applications queue, état colis report, stock management, expenses, support, notes, settings (général/options/e-mail read-only), sidebar badges (6 scalar subqueries). ar/fr/en RTL. 35 tests |
| Enforcement | `pnpm lint:rules` — 6 fixtures. `.semgrep.yml` — 10 custom rules. `pnpm sast` |
| CI/CD | 5 jobs + ci-passed gate. Actions pinned by SHA. Dependabot + terraform fmt/validate |
| Terraform | DigitalOcean — VPC, LB, managed PG18 (PostGIS+Timescale) + Valkey, 2 app droplets, OSRM compute, Spaces. `staging`+`production` compose four modules |

### Key design decisions & traps

**Full reference:** [docs/design-decisions.md](./docs/design-decisions.md) · [docs/traps.md](./docs/traps.md).

Critical rules (silent data corruption or total feature failure if violated):

- **GPS ping ≠ business event.** Raw telemetry never touches the outbox; only geofence ENTER crosses into the business plane
- **Two sub-tenant roles, two different scope shapes.** MERCHANT → one merchant via `app.current_merchant_id` from token `mid` (0020, I24); token without `mid` → rejected. COMMERCIAL → merchant set via `merchants.account_manager_id`, `app.current_account_manager_id` (0030, I25), derived from `sub`+`rol`. `merchants` uses direct-comparison; every other table uses EXISTS — swapping them recurses forever. Neither may combine with another role
- **Request id must be UUID** — Fastify `genReqId` on the adapter, not pino's (silently ignored). Default `req-1` → 500 on every audited mutation
- **MFA bootstrap:** challenge token alongside `MFA_ENROLMENT_REQUIRED`, `TenantContext.run()` in controller for `@Public()` routes
- **RLS predicates: `CASE`, not `OR`** — SQL doesn't short-circuit; `''::uuid` errors
- **`AuditService.record` / `OutboxService.publish` take the caller's tx** — never their own
- **Invoice numbers from row-locked counter, never `nextval()`.** Gaps in a tax series = destroyed invoice to an auditor. `SELECT … FOR UPDATE` on `invoice_sequences` is load-bearing. ⚠️ Concurrency test on COLD sequence proves nothing: `INSERT … ON CONFLICT DO NOTHING` serialises the burst. Issue one first
- **Decimal → minor units by STRING arithmetic, never `Math.round(x * 10 ** n)`.** `4.005 * 1000` → `4004.999…` → wrong unit price. Use `toMinorUnits()`
- **⚠️ FK checks bypass RLS.** All 55 tenant-scoped FKs are composite. Rules: (a) `MATCH SIMPLE` skips NULL; (b) `ON DELETE SET NULL` must name its column (`SET NULL (child_id)`) or it nulls `tenant_id` too
- **CSV formula injection:** cells starting `=+−@\t\r` get apostrophe prefix. `csvCell` in `shipment/domain/parcel-state-csv.ts`
- **Unauthenticated endpoints answer identically** whether or not input is recognised (no enumeration oracle)
- **City name matched on NORMALISED key.** `normaliseCityKey` NFD-decomposes, strips `\p{M}`, folds Arabic forms. `search_keys` maintained by `searchKeysFor` on every write — nothing else may set it
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
- **⚠️ GREEN TESTS ≠ APP BOOTS.** Every suite constructs by hand — proves service works, not that Nest can build it. `app-module.spec.ts` now `compile()`s both `AppModule` and `WorkerModule` (different graphs). Cross-module data: RLS-filtered query (like `InvoiceService.partiesFor`), not injecting across modules
- **Controllers with `RequirePermissions` cannot live in `platform`** (layer 0). Platform→identity import creates module cycle. Tenant settings/feature flags served from identity, implemented in platform
- **Narrower `GRANT` doesn't revoke** — use `REVOKE`. `ALTER DEFAULT PRIVILEGES` already grants dp_app full DML on future tables. 0041's `GRANT SELECT, INSERT` was insufficient; 0042 revoked explicitly
- **Never rotate refresh token during a render.** `cookies().set()` throws in Server Component; API revokes family on reuse. Rotation belongs in Route Handler (`session/refresh`); `currentSession()` only redirects
- **Layout `redirect()` doesn't protect pages** — layout and page render concurrently. Guard in **`src/proxy.ts`** (Next 16 renamed `middleware.ts`). Check cookie PRESENCE only
- **`NULLIF(setting, '')` before casting GUC to uuid.** `CASE` only guarantees scalar branch order; `EXISTS` inside becomes a SubPlan executor may run regardless. Cost migration 0031
- **An ioredis `error` handler must throttle — it fires on every reconnect attempt.** Two clients (shared + realtime subscriber) × ~2s retries = a full `AggregateError` stack four times a second for the length of an outage. When Docker was down this buried the ACTUAL failure (Postgres) under thousands of Valkey frames, so the outage read as a Valkey problem. `ConnectionErrorLog` keeps the first failure, any change of `name:code`, and a 30s restatement carrying `attempts`/`suppressed`/`outageMs`, plus one `info` on recovery. Key the throttle on the CODE, never the message — the address alternates `::1`/`127.0.0.1` between retries and would defeat it
- **A dead dependency surfaces as a 500 from the API, never as its own name.** `apps/web` showing `fetch failed` or `cannot resolve tenant`: check ports 5432/6379/9000 BEFORE reading code. ⚠️ If Docker Desktop will not start, never use Troubleshoot → "Reset to factory defaults"/"Purge data" — it deletes `docker_data.vhdx` and every named volume with it. Re-register the existing disk instead: `wsl --import-in-place docker-desktop "$env:LOCALAPPDATA\Docker\wsl\main\ext4.vhdx"`
- **`set_config(…, true)` not `SET LOCAL`**. Drizzle errors: walk `.cause` chain. PostGIS: never select raw geography. `inArray()` not `= ANY($1::uuid[])`. Events self-contained. OTel = first import. Finance accounts lazy. Ledger zero-sum DEFERRABLE. Never re-export `@Module` from barrel

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
| 01 | **[01-mvp-scope.md](./docs/01-mvp-scope.md)** | MVP boundary, ADR-005, roles, entities, MENA requirements |
| 02 | **[02-domain-model.md](./docs/02-domain-model.md)** | Frozen entities, lifecycles, state machines, 17 invariants |
| 03 | **[03-event-storming.md](./docs/03-event-storming.md)** | 30+ events, 17 commands, 21 policies, read models |
| 04 | [04-context-map.md](./docs/04-context-map.md) | 12 bounded contexts → NestJS modules, layering |
| 05 | [05-api-contracts.md](./docs/05-api-contracts.md) | Request/response JSON, error registry, WebSocket |
| 06 | [06-database-design.md](./docs/06-database-design.md) | Tables, indexes, RLS policies, retention |
| 07 | [07-security-architecture.md](./docs/07-security-architecture.md) | Threat model, tenant isolation, OWASP |
| 08 | [08-frontend-architecture.md](./docs/08-frontend-architecture.md) | Four apps, i18n/RTL, offline-first driver app |
| 09 | [09-infrastructure.md](./docs/09-infrastructure.md) | Cloud, CI/CD, observability, DR |
| 10 | [10-development-roadmap.md](./docs/10-development-roadmap.md) | V2+ sequencing (superseded by 01 for MVP) |

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
