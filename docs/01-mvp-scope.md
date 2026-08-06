# MVP Scope Definition

> The authoritative boundary of the first release. Where this document and [10-development-roadmap.md](./10-development-roadmap.md) disagree on team size or scope, **this document wins** — it is written against the confirmed business answers in [blueprint §12](./architecture-blueprint.md#12-open-questions-requiring-business-input).
> **Status:** DRAFT — awaiting approval. No implementation has begun.
> **Date:** 2026-07-22

---

## 1. Confirmed Business Context

| Question | Answer | Consequence for MVP |
|---|---|---|
| Q1 Market | **Tunisia + MENA** | COD is **P0, not optional**. Arabic/French/English + **RTL from day one**. Informal address formats are a first-class problem, not an edge case |
| Q2 Model | **Multi-hub courier network with linehaul** | Hub, leg, and manifest entities exist in the MVP schema. Execution starts simple but the model does not get retrofitted |
| Q3 Delivery | **Pure SaaS, multi-tenant** | RLS isolation from commit one. No self-hosting constraints — we may use managed services freely |
| Q4 Team | **Founder + AI-assisted development** | **The defining constraint.** Scope and language count must both shrink. See [ADR-005](#3-adr-005--mvp-deployment-topology) |
| Q5 Budget | **Balanced; managed services, avoid premature enterprise infra** | Docker Compose + managed PostgreSQL + managed Valkey + object storage. No Kubernetes, no Kafka |
| Q6 Pilot data | **None yet; collect first, model later** | Zero ML in MVP. MVP's ML deliverable is *correct instrumentation* |
| Q7 Compliance | **Security-first, no certification yet** | OWASP ASVS L2 practices, audit logs, encryption, GDPR-inspired. No SOC 2 evidence collection burden |
| Q8 Mobile | **Android-first** | No iOS build, no macOS runner, no Apple review cycle in MVP |

---

## 2. MVP Thesis

> **A real Tunisian courier company can run one full operating day on this platform — import the day's shipments, dispatch them to drivers across hubs, track the drivers live, capture proof of delivery, and reconcile every dinar of collected cash to zero variance before closing.**

Everything that does not serve that sentence is out of scope. This is deliberately narrower than the 17 capabilities in the original brief, because a solo founder shipping a *working* delivery day in 5 months beats shipping 40 % of seventeen features in twelve.

---

## 3. ADR-005 — MVP Deployment Topology

**Status:** Proposed · **Date:** 2026-07-22 · **Amends:** [ADR-001](./architecture-blueprint.md#4-phase-2--architecture-decision-adr-001) for the MVP phase only

### Context

ADR-001 specified four deployables in three languages (TypeScript, Go, Python), justified by *runtime profile* — GPS ingest, CPU-bound solving, and ML inference each being irreconcilable with a request/response API runtime. That reasoning was calibrated to a 3–5 engineer team.

Q4 changes the input: **one founder with AI assistance.** ADR-001's own logic must now be applied honestly to the MVP's actual numbers.

### The numbers at MVP scale

| Workload | Tier 1 load | Does it justify extraction? |
|---|---|---|
| GPS ingest | **~40 events/sec**, 200 drivers | **No.** Node.js handles this without noticing. The 170:1 write-ratio problem is real at Tier 3 and irrelevant at Tier 1 |
| WebSocket fan-out | **~20 concurrent dispatchers** | **No.** Node handles 20 sockets trivially. The goroutine argument begins at thousands |
| Route optimization | **~50 runs/day**, single-vehicle sequencing | **No.** OSRM (a separate process regardless) does the heavy lifting. A nearest-neighbour + 2-opt sequencer in TypeScript runs in milliseconds for ≤40 stops |
| ML inference | **Zero** — no models until V2 (Q6) | **No.** There is nothing to serve |

### Decision

**The MVP ships as one TypeScript deployable plus OSRM.** Go and Python are deferred until their own trigger conditions fire.

| MVP deployable | Contents |
|---|---|
| `core-api` (NestJS) | All business domains **plus** a `telemetry` module (GPS ingest) and a `realtime` module (WebSocket gateway) |
| `core-worker` | Same image, queue-consumer entrypoint: notifications, outbox relay, retention jobs, scheduled reconciliation |
| `osrm-backend` | Off-the-shelf container, Tunisia + Maghreb OSM extract |
| Managed PostgreSQL 18 + PostGIS + TimescaleDB · Managed Valkey · Object storage | |

**This eliminates two languages and two services from the MVP without changing the target architecture.**

### What makes this safe rather than a shortcut

The extraction path is preserved *mechanically*, not by intention:

1. The `telemetry` and `realtime` modules obey the same **module-boundary lint rules** as every other module — no cross-module internal imports.
2. They communicate with the rest of the system **only through events and published service interfaces**, exactly as a separate service would.
3. **The telemetry ingest endpoint is versioned and transport-agnostic from day one** (`POST /v1/telemetry`, batched, idempotent). Extracting it to Go later means reimplementing one endpoint behind the same contract, not untangling business logic.
4. Telemetry writes go to the **TimescaleDB hypertable through a dedicated connection pool**, physically separate from the transactional pool. The plane separation from [Blueprint §5.2](./architecture-blueprint.md#52-request-path-separation-the-critical-diagram) — the actual load-bearing decision — is preserved even inside one process.

### Extraction triggers (revisit ADR-005 when any fires)

| Extract | When |
|---|---|
| `tracking-gateway` → Go | GPS ingest >500 events/sec sustained, **or** >500 concurrent WebSocket clients, **or** telemetry load measurably affects API p99 |
| `optimization-service` → Go + VROOM | Multi-vehicle VRP required (V2.1), **or** any optimization run exceeds 2 s |
| `ml-service` → Python | **Not scheduled** — no AI/ML in the system (decision 2026-07-22). Would require reversing that decision first |

### Consequences

- **Positive:** one language, one test suite, one deploy, one debugging context. Realistic for solo development. Roughly 6–8 weeks of calendar time saved versus the original four-service MVP.
- **Negative:** a CPU spike in sequencing could briefly affect API latency. Mitigated by capping synchronous optimization at 40 stops and pushing anything larger to the worker queue.
- **Accepted risk:** if growth is faster than expected, extraction becomes urgent. The triggers above are monitored from launch, so this is a scheduled event rather than a surprise.

---

## 4. In Scope

### 4.1 Platform & tenancy

| # | Feature | Priority | Notes |
|---|---|---|---|
| 1.1 | Tenant provisioning, configuration, suspension | P0 | Automated and idempotent |
| 1.2 | RLS-enforced tenant isolation + cross-tenant test suite | P0 | Built first; blocks everything |
| 1.3 | Users, roles, permissions (fixed role set — see §6) | P0 | Custom roles deferred |
| 1.4 | Auth: email/password (Argon2id) + phone/OTP for drivers | P0 | |
| 1.5 | MFA (TOTP) for owner and finance roles | P1 | |
| 1.6 | Audit log (append-only) | P0 | |
| 1.7 | **i18n: Arabic (RTL), French, English** | P0 | Retrofitting RTL is a full UI rework — see §7 |
| 1.8 | Per-tenant config: timezone, currency, working hours, failure reasons, SLA templates | P0 | Config is data, never code |

### 4.2 Shipments

| # | Feature | Priority | Notes |
|---|---|---|---|
| 2.1 | Shipment CRUD | P0 | |
| 2.2 | **Immutable `shipment_events` custody log + status projection** | P0 | Status is never mutated directly |
| 2.3 | Validated state machine | P0 | |
| 2.4 | Multi-leg model (schema), single- and two-leg execution | P0 | Hub-and-spoke per Q2 |
| 2.5 | CSV/Excel bulk import with actionable rejections | P0 | How merchants actually deliver orders in this market |
| 2.6 | Manual shipment entry | P0 | |
| 2.7 | Failure reasons + re-attempt scheduling | P0 | |
| 2.8 | Return-to-origin (RTO) basic lifecycle | P1 | High return rates are normal in COD markets |
| 2.9 | Address model, geocoding, confidence scoring | P0 | See §7 |
| 2.10 | **Driver geocode correction feedback loop** | P0 | Elevated from V2 — essential given MENA address quality |
| 2.11 | **Pickup requests** (`REQUESTED → ACCEPTED → ASSIGNED → COLLECTED → COMPLETED/CANCELLED`) | P0 | Added 2026-07-22. Sits upstream of shipments — this is how parcels actually enter the system ([§3.18](./02-domain-model.md#318-pickuprequest)) |
| 2.12 | **Recipient book** — reusable receiver directory, shipments reference it | P0 | Added 2026-07-22. Removes re-typing and accumulates address quality per person ([§3.19](./02-domain-model.md#319-recipient)) |
| 2.13 | **Complaints / réclamations** — basic operational tracking | P0 | Added 2026-07-22. `COD_DISPUTE` type drives ledger reversal ([§3.20](./02-domain-model.md#320-complaint)) |
| 2.14 | **Delivery document generation** — bon de livraison, bon d'envoi, bon de retour (printable PDF) | P1 | Added 2026-07-22. Paper documents are standard practice in Tunisian courier operations |
| 2.15 | **Parcel label + QR/barcode generation** | P0 | Added 2026-07-29. The `trackingNumber` already exists and every scan path consumes it; nothing rendered it. Without a printable code the scan-based custody chain (2.11, 3.2) cannot start — a driver cannot scan a parcel that has no label |
| 2.16 | **Merchant portal** — merchant users log in, create their own parcels, print labels, track them, and see COD owed | P0 | **Added 2026-07-29, reversing the V2 deferral in §5.** See the note below |

> **Reversal note (2026-07-29) — merchant-facing login moved from V2 into MVP.**
>
> §5 previously deferred merchant logins on the assumption that *"the tenant dashboard is operated by courier staff at MVP"* — merchants would email CSVs and staff would key them in (which is why 2.5 is P0).
>
> That assumption does not match how the business actually runs. The merchant (*expéditeur*) is the one who knows the recipient, the address, and the COD amount; he packs the box and needs a label on it **before** he carries it to the depot. Making courier staff re-key that data moves the error to the party with the least context, and leaves the merchant with no answer to the question he asks most: *how much money am I owed?*
>
> What is **not** reversed: merchants still do not self-register. The courier company provisions each merchant account and hands over the credentials — there is a commercial relationship before there is a login. Public signup stays V2.
>
> Cost of the reversal is small because the domain model was already built for it: `merchants` is per-tenant, `MERCHANT_PAYABLE` is per-merchant, `merchantStats(merchantId)` exists, and `createShipment` already takes recipient + COD. What was missing was the access layer, not the data.

### 4.3 Dispatch & tracking

| # | Feature | Priority | Notes |
|---|---|---|---|
| 3.1 | Driver, vehicle, shift management | P0 | |
| 3.2 | Hub management + hub-to-hub transfer with manifest scan | P0 | Minimal but real |
| 3.3 | **Dispatcher board: live map, shipment list, manual assignment** | P0 | Largest single build. The product's centre of gravity |
| 3.4 | Route + stop sequencing (OSRM + nearest-neighbour/2-opt) | P0 | Single vehicle |
| 3.5 | Batched GPS ingest → TimescaleDB | P0 | |
| 3.6 | Live driver positions via WebSocket (coalesced, viewport-scoped) | P0 | |
| 3.7 | Geofence → `arrived_at_stop` events | P1 | |
| 3.8 | Zone/territory definition | P1 | |

### 4.4 Driver app (Android)

| # | Feature | Priority | Notes |
|---|---|---|---|
| 4.1 | Auth, offline-first local queue | P0 | |
| 4.2 | Background location with adaptive sampling | P0 | Highest technical risk |
| 4.3 | Route manifest + stop sequence | P0 | |
| 4.4 | Barcode/QR scanning (pickup, hub, delivery) | P0 | |
| 4.5 | **POD: signature, photo, recipient name, GPS stamp** | P0 | |
| 4.6 | COD collection recording | P0 | |
| 4.7 | Failure reason capture + reschedule | P0 | |
| 4.8 | **One-tap call recipient** | P0 | In MENA courier work, calling before arrival is the norm, not a fallback |
| 4.9 | Offline sync, idempotent submission, conflict handling | P0 | |
| 4.10 | Navigation hand-off to Google Maps / Waze | P0 | We do not build turn-by-turn |
| 4.11 | Arabic/French UI + RTL | P0 | |
| 4.12 | Battery diagnostics screen | P1 | Reduces drivers disabling tracking |

### 4.5 Money (COD)

| # | Feature | Priority | Notes |
|---|---|---|---|
| 5.1 | **Double-entry ledger: accounts, entries, zero-sum invariant** | P0 | |
| 5.2 | COD collected → driver cash liability | P0 | |
| 5.3 | Hub remittance with variance detection | P0 | |
| 5.4 | Merchant settlement records | P0 | |
| 5.5 | Cash-in-field dashboard | P0 | "How much cash is out there right now?" |
| 5.6 | Daily reconciliation report | P0 | |
| 5.7 | **Currency-aware minor units** | P0 | **TND has 3 decimal places** — see §7 |

### 4.6 Customer & notifications

| # | Feature | Priority | Notes |
|---|---|---|---|
| 6.1 | Public tracking page (token-scoped, minimal PII, AR/FR/EN) | P0 | |
| 6.2 | SMS on key transitions | P0 | |
| 6.3 | Driver push notifications (FCM) | P0 | |
| 6.4 | Notification templates per tenant per language | P1 | |

### 4.7 Foundations carried despite no immediate payoff

Cheap now, cross-cutting migrations later. Each is explicitly justified:

| # | Item | Why it cannot wait |
|---|---|---|
| 7.1 | Transactional outbox + event envelope + relay | Retrofitting reliable publication touches every write path |
| 7.2 | Idempotency on all mutating endpoints | The offline driver app *will* retry; without this, duplicate COD |
| 7.3 | Multi-leg + hub schema | Retrofitting is a schema-wide migration (risk D8) |
| 7.4 | `tenant_id` + RLS on every table | Cannot be retrofitted at all |
| 7.5 | `occurred_at` vs `recorded_at` on every event | **SLA correctness.** A delivery made at 14:02 and synced at 14:47 must be measured against 14:02, or every offline delivery is wrongly recorded as late. Not an AI requirement |
| 7.6 | Plan-vs-actual capture on routes and stops | **Operational reporting** — were we on time, and how long do stops actually take? Also powers historical-median service time, which is a SQL query, not a model |
| 7.7 | Structured failure reason codes | **Re-attempt workflow and failure reporting.** Free-text reasons cannot drive automation or be counted |
| 7.8 | OpenTelemetry tracing with `correlation_id` | Async fan-out is undebuggable without it |
| 7.9 | Terraform for all infrastructure | Click-ops cannot be disaster-recovered |

---

## 5. Explicitly Out of Scope

| Excluded | Why | Returns in |
|---|---|---|
| iOS driver app | Q8 — Android-first | When customer demand requires |
| Multi-vehicle VRP optimization | Manual assignment + single-vehicle sequencing proves the loop first | V2.1 |
| **All AI / ML features** | **Explicit decision (2026-07-22): no AI in the system for now.** Also Q6 — no historical data exists. [ai-strategy.md](./ai-strategy.md) is deferred reference only | **Not scheduled.** Requires a new decision |
| Go `tracking-gateway`, `optimization-service` | ADR-005 — load does not justify them at Tier 1 | Trigger-based (§3) |
| Python `ml-service` | No AI/ML in the system | Not scheduled |
| Kubernetes, Kafka/Redpanda, MQTT, OpenSearch, feature store | Q5 — premature | Trigger-based |
| Merchant **public self-registration** (a merchant signing themselves up) | Accounts are provisioned by the courier company, who has a commercial relationship with each merchant first. Public signup needs an approval flow and tenant assignment that nothing else in the MVP requires | V2 |
| Public partner API + webhooks + SDKs | No integration partners yet | V2.11 |
| Billing, invoicing, usage metering, plan entitlements | Pilot tenants are contracted manually | V2.15 |
| Customer self-scheduling / reschedule | High value, but not on the critical loop | V2.12 |
| Fleet maintenance, fuel, inspections, telematics | Not required to deliver a parcel | V3.5 |
| **Stock / inventory management** (*gestion de stock*) | Confirmed out 2026-07-22 — warehouse management is a different product | V3.11 |
| **Bonus / incentive distribution** (*bonus de distribution*) | Confirmed out 2026-07-22 | V3 |
| **Expense tracking** (*les dépenses*) | Confirmed out 2026-07-22 — accounting software's job | V3 |
| **Full merchant billing & invoicing** (*factures*) | Confirmed out 2026-07-22. Settlement records exist; invoice generation does not | V2.15 |
| 3PL / carrier brokering | Own-fleet only at MVP | V3.4 |
| Advanced analytics dashboards | Basic operational reports only | V2.14 |
| SSO / SAML | No enterprise tenants yet | V2.18 |
| Multi-currency per tenant | Single currency per tenant (TND) | V3.9 |
| Digital payment at door | Cash only at MVP | V3.9 |
| Warehouse / inventory module | Different product | V3.11 |
| Low-code workflow builder | Configuration, not code generation | V3.8 |
| Custom roles / fine-grained permission editor | Fixed role set at MVP | V2 |
| Driver performance scoring | Ethical + regulatory scope; descriptive only later | V2.19 |
| Self-hosting distribution | Q3 — pure SaaS | Not planned |
| Read replicas, PgBouncer, multi-region | Single primary suffices at Tier 1 | Trigger-based |

---

## 6. MVP User Roles

Eight roles, fixed. Custom role definition is deferred.

| Role | Who | Core capability |
|---|---|---|
| **Platform Admin** | Us | Cross-tenant provisioning, support, impersonation **with mandatory audit + tenant notification** |
| **Tenant Owner** | Courier company owner | Everything within their tenant, including finance and user management |
| **Dispatcher** | Operations staff | Shipments, assignment, routes, live tracking, exceptions. **No COD amounts** |
| **Hub Operator** | Sorting-centre staff | Scan in/out, manifests, hub transfers, driver cash remittance intake |
| **Finance** | Accounting staff | Ledger, COD reconciliation, settlements, financial reports. **Read-only on operations** |
| **Driver** | Field courier | Own route only, own shipments only, POD, COD collection, own metrics |
| **Merchant** | The *expéditeur* — the shipper handing parcels to the courier | **Own merchant only.** Create and track own parcels, print own labels, see own COD owed and settlements. No route, driver, fleet, or other-merchant visibility whatsoever |
| **Commercial** | The field salesperson who calls on the *expéditeur* (added 2026-08-05) | **Own portfolio only.** Sign merchants up, mint their portal login, request and physically collect their parcels, and follow those accounts' volume and COD. No routes, drivers, hubs, manifests, ledger, address book, or other commercials' accounts |

*Customers hold no account* — access is via an unguessable, expiring, single-shipment tracking token.

> **Two roles are scoped BELOW the tenant, and they are scoped differently.** Every other role sees the whole tenant, so RLS on `tenant_id` alone isolates them.
>
> - A **Merchant** must see only their own rows inside a tenant that also holds their competitors' parcels — carried as `users.merchant_id`, matched against each row's `merchant_id` (invariant I24).
> - A **Commercial** must see only the merchants they manage — a *set*, not one, resolved through `merchants.account_manager_id` rather than carried in the token (invariant I25).
>
> Both are enforced in Row-Level Security, not by remembering to add a `WHERE` clause. Getting either wrong leaks one merchant's volume, customers, and revenue to someone with no business seeing them.
>
> **A commercial deliberately cannot read `recipients`.** The address book is tenant-scoped by design (RM-R1) and carries no merchant, so RLS cannot narrow it — granting the read would hand the courier's entire customer list to the one role most likely to leave for a competitor.

### Permission matrix (abbreviated)

| Capability | Owner | Dispatcher | Hub Op | Finance | Driver | Merchant | Commercial |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Create/edit shipment | ✅ | ✅ | ➖ | ❌ | ❌ | ➖ own only | ❌ |
| Print parcel label / QR | ✅ | ✅ | ✅ | ❌ | ❌ | ➖ own only | ➖ portfolio |
| Assign shipment to driver | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| View live driver location | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| View driver location **history** | ✅ | ➖ audited | ❌ | ❌ | own only | ❌ | ❌ |
| Scan at hub / manage manifest | ✅ | ➖ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Capture POD | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| Record COD collection | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| Accept cash remittance | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| View COD amounts / ledger | ✅ | ❌ | ➖ own hub | ✅ | own only | ➖ own owed | ➖ portfolio COD |
| Request pickup | ✅ | ✅ | ➖ | ❌ | ❌ | ➖ own only | ➖ portfolio |
| **Collect parcels at the merchant** | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ |
| Assign a pickup **to someone else** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Claim a pickup for themselves** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ➖ portfolio |
| **Register a merchant** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Mint a merchant portal login** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ➖ portfolio |
| **Assign a merchant's commercial** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Read the recipient address book | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Post ledger adjustment | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Manage users & roles | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Override shipment status | ✅ | ➖ audited | ❌ | ❌ | ❌ | ❌ | ❌ |
| Export customer PII | ✅ | ❌ | ❌ | ➖ audited | ❌ | ➖ own only | ❌ |

✅ full · ➖ limited/audited/own-scoped · ❌ denied

**Five deliberate choices:**

1. **Dispatchers do not see COD amounts.** They do not need them, and excluding them shrinks the blast radius of the most numerous and least-hardened account type.
2. **Finance is read-only on operations.** Separation of duties — whoever reconciles cash must not also be able to alter delivery status to hide a discrepancy.
3. **A merchant sees money but not operations.** Their own COD balance and settlements, never a route, a driver, or another merchant. A merchant is a customer of the tenant, not a member of it.
4. **A commercial mints logins through `merchant:onboard`, never `user:manage`.** Onboarding an *expéditeur* has to create credentials, but `user:manage` creates them for any role — a commercial holding it could mint themselves an OWNER. `merchant:onboard` can only ever produce a MERCHANT login, for a merchant they already manage.
5. **A commercial cannot reassign accounts.** Ownership moves under its own permission held by the OWNER alone; otherwise a salesperson could help themselves to a colleague's book of business, which is exactly what the portfolio scope exists to prevent.

---

## 7. Regional Requirements — Tunisia / MENA

These follow directly from Q1 and are **not** generic i18n boilerplate. Each is a real design constraint.

### 7.1 Currency — the sharpest trap

**The Tunisian Dinar (TND) has three decimal places.** 1 TND = 1,000 millimes; ISO 4217 exponent is 3, not 2.

Consequences:
- Minor-unit conversion **must read the currency's exponent from a table.** Any hardcoded `× 100` produces a **1,000× error** on Tunisian money — 12.500 TND stored as 1,250 instead of 12,500.
- `currency` is stored alongside every monetary amount; display formatting is derived from the exponent, never assumed.
- Regional neighbours differ: TND and LYD use 3 decimals; MAD, EGP, DZD, AED, SAR use 2. A MENA-focused platform will encounter both.
- **A unit test asserting correct TND round-tripping is a P0 acceptance criterion for the ledger.**

### 7.2 Addresses

Street addressing in Tunisia and much of MENA is inconsistent — many destinations are identified by landmark, neighbourhood, and a phone call rather than a precise street number.

| Requirement | Rationale |
|---|---|
| **Recipient phone is mandatory**, validated to E.164 | It is the real addressing mechanism in practice |
| One-tap call from the driver app (feature 4.8) | Drivers call before arrival as standard procedure |
| `access_notes` free-text, shown prominently to the driver | Landmarks, floor, gate colour — genuinely how deliveries succeed |
| Geocode confidence scoring; **low confidence blocks auto-dispatch** | Prevents routing a whole day against a bad pin |
| **Driver geocode correction promoted to MVP** (feature 2.10) | Each correction permanently improves that address. Over a year this becomes a real competitive asset a newcomer cannot buy |
| Arabic and Latin script in the same address field | Normal, not exceptional |

### 7.3 Language & layout

- **Arabic (RTL), French, English.** French is the dominant business language in Tunisia; Arabic is essential for drivers and customers.
- **RTL must be built in from the first screen.** Retrofitting RTL to a dispatcher board full of maps, tables, and timelines is effectively a UI rewrite — this is why it is P0 rather than a later polish item.
- Per-user language preference; notification templates per tenant per language.
- Arabic-Indic numeral display as a user preference; storage always Western Arabic numerals.

### 7.4 Operations

| Requirement | Rationale |
|---|---|
| Configurable weekend (Fri/Sat vs Sat/Sun) | Varies across MENA |
| **Ramadan working-hours profile** | Working hours shift substantially for a month each year; hardcoded shift assumptions break annually |
| Local holiday calendar per tenant | Affects SLA and demand |
| High re-attempt and RTO rates as the norm | COD markets see far higher refusal rates than card-prepaid markets — the failure workflow is a primary path, not an exception |

### 7.5 Infrastructure & compliance

- **SMS deliverability in Tunisia is an open procurement item** (§11 MVP1). Twilio coverage and pricing in the Maghreb is weaker than in Europe; a local aggregator is likely required. **This is on the critical path — the platform cannot notify customers without it.**
- Hosting region: EU (Frankfurt/Paris) gives the best latency to Tunisia while keeping GDPR-aligned posture.
- Tunisia's data protection law (Law 2004-63, INPDP) applies to personal data processed locally — lighter than GDPR, but our GDPR-inspired design (Q7) satisfies it. Confirm registration obligations before launch.

---

## 8. MVP Database Entities

Detailed specifications in [06-database-design.md](./06-database-design.md). This is the MVP subset.

### 8.1 Included

| Group | Entities |
|---|---|
| Tenancy & access | `tenants`, `tenant_config`, **`tenant_features`**, `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `sessions`, `audit_log` |
| Catalogue | `merchants`, **`recipients`**, `hubs`, `zones`, `geofences`, `addresses` |
| Intake & support | **`pickup_requests`**, **`complaints`**, `complaint_activities` |
| People & assets | `drivers`, `vehicles`, `shifts` |
| Core shipment | `shipments`, `shipment_events`, `shipment_legs`, `shipment_items`, `delivery_attempts` |
| Execution | `routes`, `route_stops`, `manifests`, `manifest_items` |
| Proof | `pod`, `pod_artifacts` |
| Money | `ledger_accounts`, `ledger_entries`, `cod_remittances`, `settlements`, `currencies` |
| Platform mechanics | `outbox`, `idempotency_keys`, `tracking_tokens`, `notification_log`, `fraud_flags` |
| Telemetry (TimescaleDB) | `driver_positions` (hypertable) + continuous aggregates `driver_activity_5m`, `route_progress_15m` |

**`currencies` is a real table, not an enum** — it holds the ISO 4217 exponent that §7.1 depends on.

### 8.2 Deferred

`webhook_subscriptions`, `webhook_deliveries`, `api_keys`, `usage_records`, `invoices`, `carriers`, `carrier_rates`, `ml_features`, `model_versions`, `predictions`, `driver_scores`, `vehicle_maintenance`, `inventory_*`, `raw_integration_payloads`

> **`tenant_features` moved from deferred to included.** Feature gating is not a billing feature — it is the mechanism that stops per-tenant differences becoming conditional logic scattered through the codebase. It costs one table and one guard at MVP; retrofitting it after two tenants with different needs means unpicking `if` statements from every module. Billing *entitlements* (plan → price → invoice) remain V2; the flags themselves ship now.

### 8.3 Invariants enforced at MVP

1. Every tenant-scoped table: `tenant_id NOT NULL` + **forced** RLS policy with `USING` and `WITH CHECK`.
2. `shipment_events`, `ledger_entries`, `audit_log`: **no `UPDATE`/`DELETE` grants** to the application role.
3. Every `ledger_entries.transaction_id` group sums to zero per currency.
4. Every monetary column paired with a `currency` FK; amounts are `BIGINT` minor units.
5. `UNIQUE (tenant_id, idempotency_key)` on every client-submitted event.
6. All timestamps `TIMESTAMPTZ`; every hub and address carries an IANA timezone.
7. Partitioning from day one: `shipment_events` and `audit_log` monthly; `driver_positions` as a Timescale hypertable.

---

## 9. MVP Success Metrics

### 9.1 Product — is it actually usable?

| Metric | Target | Why |
|---|---|---|
| A pilot courier runs a **full operating day** with no spreadsheet fallback | Achieved | The thesis in §2. Binary pass/fail |
| Shipments reaching a correct terminal status | **>99 %** | Anything less means manual cleanup daily |
| **COD daily reconciliation variance** | **0.000 TND** | Financial correctness is binary. A variance means the ledger is wrong |
| Dispatcher time to plan and publish a 40-stop route | **<5 min** | Must beat the spreadsheet it replaces |
| Driver taps to complete a delivery with POD + COD | **≤6** | Drivers do this 60× a day |
| Driver app crash-free session rate | **>99 %** | |

### 9.2 Technical

| Metric | Target |
|---|---|
| API p99 latency | <400 ms |
| Dispatcher board first meaningful paint | <2 s |
| WebSocket position delivery | <2 s p99 |
| GPS batches received vs expected over an 8h shift | **>95 %** |
| **Driver app battery drain during active shift** | **<6 %/hour** |
| Offline event submission success after reconnect | **100 %** (idempotent, zero duplicates) |
| Uptime | 99.5 % |
| Cross-tenant isolation test suite | **100 % pass, blocking CI** |
| Restore drill executed and verified | Before launch, then monthly |

### 9.3 Business

| Metric | Target |
|---|---|
| Pilot tenants live | **2–3** |
| Shipments processed/day at exit | 300–1,000 |
| Active drivers | 20–50 |
| Pilot retention past 60 days | **100 %** — losing a pilot means the product does not work |
| Infrastructure cost/month | <$300 |

### 9.4 Data quality

No AI is being built (§5). These targets exist because **operational reporting is only as good as the data underneath it** — and they cost nothing extra once §4.7 is implemented.

| Metric | Target | Why (non-AI justification) |
|---|---|---|
| Deliveries with complete plan-vs-actual capture | **>95 %** | On-time performance reporting is meaningless without it |
| Deliveries with structured failure reason codes | >95 % of failures | Drives re-attempt automation and tells the operator *why* deliveries fail |
| Addresses with verified or driver-corrected geocodes | >60 % | Directly improves routing quality and reduces failed deliveries. Compounding asset |
| Service-time samples per address type | >5,000 | Feeds historical-median service time — a SQL query that measurably improves route planning today |

*Side benefit, not a goal:* if the AI decision is ever revisited, this data makes it possible. That is a free option, not a reason to do any of it.

---

## 10. Realistic Timeline

**Assumption: one founder, AI-assisted, ~30 focused hours/week.** This is the single largest uncertainty in the plan and should be recalibrated after the first four weeks against actual velocity.

| Stage | Weeks | Content | Gate |
|---|---|---|---|
| **S0 Foundations** | 1–4 | Android background-location spike · monorepo + boundary lint · CI with Testcontainers · Terraform · **tenancy + RLS + cross-tenant suite** · auth/RBAC · outbox · OTel · OSRM Maghreb extract | Location spike passes; an authenticated, tenant-scoped, traced request works end to end |
| **S1 Core domain** | 5–9 | Shipments + event log + state machine · addresses + geocoding · drivers/vehicles/shifts · hubs + legs · CSV import · admin console · **i18n/RTL scaffolding** | A shipment can be created and moved through its full lifecycle by API |
| **S2 Dispatch & tracking** | 10–15 | Telemetry ingest + TimescaleDB · WebSocket realtime · **dispatcher board** · routes + OSRM sequencing · geofences | A dispatcher can plan and publish a route and watch it execute |
| **S3 Driver app** | 12–19 *(overlaps S2)* | Shell + offline queue · background location · manifest/stops · scanning · POD · failure flows · COD capture · offline sync · AR/FR UI | A driver completes a full route offline and syncs cleanly |
| **S4 Money & customer** | 18–22 | Ledger · COD flow + remittance + reconciliation · cash-in-field · tracking page · SMS/push | **COD reconciles to zero variance for a simulated full day** |
| **S5 Hardening & pilot** | 23–26 | Security review · load test · backup + restore drill · runbooks · retention jobs · Play Store submission · pilot onboarding | First real courier runs a real day |

**Lean-launch option at ~week 20:** S0–S3 plus the ledger, with SMS and the customer tracking page following in the first weeks of the pilot. Viable if a pilot partner is ready early — get real usage sooner, since real feedback beats more features.

**Honest assessment:** 26 weeks is realistic; 20 is optimistic; anything under 16 requires cutting COD or the driver app, and neither can be cut without breaking the §2 thesis. The largest single item is the dispatcher board (S2), consistently underestimated by everyone who builds one.

---

## 11. Risks Specific to This Scope

| # | Risk | Mitigation |
|---|---|---|
| MVP1 | **SMS deliverability in Tunisia unresolved** — notifications are on the critical path | Procure and **test a local aggregator by week 8**, not week 22. Treat as a hard dependency |
| MVP2 | **Solo-founder bus factor** | Everything in Git; ADRs record *why*; runbooks written before launch; infrastructure fully in Terraform |
| MVP3 | **Android background location fails the spike** | Week-1 spike with pass/fail criteria. Fallback: native Kotlin location module behind the same RN interface |
| MVP4 | **No design partner secured** (Q6) | Recruit an observation partner even without a contract — shadow a dispatcher and ride with a driver for two days before S1. Cheapest high-value item available |
| MVP5 | **Dispatcher board scope creep** | Fixed feature list; usability-test with a real dispatcher at week 12; resist adding views until pilots ask twice |
| MVP6 | **TND 3-decimal error reaches production** | Currency exponent from the `currencies` table; property-based tests on the ledger; a P0 acceptance test |
| MVP7 | **RTL retrofit** | RTL scaffolding in S1, before screens accumulate |
| MVP8 | **Velocity assumption wrong** | Recalibrate at week 4 against actual S0 completion and re-plan openly rather than compressing quality |

---

## 12. Open Items

| # | Item | Owner | Needed by |
|---|---|---|---|
| MVP-O1 | Select and test a Tunisian SMS aggregator (cost, deliverability, Arabic support) | Founder | Week 8 |
| MVP-O2 | Confirm hosting region (EU-Frankfurt vs EU-Paris) against latency to Tunisia | Founder | Week 2 |
| MVP-O3 | Confirm INPDP registration obligations for processing Tunisian personal data | Founder / legal | Before pilot |
| MVP-O4 | Identify an observation partner (courier willing to be shadowed) | Founder | Week 4 |
| MVP-O5 | Confirm whether pilot tenants need French or Arabic as the **default** UI language | Founder | Week 5 |
| MVP-O6 | Decide Google Maps vs Waze as the default navigation hand-off (driver preference in-market) | Founder | Week 12 |

---

## 13. Approval

This document defines the MVP boundary. **On approval, implementation begins with Stage S0.**

Where it conflicts with [10-development-roadmap.md](./10-development-roadmap.md) — which was written before the Q1–Q8 answers and assumes a 3–4 engineer team — **this document is authoritative** and the roadmap should be reconciled to it.
