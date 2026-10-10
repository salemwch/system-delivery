import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DatabaseService } from "../src/shared/database/database.service.js";
import { generateUuidV7 } from "../src/shared/database/index.js";
import { createTestDatabase } from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Application-minted persisted ids are UUIDv7 (CLAUDE.md "IDs: UUIDv7"), drawn
 * from the same `uuidv7()` every table default uses.
 */
describe("generateUuidV7", () => {
  let database: TestDatabase;
  let db: DatabaseService;

  const RFC_9562_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
  }, 240_000);

  afterAll(async () => {
    await database.close();
  });

  it("returns a version-7, RFC 9562 variant UUID", async () => {
    const id = await db.withoutTenantScope((tx) => generateUuidV7(tx));
    expect(id).toMatch(RFC_9562_V7);
  });

  it("embeds the creation time, so ids sort by when they were minted", async () => {
    const before = Date.now();
    const id = await db.withoutTenantScope((tx) => generateUuidV7(tx));
    const after = Date.now();

    // The first 48 bits are the Unix time in milliseconds.
    const embedded = Number.parseInt(id.replace(/-/gu, "").slice(0, 12), 16);
    // A 1 s margin covers clock skew between this process and the database.
    expect(embedded).toBeGreaterThanOrEqual(before - 1000);
    expect(embedded).toBeLessThanOrEqual(after + 1000);
  });

  it("never repeats within a transaction", async () => {
    const ids = await db.withoutTenantScope(async (tx) => {
      const minted: string[] = [];
      for (let i = 0; i < 200; i += 1) {
        minted.push(await generateUuidV7(tx));
      }
      return minted;
    });
    expect(new Set(ids).size).toBe(ids.length);
  });
});
