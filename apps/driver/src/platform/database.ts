import { open } from "@op-engineering/op-sqlite";
import type { DB } from "@op-engineering/op-sqlite";

import { databaseKey } from "./secure";

/**
 * The local database: SQLCipher (op-sqlite, `"sqlcipher": true` in
 * package.json), keyed from the Keystore. The device's source of truth
 * (docs/08 §8.1): the UI and the background task both read it, and nothing
 * captured is ever held only in memory.
 *
 * Migrations are forward-only and numbered, like the server's: each runs once,
 * in order, inside a transaction, recorded in `schema_version`.
 */
const MIGRATIONS: readonly string[] = [
  // 1 — telemetry queue and the small key/value record the diagnostics screen reads.
  `CREATE TABLE IF NOT EXISTS positions (
     seq       INTEGER PRIMARY KEY AUTOINCREMENT,
     shift_id  TEXT    NOT NULL,
     t         TEXT    NOT NULL,
     t_ms      INTEGER NOT NULL,
     body      TEXT    NOT NULL,
     batch_id  TEXT
   );
   CREATE INDEX IF NOT EXISTS positions_batch_idx ON positions (batch_id);
   CREATE INDEX IF NOT EXISTS positions_shift_idx ON positions (shift_id, seq);
   CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // 2 — the field-work outbox (core/outbox.ts), its POD media, and the day's
  // manifests as last seen from the server.
  `CREATE TABLE IF NOT EXISTS actions (
     seq         INTEGER PRIMARY KEY AUTOINCREMENT,
     id          TEXT    NOT NULL UNIQUE,
     kind        TEXT    NOT NULL,
     subject_id  TEXT    NOT NULL,
     payload     TEXT    NOT NULL,
     media       TEXT    NOT NULL DEFAULT '[]',
     state       TEXT    NOT NULL DEFAULT 'PENDING',
     attempts    INTEGER NOT NULL DEFAULT 0,
     code        TEXT,
     detail      TEXT,
     created_at  INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS actions_state_idx ON actions (state, seq);
   CREATE INDEX IF NOT EXISTS actions_subject_idx ON actions (subject_id);
   CREATE TABLE IF NOT EXISTS media (
     id           TEXT    PRIMARY KEY,
     shipment_id  TEXT    NOT NULL,
     purpose      TEXT    NOT NULL,
     uri          TEXT    NOT NULL,
     content_type TEXT    NOT NULL,
     size_bytes   INTEGER NOT NULL,
     artifact_id  TEXT,
     object_key   TEXT,
     state        TEXT    NOT NULL DEFAULT 'CAPTURED',
     code         TEXT,
     created_at   INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS routes (
     route_id     TEXT    PRIMARY KEY,
     version      TEXT    NOT NULL,
     status       TEXT    NOT NULL,
     active       INTEGER NOT NULL,
     planned_date TEXT    NOT NULL,
     manifest     TEXT    NOT NULL,
     updated_at   INTEGER NOT NULL
   );`,
];

let opening: Promise<DB> | null = null;

/** One connection per JS runtime (the UI and the headless task each have one). */
export function database(): Promise<DB> {
  opening ??= openAndMigrate().catch((error: unknown) => {
    opening = null;
    throw error;
  });
  return opening;
}

async function openAndMigrate(): Promise<DB> {
  const db = open({ name: "driver.sqlite", encryptionKey: await databaseKey() });
  // WAL: the task appends while the UI reads, without blocking each other.
  await db.execute("PRAGMA journal_mode = WAL");
  await db.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const current = await db.execute("SELECT MAX(version) AS v FROM schema_version");
  const version = Number(current.rows[0]?.["v"] ?? 0);
  for (let i = version; i < MIGRATIONS.length; i += 1) {
    const sql = MIGRATIONS[i];
    if (sql === undefined) continue;
    await db.transaction(async (tx) => {
      for (const statement of sql
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s !== "")) {
        await tx.execute(statement);
      }
      await tx.execute("INSERT INTO schema_version (version) VALUES (?)", [i + 1]);
    });
  }
  return db;
}

export async function readMeta(key: string): Promise<string | null> {
  const db = await database();
  const result = await db.execute("SELECT value FROM meta WHERE key = ?", [key]);
  const value = result.rows[0]?.["value"];
  return typeof value === "string" ? value : null;
}

export async function writeMeta(key: string, value: string): Promise<void> {
  const db = await database();
  await db.execute(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}
