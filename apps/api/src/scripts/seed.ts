import { randomBytes } from "node:crypto";
import process from "node:process";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Sql } from "postgres";

import { DatabaseService } from "../shared/database/database.service.js";
import { OperatingConfigService } from "../modules/platform/application/operating-config.service.js";
import { OutboxService } from "../modules/platform/application/outbox.service.js";
import { TenantService } from "../modules/platform/application/tenant.service.js";
import { PasswordService } from "../modules/identity/application/password.service.js";
import { ProvisioningService } from "../modules/identity/application/provisioning.service.js";

/**
 * Seeds a courier tenant with an owner account you can log in with.
 *
 * Runs on MIGRATION_DATABASE_URL — provisioning is a control-plane operation
 * and needs the privilege to insert into `tenants`, which the request-path
 * `dp_app` role does not have.
 *
 * Idempotent by slug: re-running with an existing slug reports it and exits
 * cleanly rather than erroring on the unique constraint.
 *
 * `SEED_COMMERCIAL_EMAIL` additionally mints a COMMERCIAL login, and works
 * whether the tenant is new or already exists. That second case is the point:
 * a commercial cannot be created through the API without an OWNER session, and
 * OWNER requires MFA — so bootstrapping one by hand means a four-step TOTP
 * dance before you can even look at the screen you are trying to test.
 *
 * Configuration (all optional; sensible Tunisian defaults):
 *   SEED_TENANT_NAME, SEED_TENANT_SLUG, SEED_OWNER_EMAIL, SEED_OWNER_NAME,
 *   SEED_OWNER_PASSWORD (generated and printed if unset),
 *   SEED_COMMERCIAL_EMAIL, SEED_COMMERCIAL_NAME, SEED_COMMERCIAL_PASSWORD,
 *   SEED_RESET_EMAIL, SEED_RESET_PASSWORD.
 *
 * `SEED_RESET_EMAIL` restores access to an existing account whose password is
 * lost or whose authenticator is gone — see {@link resetAccount}. It is the
 * only way back into a tenant whose sole OWNER is locked out.
 */
