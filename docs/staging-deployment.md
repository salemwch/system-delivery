# Staging deployment plan (DigitalOcean, Terraform, HTTPS)

> **Goal:** a public `https://` staging API the driver app can reach, so the background-location field test ([driver-field-test.md](./driver-field-test.md)) can run. **Status:** plan only, written 2026-10-19 after reading every file in `infra/terraform` and the deploy design in [09-infrastructure.md](./09-infrastructure.md). Nothing has been applied.

## 1. What already exists, and what is missing

**Already in Terraform** (`infra/terraform/environments/staging` composing four modules): VPC `10.21.0.0/20` in `fra1`; a load balancer that terminates HTTPS on 443, redirects 80 → 443, forwards to the droplets on port 80, health-checks `/ready`, and keeps WebSocket sessions sticky; a default-deny firewall (droplets reachable from the load balancer only); managed PostgreSQL 18 (2-node standby pair) and Valkey (2 nodes), private network only; the three database users `dp_app`, `dp_migrator`, `dp_relay`; two app droplets; a Spaces bucket for POD media; remote state in a Spaces bucket.

**Missing** (found while reading; each blocks a working deploy):

| # | Gap | Why it blocks | Who |
|---|---|---|---|
| G1 | **No `/ready` (or `/health`) route in the API** | The load balancer health-checks `/ready`: every droplet would be marked unhealthy and receive no traffic | code |
| G2 | **No Dockerfile** | docs/09 §3 specifies one image for `core-api` and `core-worker`; there is nothing to run on the droplets | code |
| G3 | **Droplet image `docker-20-04`** | Ubuntu 20.04 is past end of standard support: no security updates | code |
| G4 | **No droplet bootstrap** (`cloud_init` is an empty variable) | Nothing installs Docker, creates the service user, writes config or starts the containers | code |
| G5 | **No deploy pipeline** | CI only tests; nothing builds an image, runs migrations or rolls the droplets | code |
| G6 | **Database bootstrap for a managed cluster** | `initdb/` runs only in local Docker. On DigitalOcean the extensions (PostGIS, TimescaleDB), schema ownership and role attributes must be applied once by the admin user | code + you |
| G7 | **TimescaleDB licence on DigitalOcean is unverified** | Migration 0018 calls `add_retention_policy`, a feature that is not in TimescaleDB's Apache-only edition. If DigitalOcean ships that edition, migrations stop at 0018 on a fresh cluster (see §4) | probe first |
| G8 | **No SMS provider** | Drivers sign in by SMS code. The `console` provider never logs the code (by design: PII), so on staging **no driver can sign in** until an SMS provider is configured (see §5) | **you decide** |
| G9 | **Domain, DNS, certificate** | The load balancer needs a certificate name; the app needs an `https` hostname | **you** |

## 2. Decisions for you

| Decision | Recommendation | Alternative |
|---|---|---|
| **Domain** | A domain you own, staging on subdomains: `api.staging.<domain>`, `app.staging.<domain>` | — (required) |
| **DNS + TLS for staging** | **DigitalOcean DNS + DigitalOcean-managed Let's Encrypt certificate**: issued and renewed automatically, nothing to rotate by hand | Cloudflare in front (docs/09 §4.1, the production design): then the certificate is a **Cloudflare Origin Certificate** uploaded to DigitalOcean as a custom certificate, with SSL mode "Full (strict)". Do this for production |
| **Staging size** | Keep the topology Terraform defines (2 app droplets, 2-node PostgreSQL and Valkey): it is what exercises failover and the cross-instance realtime fan-out | A lean variant (1 of each) roughly halves the cost but tests less; only for the field test, and Terraform says why it should not be the default |
| **SMS** (G8) | See §5 | — |

