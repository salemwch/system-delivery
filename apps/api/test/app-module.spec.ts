import process from "node:process";

import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestingModule } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { WorkerModule } from "../src/worker.module.js";
import { createTestDatabase, type TestDatabase } from "./database.harness.js";
import { createTestStorage, type TestStorage } from "./storage.harness.js";
import { createTestValkey, type TestValkey } from "./valkey.harness.js";

/**
 * The application's dependency graph actually resolves.
 *
 * `compile()` resolves and INSTANTIATES every provider and controller in the
 * graph, so a missing import, an unexported provider or a circular dependency
 * fails here rather than in production. `init()` is deliberately NOT called —
 * that would start listeners and background work, and this suite is about the
 * graph, not the runtime.
 *
 * The test is HERMETIC: it sets every required environment variable from test
 * harnesses and constants so it passes identically with or without a .env file.
 * When .env is present (local dev) the harnesses reuse existing services; when
 * it is absent (CI) they start Testcontainers.
 */

const TEST_SECRET = "test_hermetic_secret_that_passes_the_minimum_length_check";
const TEST_ENCRYPTION_KEY = Buffer.from("a".repeat(32)).toString("base64");

const envOverrides: string[] = [];

function ensureEnv(key: string, value: string): void {
  const existing = process.env[key];
  if (existing === undefined || existing === "") {
    process.env[key] = value;
    envOverrides.push(key);
  }
}

describe("composition roots", () => {
  let db: TestDatabase;
  let valkey: TestValkey;
  let storage: TestStorage;
  const opened: TestingModule[] = [];

  beforeAll(async () => {
    [db, valkey, storage] = await Promise.all([
      createTestDatabase(),
      createTestValkey(),
      createTestStorage(),
    ]);

    ensureEnv("DATABASE_URL", db.appUrl);
    ensureEnv("MIGRATION_DATABASE_URL", db.migratorUrl);
    ensureEnv("RELAY_DATABASE_URL", db.relayUrl);
    ensureEnv("VALKEY_URL", valkey.url);
    ensureEnv("S3_ENDPOINT", storage.settings.endpoint);
    ensureEnv("S3_REGION", storage.settings.region);
    ensureEnv("S3_BUCKET", storage.settings.bucket);
    ensureEnv("S3_ACCESS_KEY_ID", storage.settings.accessKeyId);
    ensureEnv("S3_SECRET_ACCESS_KEY", storage.settings.secretAccessKey);

    ensureEnv("NODE_ENV", "test");
    ensureEnv("API_BASE_URL", "http://localhost:3000");
    ensureEnv("OSRM_URL", "http://localhost:5000");
    ensureEnv("JWT_ACCESS_SECRET", TEST_SECRET);
    ensureEnv("JWT_REFRESH_SECRET", `${TEST_SECRET}_refresh`);
    ensureEnv("TRACKING_TOKEN_SECRET", `${TEST_SECRET}_tracking`);
    ensureEnv("FIELD_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  });

  afterAll(async () => {
    await Promise.all(opened.map(async (ref) => ref.close()));
    await Promise.all([db?.close(), valkey?.close(), storage?.close()]);

    for (const key of envOverrides) {
      delete process.env[key];
    }
  });

  /**
   * Both roots because they are DIFFERENT GRAPHS. The worker binds the stream
   * consumer and the relay the API deliberately does not run, so a provider can
   * resolve in one and not the other.
   */
  const roots = [
    { name: "AppModule (core-api)", module: AppModule },
    { name: "WorkerModule (core-worker)", module: WorkerModule },
  ] as const;

  for (const root of roots) {
    it(`resolves every provider in ${root.name}`, async () => {
      const moduleRef = await Test.createTestingModule({ imports: [root.module] }).compile();
      opened.push(moduleRef);

      expect(moduleRef).toBeDefined();
    }, 120_000);
  }
});