async function main(): Promise<void> {
  const url = process.env["MIGRATION_DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    throw new Error("MIGRATION_DATABASE_URL is not set");
  }

  const name = process.env["SEED_TENANT_NAME"] ?? "Fast Delivery";
  const slug = process.env["SEED_TENANT_SLUG"] ?? "fast-delivery";
  const ownerEmail = process.env["SEED_OWNER_EMAIL"] ?? "owner@fast-delivery.tn";
  const ownerName = process.env["SEED_OWNER_NAME"] ?? "Fast Delivery Owner";
  // A generated password is printed once. Never persisted in plaintext.
  const ownerPassword = process.env["SEED_OWNER_PASSWORD"] ?? randomBytes(12).toString("base64url");

  // Account recovery. See `resetAccount` for why this exists and why it is a
  // script rather than an endpoint.
  const resetEmail = process.env["SEED_RESET_EMAIL"];
  const resetPassword =
    process.env["SEED_RESET_PASSWORD"] ?? randomBytes(12).toString("base64url");

  const commercialEmail = process.env["SEED_COMMERCIAL_EMAIL"];
  const commercialName = process.env["SEED_COMMERCIAL_NAME"] ?? "Commercial";
  const commercialPassword =
    process.env["SEED_COMMERCIAL_PASSWORD"] ?? randomBytes(12).toString("base64url");

  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  const db = drizzle(sql);

  try {
    const existing = await sql<
      { id: string }[]
    >`select id from tenants where slug = ${slug} limit 1`;
    const existingId = existing[0]?.id;
    if (existingId !== undefined) {
      // Recovery runs against an EXISTING tenant by definition.
      if (resetEmail !== undefined) {
        await resetAccount(sql, existingId, { email: resetEmail, password: resetPassword });
        return;
      }
      if (commercialEmail === undefined) {
        process.stdout.write(`Tenant "${slug}" already exists (${existingId}). Nothing to do.\n`);
        return;
      }
      // The tenant is there; the caller wants a commercial added to it.
      await addCommercial(sql, existingId, {
        email: commercialEmail,
        fullName: commercialName,
        password: commercialPassword,
      });
      printCommercial(slug, existingId, commercialEmail, commercialPassword);
      return;
    }

    const outbox = new OutboxService();
    const database = new DatabaseService(sql as never);
    const tenantService = new TenantService(database, outbox, new OperatingConfigService(database));
    const passwords = new PasswordService();
    const provisioning = new ProvisioningService(tenantService, passwords);

    const result = await db.transaction(async (tx) => {
      return provisioning.provision(tx, {
        tenant: {
          name,
          slug,
          countryCode: "TN",
          defaultCurrency: "TND",
          defaultTimezone: "Africa/Tunis",
          defaultLocale: "fr",
          plan: "PILOT",
        },
        owner: {
          email: ownerEmail,
          fullName: ownerName,
          password: ownerPassword,
          locale: "fr",
        },
      });
    });

    process.stdout.write(
      [
        "",
        "  Tenant provisioned.",
        "",
        `    tenant     ${name}  (${slug})`,
        `    tenantId   ${result.tenantId}`,
        `    owner      ${ownerEmail}`,
        `    password   ${ownerPassword}`,
        "",
        "  Log in:",
        "",
        "    curl -sS -X POST http://localhost:3000/v1/auth/login \\",
        "      -H 'content-type: application/json' \\",
        `      -d '${JSON.stringify({ tenantId: result.tenantId, email: ownerEmail, password: ownerPassword })}'`,
        "",
      ].join("\n"),
    );

    if (commercialEmail !== undefined) {
      await addCommercial(sql, result.tenantId, {
        email: commercialEmail,
        fullName: commercialName,
        password: commercialPassword,
      });
      printCommercial(slug, result.tenantId, commercialEmail, commercialPassword);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Mints a COMMERCIAL login directly.
 *
 * Written as SQL rather than through `UserService` on purpose: this runs as
 * `dp_migrator` with no HTTP request and therefore no ambient tenant context,
 * which every service method requires. The rows it writes are exactly what
 * `POST /v1/users` produces for this role — a user with no `merchant_id` (the
 * role is not merchant-scoped, invariant I23) and one `user_roles` row.
 *
 * ONE TRANSACTION, and the `set_config` is load-bearing: `users` and
 * `user_roles` are FORCE ROW LEVEL SECURITY, which binds the table owner too,
 * so without a tenant context both inserts fail their WITH CHECK. The I23
 * constraint triggers are DEFERRABLE and judged at COMMIT, which is why the
 * user and its role must land in the same transaction.
 *
 * MFA is left off: COMMERCIAL is not in MFA_REQUIRED_ROLES. Field staff on
 * shared Android handsets are the population for whom a mandatory authenticator
 * app is a lockout, not a control — the role holds no money or admin
 * permission, so the trade is deliberate.
 */
/**
 * Restores access to a locked-out account (`SEED_RESET_EMAIL`).
 *
 * The one path back in when an OWNER's password is lost or their authenticator
 * is gone — and there is no other, by design: the reset endpoint needs
 * `user:manage`, which needs an OWNER session, which is exactly what is
 * missing. Without this the tenant is unadministrable forever.
 *
 * ⚠️ LOCAL/OPERATOR TOOL. It runs as `dp_migrator` on MIGRATION_DATABASE_URL —
 * a control-plane credential that already owns the schema — and it deliberately
 * bypasses the audited API. Anyone holding that URL can already read every
 * table; this grants nothing new. It must never be reachable from the
 * application, which is why it lives in a script and not in a service.
 *
 * MFA enrolment is CLEARED, not disabled: `mfa_enabled` stays as it was, so a
 * privileged role still has to present a factor. The next login routes to
 * bootstrap enrolment and a fresh QR code — that is the recovery, rather than
 * "turn MFA off", which is the account-takeover path migration 0023 warns about.
 */
async function resetAccount(
  sql: Sql,
  tenantId: string,
  account: { readonly email: string; readonly password: string },
): Promise<void> {
  const passwordHash = await new PasswordService().hash(account.password);
  const email = account.email.trim().toLowerCase();

  const updated = await sql.begin(async (tx) => {
    await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
    const rows = await tx<{ id: string }[]>`
      update users
         set password_hash = ${passwordHash},
             -- A lockout counted against a password that no longer exists.
             failed_login_count = 0,
             locked_until = null,
             -- Discard the enrolment: the authenticator holding this secret is
             -- unreachable, which is the whole reason for the reset.
             mfa_secret = null,
             mfa_enrolled_at = null,
             mfa_last_step = null,
             updated_at = now()
       where lower(email) = ${email}
       returning id
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`No user with the email "${account.email}" in this tenant.`);
    }
    // These belonged to the secret just discarded and would authenticate
    // against a factor that no longer exists.
    await tx`delete from mfa_recovery_codes where user_id = ${row.id}`;
    // Every live session was minted under the old credential.
    await tx`
      update refresh_tokens
         set revoked_at = now(), revoke_reason = 'PASSWORD_RESET'
       where user_id = ${row.id} and revoked_at is null`;
    return row.id;
  });

  process.stdout.write(
    [
      "",
      "  Account reset.",
      "",
      `    email      ${email}`,
      `    password   ${account.password}`,
      `    userId     ${updated}`,
      "",
      "  MFA enrolment cleared. If the role requires a factor, the next login",
      "  returns MFA_ENROLMENT_REQUIRED and the sign-in page shows a fresh QR.",
      "",
    ].join("\n"),
  );
}

async function addCommercial(
  sql: Sql,
  tenantId: string,
  account: { readonly email: string; readonly fullName: string; readonly password: string },
): Promise<void> {
  const passwordHash = await new PasswordService().hash(account.password);
  // Lower-cased to match `createUserSchema`, and because the uniqueness index is
  // on `lower(email)` — storing a mixed-case address would log in fine but read
  // back differently from one created through the API.
  const email = account.email.trim().toLowerCase();

  await sql.begin(async (tx) => {
    await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
    const rows = await tx<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, full_name, locale, status, mfa_enabled)
      values (${tenantId}, ${email}, ${passwordHash}, ${account.fullName},
              'fr', 'ACTIVE', false)
      -- No conflict TARGET: uniqueness is the expression index
      -- users_tenant_email_uq on (tenant_id, lower(email)), which a column list
      -- cannot name. The untargeted form infers any arc, which is what we want.
      on conflict do nothing
      returning id
    `;
    const created = rows[0];
    if (created === undefined) {
      throw new Error(
        `A user with the email "${account.email}" already exists in this tenant — ` +
          "choose another SEED_COMMERCIAL_EMAIL.",
      );
    }
    await tx`
      insert into user_roles (tenant_id, user_id, role)
      values (${tenantId}, ${created.id}, 'COMMERCIAL')
    `;
  });
}

function printCommercial(
  slug: string,
  tenantId: string,
  email: string,
  password: string,
): void {
  process.stdout.write(
    [
      "",
      "  COMMERCIAL login created.",
      "",
      `    tenant     ${slug}`,
      `    email      ${email}`,
      `    password   ${password}`,
      "",
      "  Sign in at http://localhost:3002/fr/login — no MFA for this role.",
      `    (WEB_TENANT_SLUG must be "${slug}"; tenantId ${tenantId})`,
      "",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
