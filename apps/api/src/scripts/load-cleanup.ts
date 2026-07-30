import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import postgres from "postgres";

/**
 * Removes the tenants a load run created, and the fixture file holding its
 * bearer tokens.
 *
 * ⚠️ Not optional housekeeping. A run seeds 200 drivers and writes hundreds of
 * thousands of `driver_positions` rows into the DEV database — the same one the
 * test suite uses. Left behind, the next `pnpm test` runs against a hypertable
 * with a million rows in it and reports timings that mean nothing.
 *
 * Deletes by SLUG PREFIX (`load-`), not by reading the fixture: an interrupted
 * run leaves a tenant with no fixture file, and that is exactly the case that
 * needs cleaning. Cascades through every tenant-scoped table.
 *
 *   pnpm --filter @delivery/api load:cleanup
 */
async function main(): Promise<void> {
  const url = process.env["MIGRATION_DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    throw new Error("MIGRATION_DATABASE_URL is not set");
  }

  const sql = postgres(url, { max: 1, onnotice: () => undefined });

  try {
    const rows = await sql<{ id: string; slug: string }[]>`
      select id, slug from tenants where slug like 'load-%' order by slug
    `;

    if (rows.length === 0) {
      process.stdout.write("no load-test tenants to remove\n");
    } else {
      for (const row of rows) {
        process.stdout.write(`removing ${row.slug} (${row.id})\n`);
      }
      await sql.begin(async (tx) => {
        // NO_TENANT: a transaction-local GUC reverts to the EMPTY STRING, and a
        // policy evaluating `current_setting(...)::uuid` against `''` is a cast
        // error rather than a false predicate. A real UUID that matches nothing
        // lets the cascade proceed. Same reasoning as the test harness.
        await tx`select set_config('app.current_tenant_id', '00000000-0000-0000-0000-000000000000', true)`;
        await tx`select set_config('app.current_merchant_id', '', true)`;
        await tx`delete from tenants where slug like 'load-%'`;
      });
      process.stdout.write(`removed ${String(rows.length)} tenant(s)\n`);
    }

    // The fixture holds live bearer tokens; it should not outlive the tenants
    // they authenticate against.
    const fixture = resolve(process.cwd(), "../../load/fixture.json");
    if (existsSync(fixture)) {
      // Read and verified before deleting: this script must only ever remove the
      // file it wrote, never whatever happens to sit at that path.
      const parsed: unknown = JSON.parse(readFileSync(fixture, "utf8"));
      const looksLikeFixture =
        typeof parsed === "object" &&
        parsed !== null &&
        "drivers" in parsed &&
        "dispatcherToken" in parsed;
      if (looksLikeFixture) {
        unlinkSync(fixture);
        process.stdout.write("removed load/fixture.json\n");
      } else {
        process.stdout.write("left load/fixture.json alone — not a load fixture\n");
      }
    }
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
