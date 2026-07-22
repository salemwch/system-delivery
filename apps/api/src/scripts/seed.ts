import { randomBytes } from "node:crypto";
import process from "node:process";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

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
 * Configuration (all optional; sensible Tunisian defaults):
 *   SEED_TENANT_NAME, SEED_TENANT_SLUG, SEED_OWNER_EMAIL, SEED_OWNER_NAME,
 *   SEED_OWNER_PASSWORD (generated and printed if unset).
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

  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  const db = drizzle(sql);

  try {
    const existing = await sql<
      { id: string }[]
    >`select id from tenants where slug = ${slug} limit 1`;
    if (existing.length > 0) {
      process.stdout.write(
        `Tenant "${slug}" already exists (${existing[0]?.id ?? "?"}). Nothing to do.\n`,
      );
      return;
    }

    const outbox = new OutboxService();
    const tenantService = new TenantService(outbox);
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
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
