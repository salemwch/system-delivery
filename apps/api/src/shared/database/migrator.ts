import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Sql } from "postgres";

/**
 * Forward-only SQL migration runner.
 *
 * Deliberately small and explicit rather than schema-diff generated, because
 * this project's migrations carry Row-Level Security policies, grants, and
 * triggers — security-critical statements that must be reviewed as written SQL,
 * not inferred from a model diff (docs/06-database-design.md §10).
 *
 * Properties:
 *   - Applied in lexical filename order (0000_, 0001_, ...).
 *   - Each file runs inside its own transaction: a failure rolls that file back
 *     entirely, never leaving a half-applied schema.
 *   - A checksum is recorded. Editing an already-applied migration is an error,
 *     because the database and the file would silently disagree.
 *   - Idempotent: re-running applies nothing.
 *
 * Runs as dp_migrator. The application role has no DDL privileges.
 */

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: string[];
}

const MIGRATIONS_TABLE = "schema_migrations";

async function ensureMigrationsTable(sql: Sql): Promise<void> {
  // `sql(identifier)` escapes and quotes the table name properly. The previous
  // version interpolated it into `sql.unsafe()`, which was safe only because
  // MIGRATIONS_TABLE happens to be a module constant — the moment anyone made
  // it configurable it would have become an injection sink. Semgrep rule
  // `no-interpolated-unsafe-sql` flagged it; the fix is to stop interpolating,
  // not to suppress the rule.
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(MIGRATIONS_TABLE)} (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

function checksumOf(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function runMigrations(sql: Sql, migrationsDir: string): Promise<MigrationResult> {
  await ensureMigrationsTable(sql);

  const entries = await readdir(migrationsDir);
  const files = entries.filter((file) => file.endsWith(".sql")).sort((a, b) => a.localeCompare(b));

  const rows = await sql<{ filename: string; checksum: string }[]>`
    select filename, checksum from ${sql(MIGRATIONS_TABLE)}
  `;
  const alreadyApplied = new Map(rows.map((row) => [row.filename, row.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const filename of files) {
    const contents = await readFile(path.join(migrationsDir, filename), "utf8");
    const checksum = checksumOf(contents);
    const previous = alreadyApplied.get(filename);

    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(
          `Migration "${filename}" has changed since it was applied ` +
            `(recorded ${previous.slice(0, 12)}, file ${checksum.slice(0, 12)}). ` +
            `Migrations are immutable once applied — add a new migration instead.`,
        );
      }
      skipped.push(filename);
      continue;
    }

    await sql.begin(async (tx) => {
      await tx.unsafe(contents);
      await tx`
        insert into ${tx(MIGRATIONS_TABLE)} (filename, checksum)
        values (${filename}, ${checksum})
      `;
    });

    applied.push(filename);
  }

  return { applied, skipped };
}