**Approximate monthly cost** of the topology as written (DigitalOcean list prices, verify on their pricing page before applying): 2 × `s-2vcpu-4gb` droplets ≈ $48, PostgreSQL `db-s-1vcpu-2gb` × 2 nodes ≈ $60, Valkey × 2 nodes ≈ $60, load balancer ≈ $12, Spaces ≈ $5. **≈ $185/month.** Destroying staging between test campaigns (`terraform destroy`) costs nothing but the rebuild time.

## 3. The plan, in order

### Phase 0 — accounts and prerequisites (you, about one hour)

1. DigitalOcean account; create an **API token** (read + write) and a **Spaces access key**. Keep both out of files: they go into GitHub as secrets (step 4) and into your shell as `TF_VAR_*` variables.
2. Create the Terraform **state bucket** `delivery-tfstate` in `fra1` by hand (the one manual resource; the state cannot describe its own bucket).
3. Point the domain's nameservers to DigitalOcean (if you take the recommendation), and upload your SSH public key to DigitalOcean.
4. In GitHub: Settings → Environments → **staging**, with the secrets `DO_TOKEN`, `SPACES_ACCESS_ID`, `SPACES_SECRET_KEY` (the deploy pipeline adds the generated application secrets in Phase 3).
5. Decide SMS (§5).

### Phase 1 — close the code gaps (me; each a small, tested change)

| Change | Closes | Verified by |
|---|---|---|
| `GET /health` (process alive) and `GET /ready` (PostgreSQL and Valkey reachable, 200 or 503), public, no data in the body | G1 | HTTP tests; the load balancer contract |
| `Dockerfile` for `core-api` / `core-worker` (one image, two entrypoints): `node:24-alpine` pinned by digest, multi-stage, `pnpm deploy --prod`, non-root, read-only root filesystem, `HEALTHCHECK`; `.dockerignore`; Trivy scan in CI | G2 | `docker build`, container boots against local infra, Trivy clean |
| Droplet image → `ubuntu-24-04-x64`; `cloud-init` that installs a pinned Docker Engine and the Compose plugin, creates a non-root `deploy` user, disables root SSH and password login, enables unattended security upgrades | G3, G4 | `terraform validate`; a throwaway droplet |
| Compose file per droplet: `api` (published on 80 → 3000) and `worker`, environment from `/etc/delivery/staging.env` (mode 0600) | G4 | local `docker compose up` |
| Database bootstrap script for managed PostgreSQL, run once as `doadmin`: `CREATE EXTENSION postgis, timescaledb`, `ALTER SCHEMA public OWNER TO dp_migrator`, `NOBYPASSRLS` on `dp_app` and `dp_relay`, and nothing else (the passwords are generated by DigitalOcean) | G6 | runs against the staging cluster in Phase 2 |
| `deploy-staging` workflow (GitHub Actions, `staging` environment): build and push the image to GHCR tagged with the git SHA → run migrations as a one-shot container with `MIGRATION_DATABASE_URL` → roll droplet 1, wait for `/ready`, then droplet 2; roll back to the previous SHA if `/ready` fails. SSH is opened **only for the runner's IP, only for the deploy**, through a temporary firewall rule the workflow adds and removes with `doctl` (no standing SSH exposure) | G5 | a deploy of a known SHA, then a deliberate failed one that rolls back |

### Phase 2 — database first, and the licence probe (together, ~30 minutes)

1. `cd infra/terraform/environments/staging`, fill `terraform.tfvars` from the example (`certificate_name`, `allowed_origins`, `ssh_key_fingerprints`), then `terraform init` and `terraform plan -target=module.network -target=module.database -out=tfplan`. **Review the plan**, then `terraform apply tfplan`.
2. Run the bootstrap script (Phase 1) as `doadmin`.
3. **Run the probe in §4 before anything else.** It decides whether migrations can run on this cluster.
4. Run migrations (`pnpm db:migrate` with the staging `MIGRATION_DATABASE_URL`, from a machine allowed by the database firewall, or from the deploy workflow).

### Phase 3 — everything else, HTTPS and the first deploy

