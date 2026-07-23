import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";

import { OutboxRelayService } from "../src/modules/platform/application/outbox-relay.service.js";
import type { RelayLogger } from "../src/modules/platform/application/outbox-relay.service.js";
import { ValkeyStreamEventPublisher } from "../src/modules/platform/infrastructure/valkey-stream.publisher.js";
import type { EventPublisher } from "../src/modules/platform/domain/event-publisher.js";
import type { AppConfigService } from "../src/shared/config/index.js";
import type { Database } from "../src/shared/database/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";
import { createTestValkey } from "./valkey.harness.js";
import type { TestValkey } from "./valkey.harness.js";

/**
 * Outbox relay.
 *
 * Drives the real relay against a real PostgreSQL and a real Valkey. The whole
 * point of the relay is behaviour that cannot be mocked: cross-tenant reads
 * under Row-Level Security, FOR UPDATE SKIP LOCKED coordination, and actual
 * XADD ordering — so none of it is mocked.
 */

const STREAM_KEY = "outbox.events.test";

/**
 * A config stub exposing only the keys the relay and publisher read. Cast is
 * confined to the test: building the full validated ConfigService here would add
 * nothing the relay exercises.
 */
function stubConfig(overrides: Record<string, unknown> = {}): AppConfigService {
  const values: Record<string, unknown> = {
    OUTBOX_RELAY_BATCH_SIZE: 100,
    OUTBOX_RELAY_POLL_INTERVAL_MS: 10,
    // High base backoff so a failed row's next attempt is clearly in the future
    // for the gating test.
    OUTBOX_RELAY_BASE_BACKOFF_MS: 30_000,
    OUTBOX_RELAY_MAX_BACKOFF_MS: 60_000,
    OUTBOX_RELAY_ALERT_AGE_SECONDS: 60,
    OUTBOX_STREAM_KEY: STREAM_KEY,
    OUTBOX_STREAM_MAXLEN: 100_000,
    ...overrides,
  };
  return {
    get: (key: string): unknown => values[key],
  } as unknown as AppConfigService;
}

const silentLogger: RelayLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const failingPublisher: EventPublisher = {
  publishBatch: () => Promise.reject(new Error("valkey unreachable")),
};

interface SeedEvent {
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly correlationId?: string;
}

