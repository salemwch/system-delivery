import path from "node:path";
import process from "node:process";

import postgres from "postgres";

import { runMigrations } from "../shared/database/migrator.js";

/**
 * Applies pending migrations as dp_migrator.
 *
 * Uses MIGRATION_DATABASE_URL, never DATABASE_URL: the application role has no
 * DDL privileges by design, and that separation is what makes Row-Level
 * Security meaningful rather than decorative.
 */
async function main(): Promise<void> {
  const url = process.env["MIGRATION_DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    throw new Error("MIGRATION_DATABASE_URL is not set");
  }

  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    // dist/scripts/migrate.js -> apps/api/migrations
    const dir = path.resolve(__dirname, "../../migrations");
    const { applied, skipped } = await runMigrations(sql, dir);

    for (const file of skipped) {
      process.stdout.write(`skip   ${file}\n`);
    }
    for (const file of applied) {
      process.stdout.write(`apply  ${file}\n`);
    }
    process.stdout.write(
      applied.length === 0
        ? "\nSchema already up to date.\n"
        : `\nApplied ${applied.length} migration(s).\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