1. Create the certificate: DigitalOcean → Networking → Certificates → Let's Encrypt for `api.staging.<domain>` (and `app.staging.<domain>`). Its name goes into `certificate_name`.
2. `terraform plan -out=tfplan` (full) → review → `terraform apply tfplan`. Note the `load_balancer_ip` output.
3. DNS: an A record `api.staging.<domain>` → the load balancer IP (and the same for `app.staging`).
4. Generate the application secrets once (JWT signing keys, `FIELD_ENCRYPTION_KEY`, and others the config schema requires) and store them in the GitHub `staging` environment. Never in the repository, never in an image.
5. Run `deploy-staging`. Expect `https://api.staging.<domain>/ready` → 200.
6. Provision the staging tenant(s) and the test drivers, vehicles and routes (docs/09 §5: always at least two tenants with colliding references).

### Phase 4 — the driver app points at staging

1. `npx eas-cli env:create --environment preview --name EXPO_PUBLIC_API_URL --value https://api.staging.<domain> --visibility plaintext`
2. `npx eas-cli build --profile field-test --platform android`
3. Install, sign in, and start the field test.

### Smoke checks after every deploy

`/ready` 200 through the load balancer · `http://` redirects to `https://` · a droplet's port 80 is **not** reachable from the internet (firewall) · the databases have no public endpoint · driver sign-in and one telemetry batch accepted · the cross-tenant isolation suite run against staging.

## 4. The TimescaleDB licence probe (G7)

Run on the new cluster as `doadmin`, before migrations:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
SHOW timescaledb.license;        -- 'timescale' (community) or 'apache'
-- Then, in a scratch schema:
CREATE TABLE probe (time timestamptz NOT NULL, v int);
SELECT create_hypertable('probe', 'time');
SELECT add_retention_policy('probe', INTERVAL '90 days');   -- the call migration 0018 makes
DROP TABLE probe;
```

- **It works** → continue with Phase 2 step 4.
- **It fails** (an Apache-only build) → migration 0018 cannot run on this cluster, and migrations are checksum-locked, so 0018 is not edited. Options, to decide then:
  1. **Self-managed TimescaleDB for telemetry only.** The API already keeps telemetry on its own connection (`TELEMETRY_DATABASE_URL`, a dedicated pool). This needs a migration-runner change so the hypertable lives on that database.
  2. **Timescale Cloud** for telemetry, same split as option 1, managed.
  3. **Self-host the whole database** on a droplet. Not recommended: it gives up managed backups, point-in-time recovery and failover (docs/09: "we do not operate PostgreSQL by hand at MVP").

## 5. SMS for driver sign-in (G8)

| Option | Effort | Notes |
|---|---|---|
| **A. Contract the Tunisian SMS aggregator now** (open item MVP-O1) | Configure `NOTIFICATION_SMS_PROVIDER=http` and `SMS_*`; sender-ID registration takes about 18 days | **Recommended**: it is on the critical path for production anyway, and the field test then exercises the real sign-in |
| B. An international provider for staging only | An adapter behind the existing `NotificationProvider` port | Works within days; costs more per SMS and may be filtered by Tunisian operators |
| C. Staging-only fixed codes for allow-listed test numbers | A small, config-gated change | Fastest, but it is a sign-in bypass. Only acceptable if the configuration **refuses to boot** with it in production, and the allow-list holds only the testers' numbers. Ask before building it |

## 6. Security posture (what this plan keeps true)

TLS terminates at the load balancer with an automatically renewed certificate; droplets accept HTTP from the load balancer only; databases are private and accept the app droplets only; three least-privilege database roles with RLS forced; secrets live in GitHub Environments and on the droplets in one 0600 file, never in the repository, images or Terraform files; Terraform state lives in a private bucket; SSH is closed except for the duration of a deploy; images are pinned by digest, scanned by Trivy, tagged by git SHA.
