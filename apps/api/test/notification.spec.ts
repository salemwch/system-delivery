import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { EventStreamConsumer } from "../src/modules/platform/application/event-stream-consumer.js";
import type { ConsumerLogger } from "../src/modules/platform/application/event-stream-consumer.js";
import { ValkeyStreamEventPublisher } from "../src/modules/platform/infrastructure/valkey-stream.publisher.js";
import { FeatureService } from "../src/modules/platform/application/feature.service.js";
import type { ConsumedEvent, EventHandler } from "../src/modules/platform/index.js";
import type { PublishableEvent } from "../src/modules/platform/domain/event-publisher.js";
import { NotificationService } from "../src/modules/notification/application/notification.service.js";
import { NotificationEventHandler } from "../src/modules/notification/application/notification-event.handler.js";
import type {
  DeliveryReceipt,
  NotificationProvider,
  OutboundMessage,
} from "../src/modules/notification/domain/notification-provider.js";
import type { AppConfigService } from "../src/shared/config/index.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
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
 * Notification module + the generic event-stream consumer — against a real
 * PostgreSQL and a real Valkey. This closes the event-driven loop: the relay
 * publishes to the stream, the consumer reads it with XREADGROUP, dedupes on
 * eventId, and drives the notification handler; poison messages go to the DLQ.
 * None of that (consumer groups, PEL retries, RLS on the async path) can be
 * proven against a mock, so nothing here is mocked except the SMS provider.
 */