describe("outbox relay", () => {
  let database: TestDatabase;
  let valkey: TestValkey;
  let relayDb: Database;
  let realPublisher: ValkeyStreamEventPublisher;
  let createdTenants: string[] = [];

  const uuid = (): string => crypto.randomUUID();

  function makeRelay(publisher: EventPublisher, config = stubConfig()): OutboxRelayService {
    return new OutboxRelayService(relayDb, publisher, silentLogger, config);
  }

  async function seedTenant(label: string): Promise<string> {
    const tenantId = await createTenant(database.migrator, label);
    createdTenants.push(tenantId);
    return tenantId;
  }

  /** Inserts outbox rows for a tenant and returns their seq values (as strings). */
  async function seedOutbox(tenantId: string, events: readonly SeedEvent[]): Promise<string[]> {
    return withTenantContext(database.migrator, tenantId, async (tx) => {
      const seqs: string[] = [];
      for (const event of events) {
        const rows = await tx<{ seq: string }[]>`
          insert into outbox (tenant_id, event_type, aggregate_type, aggregate_id, payload, correlation_id)
          values (
            ${tenantId}, ${event.eventType}, ${event.aggregateType}, ${event.aggregateId},
            ${JSON.stringify(event.payload)}::jsonb, ${event.correlationId ?? null}
          )
          returning seq
        `;
        const row = rows[0];
        if (row === undefined) {
          throw new Error("outbox insert returned no row");
        }
        seqs.push(row.seq);
      }
      return seqs;
    });
  }

  function parseEntry(fields: string[]): Record<string, string> {
    const entry: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];
      if (key !== undefined && value !== undefined) {
        entry[key] = value;
      }
    }
    return entry;
  }

  async function readStream(): Promise<Record<string, string>[]> {
    const entries = await valkey.client.xrange(STREAM_KEY, "-", "+");
    return entries.map(([, fields]) => parseEntry(fields));
  }

  async function unpublishedCount(tenantId: string): Promise<number> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx<{ count: string }[]>`
          select count(*)::text as count from outbox
          where tenant_id = ${tenantId} and published_at is null
        `,
    );
    return Number(rows[0]?.count ?? "0");
  }

  // Reads of the outbox as the migrator MUST bind tenant context: the table is
  // FORCE-RLS, so an unscoped read has the policy evaluate an empty
  // `app.current_tenant_id` and error on the ''::uuid cast. Same trap the
  // provisioning suite hits — always go through withTenantContext.
  async function outboxRow(
    tenantId: string,
    seq: string,
  ): Promise<{
    published_at: string | null;
    attempts: number;
    last_error: string | null;
    next_attempt_at: string;
  }> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx<
          {
            published_at: string | null;
            attempts: number;
            last_error: string | null;
            next_attempt_at: string;
          }[]
        >`
          select published_at, attempts, last_error, next_attempt_at
          from outbox where seq = ${seq}
        `,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`no outbox row for seq ${seq}`);
    }
    return row;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    valkey = await createTestValkey();
    relayDb = drizzle(database.relay);
    realPublisher = new ValkeyStreamEventPublisher(valkey.client, stubConfig());
  }, 240_000);

  beforeEach(async () => {
    await valkey.client.flushall();
    createdTenants = [];
  });

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
  });

  afterAll(async () => {
    await valkey.close();
    await database.close();
  });

  it("publishes an unpublished event and marks it published", async () => {
    const tenantId = await seedTenant("relay-happy");
    const aggregateId = uuid();
    const [seq] = await seedOutbox(tenantId, [
      {
        eventType: "shipment.created",
        aggregateType: "shipment",
        aggregateId,
        payload: { trackingNumber: "TN-1", amountMinor: 15000 },
        correlationId: uuid(),
      },
    ]);

    const summary = await makeRelay(realPublisher).drainOnce();

    expect(summary).toEqual({ claimed: 1, published: 1, failed: 0 });

    const row = await outboxRow(tenantId, seq ?? "");
    expect(row.published_at).not.toBeNull();

    const stream = await readStream();
    expect(stream).toHaveLength(1);
    const entry = stream[0];
    expect(entry?.["eventType"]).toBe("shipment.created");
    expect(entry?.["tenantId"]).toBe(tenantId);
    expect(entry?.["aggregateId"]).toBe(aggregateId);
    expect(JSON.parse(entry?.["payload"] ?? "{}")).toEqual({
      trackingNumber: "TN-1",
      amountMinor: 15000,
    });
  });

  it("omits absent correlation fields from the envelope rather than sending 'null'", async () => {
    const tenantId = await seedTenant("relay-nocorr");
    await seedOutbox(tenantId, [
      {
        eventType: "tenant.provisioned",
        aggregateType: "tenant",
        aggregateId: tenantId,
        payload: {},
      },
    ]);

    await makeRelay(realPublisher).drainOnce();

    const entry = (await readStream())[0];
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("correlationId");
    expect(entry).not.toHaveProperty("causationId");
  });

  it("drains events from multiple tenants in one pass (cross-tenant read as dp_relay)", async () => {
    const tenantA = await seedTenant("relay-multi-a");
    const tenantB = await seedTenant("relay-multi-b");
    await seedOutbox(tenantA, [
      {
        eventType: "shipment.created",
        aggregateType: "shipment",
        aggregateId: uuid(),
        payload: {},
      },
    ]);
    await seedOutbox(tenantB, [
      {
        eventType: "shipment.created",
        aggregateType: "shipment",
        aggregateId: uuid(),
        payload: {},
      },
    ]);

    const summary = await makeRelay(realPublisher).drainOnce();

    expect(summary.published).toBe(2);
    const tenants = (await readStream()).map((entry) => entry["tenantId"]);
    expect(new Set(tenants)).toEqual(new Set([tenantA, tenantB]));
  });

  it("publishes events in seq order", async () => {
    const tenantId = await seedTenant("relay-order");
    const seqs = await seedOutbox(
      tenantId,
      [1, 2, 3].map((n) => ({
        eventType: "shipment.created",
        aggregateType: "shipment",
        aggregateId: uuid(),
        payload: { n },
      })),
    );

    await makeRelay(realPublisher).drainOnce();

    const streamSeqs = (await readStream()).map((entry) => entry["seq"]);
    expect(streamSeqs).toEqual(seqs);
  });

  it("does not republish an already-published event", async () => {
    const tenantId = await seedTenant("relay-idem");
    await seedOutbox(tenantId, [
      {
        eventType: "shipment.created",
        aggregateType: "shipment",
        aggregateId: uuid(),
        payload: {},
      },
    ]);

    const relay = makeRelay(realPublisher);
    await relay.drainOnce();
    const second = await relay.drainOnce();

    expect(second).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(await readStream()).toHaveLength(1);
  });

  it("is a no-op when the outbox is empty", async () => {
    const summary = await makeRelay(realPublisher).drainOnce();
    expect(summary).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(await readStream()).toHaveLength(0);
  });

  it("backs off and preserves the row when publishing fails", async () => {
    const tenantId = await seedTenant("relay-fail");
    const [seq] = await seedOutbox(tenantId, [
      {
        eventType: "shipment.created",
        aggregateType: "shipment",
        aggregateId: uuid(),
        payload: {},
      },
    ]);

    const summary = await makeRelay(failingPublisher).drainOnce();

    expect(summary).toEqual({ claimed: 1, published: 0, failed: 1 });
    const row = await outboxRow(tenantId, seq ?? "");
    expect(row.published_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("valkey unreachable");
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    expect(await readStream()).toHaveLength(0);
  });

  it("skips a backed-off row until next_attempt_at, then publishes on recovery", async () => {
    const tenantId = await seedTenant("relay-recover");
    const [seq] = await seedOutbox(tenantId, [
      {
        eventType: "shipment.created",
        aggregateType: "shipment",
        aggregateId: uuid(),
        payload: {},
      },
    ]);

    // First attempt fails and schedules a future retry.
    await makeRelay(failingPublisher).drainOnce();

    // A healthy relay must not touch it yet — it is gated by next_attempt_at.
    const gated = await makeRelay(realPublisher).drainOnce();
    expect(gated).toEqual({ claimed: 0, published: 0, failed: 0 });

    // Once the backoff window passes, it publishes.
    await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx`update outbox set next_attempt_at = now() where seq = ${seq ?? ""}`,
    );
    const recovered = await makeRelay(realPublisher).drainOnce();
    expect(recovered.published).toBe(1);
    expect((await outboxRow(tenantId, seq ?? "")).published_at).not.toBeNull();
  });

  it("skips rows locked by another relay instance (FOR UPDATE SKIP LOCKED)", async () => {
    const tenantId = await seedTenant("relay-locked");
    const [lockedSeq, freeSeq] = await seedOutbox(tenantId, [
      {
        eventType: "shipment.created",
        aggregateType: "shipment",
        aggregateId: uuid(),
        payload: {},
      },
      {
        eventType: "shipment.created",
        aggregateType: "shipment",
        aggregateId: uuid(),
        payload: {},
      },
    ]);

    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markAcquired = (): void => undefined;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });

    // Simulate another relay holding a lock on the first row.
    const lockHeld = withTenantContext(database.migrator, tenantId, async (tx) => {
      await tx`select seq from outbox where seq = ${lockedSeq ?? ""} for update`;
      markAcquired();
      await held;
    });

    await acquired;
    const summary = await makeRelay(realPublisher).drainOnce();
    release();
    await lockHeld;

    expect(summary.published).toBe(1);
    expect((await outboxRow(tenantId, lockedSeq ?? "")).published_at).toBeNull();
    expect((await outboxRow(tenantId, freeSeq ?? "")).published_at).not.toBeNull();
  });

  it("reports the age of the oldest unpublished event, and null once drained", async () => {
    const tenantId = await seedTenant("relay-age");
    await seedOutbox(tenantId, [
      {
        eventType: "shipment.created",
        aggregateType: "shipment",
        aggregateId: uuid(),
        payload: {},
      },
    ]);

    const relay = makeRelay(realPublisher);
    const age = await relay.oldestUnpublishedAgeSeconds();
    expect(age).not.toBeNull();
    expect(age ?? -1).toBeGreaterThanOrEqual(0);

    await relay.drainOnce();
    expect(await relay.oldestUnpublishedAgeSeconds()).toBeNull();
  });

  it("denies dp_relay any access to other tenant-scoped tables (least privilege)", async () => {
    // The relay identity may read the outbox across tenants, but nothing else —
    // no grant exists on tenant_features, so the read is refused outright.
    await expect(database.relay`select id from tenant_features limit 1`).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("drains continuously once started and stops cleanly", async () => {
    const tenantId = await seedTenant("relay-loop");
    const relay = makeRelay(realPublisher);
    relay.start();
    try {
      await seedOutbox(tenantId, [
        {
          eventType: "shipment.created",
          aggregateType: "shipment",
          aggregateId: uuid(),
          payload: {},
        },
      ]);

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (await unpublishedCount(tenantId)) > 0) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await unpublishedCount(tenantId)).toBe(0);
    } finally {
      await relay.stop();
    }
  });
});