describe("notification", () => {
  let database: TestDatabase;
  let valkey: TestValkey;
  let db: DatabaseService;
  let features: FeatureService;
  let createdTenants: string[] = [];

  /** A provider that records what it was asked to send and can be made to fail. */
  class RecordingProvider implements NotificationProvider {
    readonly name = "console";
    readonly sent: OutboundMessage[] = [];
    shouldFail = false;
    send(message: OutboundMessage): Promise<DeliveryReceipt> {
      if (this.shouldFail) {
        return Promise.reject(new Error("provider outage"));
      }
      this.sent.push(message);
      return Promise.resolve({ providerMessageId: `rec-${randomUUID()}`, accepted: true });
    }
  }

  const silentLogger: ConsumerLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  function consumerConfig(streamKey: string): AppConfigService {
    const values: Record<string, unknown> = {
      OUTBOX_STREAM_KEY: streamKey,
      OUTBOX_STREAM_MAXLEN: 100_000,
      EVENT_CONSUMER_BATCH_SIZE: 50,
      EVENT_CONSUMER_BLOCK_MS: 100,
      EVENT_CONSUMER_MAX_DELIVERIES: 2,
      // Zero idle so a pending message is reclaimable immediately in the test.
      EVENT_CONSUMER_CLAIM_MIN_IDLE_MS: 0,
    };
    return { get: (key: string): unknown => values[key] } as unknown as AppConfigService;
  }

  async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  async function enableSms(tenantId: string): Promise<void> {
    await withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx`insert into tenant_features (tenant_id, feature_key, enabled, source)
           values (${tenantId}, 'SMS_ENABLED', true, 'PLAN')`,
    );
  }

  async function notificationLogRows(
    tenantId: string,
  ): Promise<{ status: string; template_key: string; body: string | null }[]> {
    return withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx<{ status: string; template_key: string; body: string | null }[]>`
          select status, template_key, body from notification_log
          where tenant_id = ${tenantId} order by created_at`,
    );
  }

  async function deadLetterCount(tenantId: string): Promise<number> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ n: string }[]>`select count(*)::text as n from dead_letter_events
                                  where tenant_id = ${tenantId}`,
    );
    return Number(rows[0]?.n ?? "0");
  }

  async function processedCount(tenantId: string): Promise<number> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ n: string }[]>`select count(*)::text as n from processed_events
                                  where tenant_id = ${tenantId}`,
    );
    return Number(rows[0]?.n ?? "0");
  }

  function outForDeliveryEvent(
    tenantId: string,
    overrides: Partial<PublishableEvent> = {},
  ): PublishableEvent {
    return {
      seq: 1n,
      eventId: randomUUID(),
      tenantId,
      eventType: "shipment.out_for_delivery",
      eventVersion: 1,
      aggregateType: "shipment",
      aggregateId: randomUUID(),
      correlationId: null,
      causationId: null,
      occurredAt: new Date(),
      payload: {
        trackingNumber: "SD-8K3M-92XQ",
        recipientName: "Sonia Gharbi",
        recipientPhone: "+21620987654",
      },
      traceparent: null,
      tracestate: null,
      ...overrides,
    };
  }

  function consumedFrom(event: PublishableEvent): ConsumedEvent {
    return {
      streamId: "0-1",
      seq: event.seq,
      eventId: event.eventId,
      tenantId: event.tenantId,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt,
      correlationId: event.correlationId,
      causationId: event.causationId,
      payload: (event.payload ?? {}) as Record<string, unknown>,
      deliveryCount: 1,
      traceparent: event.traceparent,
      tracestate: event.tracestate,
    };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    valkey = await createTestValkey();
    db = new DatabaseService(database.app);
    features = new FeatureService(db);
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
    await valkey.close();
  });

  // ── NotificationService ────────────────────────────────────────────────────

  describe("NotificationService", () => {
    it("renders a default template, sends, and logs SENT when SMS is enabled", async () => {
      const tenantId = await seedTenant("notif-send");
      await enableSms(tenantId);
      const provider = new RecordingProvider();
      const service = new NotificationService(db, features, provider);

      const event = consumedFrom(outForDeliveryEvent(tenantId));
      const row = await asTenant(tenantId, () =>
        service.send({
          tenantId,
          channel: "SMS",
          templateKey: "shipment.out_for_delivery",
          locale: "fr",
          recipient: "+21620987654",
          params: { trackingNumber: "SD-8K3M-92XQ" },
          eventId: event.eventId,
        }),
      );

      expect(row.status).toBe("SENT");
      expect(row.body).toContain("SD-8K3M-92XQ");
      expect(provider.sent).toHaveLength(1);
    });

    it("skips (fail-closed) and never calls the provider when SMS is disabled", async () => {
      const tenantId = await seedTenant("notif-gate");
      const provider = new RecordingProvider();
      const service = new NotificationService(db, features, provider);

      const row = await asTenant(tenantId, () =>
        service.send({
          tenantId,
          channel: "SMS",
          templateKey: "shipment.out_for_delivery",
          locale: "fr",
          recipient: "+21620987654",
          params: {},
          eventId: randomUUID(),
        }),
      );

      expect(row.status).toBe("SKIPPED");
      expect(provider.sent).toHaveLength(0);
    });

    it("is idempotent on the triggering event — a repeat sends once", async () => {
      const tenantId = await seedTenant("notif-idem");
      await enableSms(tenantId);
      const provider = new RecordingProvider();
      const service = new NotificationService(db, features, provider);
      const eventId = randomUUID();
      const command = {
        tenantId,
        channel: "SMS" as const,
        templateKey: "shipment.out_for_delivery",
        locale: "fr" as const,
        recipient: "+21620987654",
        params: { trackingNumber: "SD-1" },
        eventId,
      };

      await asTenant(tenantId, () => service.send(command));
      await asTenant(tenantId, () => service.send(command));

      expect(provider.sent).toHaveLength(1);
      expect(await notificationLogRows(tenantId)).toHaveLength(1);
    });

    it("records FAILED and rethrows on a provider outage (so the consumer retries)", async () => {
      const tenantId = await seedTenant("notif-fail");
      await enableSms(tenantId);
      const provider = new RecordingProvider();
      provider.shouldFail = true;
      const service = new NotificationService(db, features, provider);

      await expect(
        asTenant(tenantId, () =>
          service.send({
            tenantId,
            channel: "SMS",
            templateKey: "shipment.out_for_delivery",
            locale: "fr",
            recipient: "+21620987654",
            params: {},
            eventId: randomUUID(),
          }),
        ),
      ).rejects.toThrow();

      const rows = await notificationLogRows(tenantId);
      expect(rows[0]?.status).toBe("FAILED");
    });
  });

  // ── NotificationEventHandler ───────────────────────────────────────────────

  describe("NotificationEventHandler", () => {
    it("notifies from an out_for_delivery event carrying recipient contact", async () => {
      const tenantId = await seedTenant("notif-handler");
      await enableSms(tenantId);
      const provider = new RecordingProvider();
      const handler = new NotificationEventHandler(new NotificationService(db, features, provider));

      expect(handler.handles("shipment.out_for_delivery")).toBe(true);
      expect(handler.handles("shipment.created")).toBe(false);

      await asTenant(tenantId, () => handler.handle(consumedFrom(outForDeliveryEvent(tenantId))));
      expect(provider.sent).toHaveLength(1);
      expect((await notificationLogRows(tenantId))[0]?.status).toBe("SENT");
    });

    it("skips an event with no recipient phone (a clean no-op, not a failure)", async () => {
      const tenantId = await seedTenant("notif-norecipient");
      await enableSms(tenantId);
      const provider = new RecordingProvider();
      const handler = new NotificationEventHandler(new NotificationService(db, features, provider));

      const event = consumedFrom(
        outForDeliveryEvent(tenantId, { payload: { trackingNumber: "X" } }),
      );
      await asTenant(tenantId, () => handler.handle(event));
      expect(provider.sent).toHaveLength(0);
      expect(await notificationLogRows(tenantId)).toHaveLength(0);
    });

    // shipment.delivered / delivery.failed now carry recipient contact (the
    // shipment emit sites were enriched), so both fire end-to-end — the handler is
    // no longer inert on its other two subscribed events.
    it.each(["shipment.delivered", "delivery.failed"])(
      "notifies from a %s event",
      async (eventType) => {
        const tenantId = await seedTenant(`notif-${eventType.replace(".", "-")}`);
        await enableSms(tenantId);
        const provider = new RecordingProvider();
        const handler = new NotificationEventHandler(
          new NotificationService(db, features, provider),
        );

        expect(handler.handles(eventType)).toBe(true);
        const event = consumedFrom(outForDeliveryEvent(tenantId, { eventType }));
        await asTenant(tenantId, () => handler.handle(event));

        expect(provider.sent).toHaveLength(1);
        const rows = await notificationLogRows(tenantId);
        expect(rows[0]?.status).toBe("SENT");
        expect(rows[0]?.template_key).toBe(eventType);
        expect(rows[0]?.body).toContain("SD-8K3M-92XQ");
      },
    );
  });

  // ── EventStreamConsumer (the closed loop) ──────────────────────────────────

  describe("EventStreamConsumer", () => {
    function makeConsumer(streamKey: string, handler: EventHandler): EventStreamConsumer {
      return new EventStreamConsumer(
        valkey.client,
        db,
        handler,
        silentLogger,
        consumerConfig(streamKey),
      );
    }

    function publisher(streamKey: string): ValkeyStreamEventPublisher {
      const config = {
        get: (key: string): unknown =>
          key === "OUTBOX_STREAM_KEY"
            ? streamKey
            : key === "OUTBOX_STREAM_MAXLEN"
              ? 100_000
              : undefined,
      } as unknown as AppConfigService;
      return new ValkeyStreamEventPublisher(valkey.client, config);
    }

    it("consumes a published event, notifies, and records it as processed", async () => {
      const tenantId = await seedTenant("consume-happy");
      await enableSms(tenantId);
      const streamKey = `test-stream-${randomUUID()}`;
      const provider = new RecordingProvider();
      const handler = new NotificationEventHandler(new NotificationService(db, features, provider));
      const consumer = makeConsumer(streamKey, handler);

      // Create the group BEFORE publishing, so it sees the message (groups start
      // at the tail), then publish and drain one pass.
      await consumer.ensureGroup();
      await publisher(streamKey).publishBatch([outForDeliveryEvent(tenantId)]);
      const summary = await consumer.consumeOnce();

      expect(summary.handled).toBe(1);
      expect(provider.sent).toHaveLength(1);
      expect(await processedCount(tenantId)).toBe(1);
    });

    it("is idempotent: a redelivered event is handled once", async () => {
      const tenantId = await seedTenant("consume-dup");
      await enableSms(tenantId);
      const streamKey = `test-stream-${randomUUID()}`;
      const provider = new RecordingProvider();
      const handler = new NotificationEventHandler(new NotificationService(db, features, provider));
      const consumer = makeConsumer(streamKey, handler);
      const event = outForDeliveryEvent(tenantId);

      await consumer.ensureGroup();
      await publisher(streamKey).publishBatch([event]);
      await consumer.consumeOnce();
      // Same eventId delivered a second time (at-least-once duplicate).
      await publisher(streamKey).publishBatch([event]);
      await consumer.consumeOnce();

      expect(provider.sent).toHaveLength(1);
      expect(await processedCount(tenantId)).toBe(1);
    });

    it("dead-letters a poison message after its deliveries are exhausted", async () => {
      const tenantId = await seedTenant("consume-dlq");
      const streamKey = `test-stream-${randomUUID()}`;
      const poison: EventHandler = {
        consumerGroup: "notification",
        handles: () => true,
        handle: () => Promise.reject(new Error("always fails")),
      };
      const consumer = makeConsumer(streamKey, poison);

      await consumer.ensureGroup();
      await publisher(streamKey).publishBatch([outForDeliveryEvent(tenantId)]);

      // MAX_DELIVERIES = 2: first pass delivers + fails; the reclaim sweeps retry
      // until the count is exhausted, then route to the DLQ. Drive several passes.
      for (let i = 0; i < 4; i++) {
        await consumer.consumeOnce();
      }

      expect(await deadLetterCount(tenantId)).toBe(1);
    });
  });
});
