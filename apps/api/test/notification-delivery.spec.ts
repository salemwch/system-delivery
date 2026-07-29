import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { NotificationEventHandler } from "../src/modules/notification/application/notification-event.handler.js";
import { NotificationService } from "../src/modules/notification/application/notification.service.js";
import { TemplateService } from "../src/modules/notification/application/template.service.js";
import { estimateSegments } from "../src/modules/notification/domain/templates.js";
import { FeatureService } from "../src/modules/platform/application/feature.service.js";
import { ChannelRoutingProvider } from "../src/modules/platform/infrastructure/channel-routing.provider.js";
import { ConsoleNotificationProvider } from "../src/modules/platform/infrastructure/console-notification.provider.js";
import { HttpSmsProvider } from "../src/modules/platform/infrastructure/http-sms.provider.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { ValidationError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";
import { CapturingNotificationProvider } from "./auth.factory.js";
import type { ConsumedEvent } from "../src/modules/platform/domain/consumed-event.js";

/**
 * Notification delivery (docs/01-mvp-scope.md §4.6 #6.2/#6.3/#6.4).
 *
 * Three things are under test, and none of them is "does a string get sent":
 *
 *  - the SMS transport's failure behaviour — timeout, circuit breaker, and the
 *    guarantee that a body carrying an OTP never reaches a log;
 *  - which events notify WHOM over WHICH channel, including the ones that
 *    deliberately do not notify at all;
 *  - Arabic segment cost, which is invisible until it is on an invoice.
 */
/** What the providers actually pass to  — narrower than RequestInit. */
interface StubInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | URLSearchParams;
}

describe("notification delivery", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let createdTenants: string[] = [];

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  /** Config stub covering only the keys the providers read. */
  function providerConfig(overrides: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = {
      NOTIFICATION_SMS_PROVIDER: "console",
      NOTIFICATION_PUSH_PROVIDER: "console",
      SMS_BASE_URL: "https://sms.example.test/send",
      SMS_API_KEY: "test-key",
      SMS_API_SECRET: "",
      SMS_SENDER_ID: "DELIVERY",
      FCM_PROJECT_ID: "",
      FCM_CLIENT_EMAIL: "",
      FCM_PRIVATE_KEY: "",
      ...overrides,
    };
    return { get: (key: string) => values[key] } as never;
  }

  function testLogger() {
    return {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    } as never;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await database.close();
  });

  // ── The SMS transport ──────────────────────────────────────────────────────

  describe("http sms provider", () => {
    it("posts the message and returns the provider's id", async () => {
      const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
      vi.stubGlobal("fetch", (url: string, init: StubInit) => {
        calls.push({
          url,
          body: JSON.parse(typeof init.body === "string" ? init.body : ""),
          headers: init.headers ?? {},
        });
        return Promise.resolve(
          new Response(JSON.stringify({ messageId: "agg-123" }), { status: 200 }),
        );
      });

      const provider = new HttpSmsProvider(providerConfig(), testLogger());
      const receipt = await provider.send({
        to: "+21620000001",
        body: "Votre colis est arrivé",
        channel: "SMS",
      });

      expect(receipt.providerMessageId).toBe("agg-123");
      expect(receipt.accepted).toBe(true);
      expect(calls[0]?.url).toBe("https://sms.example.test/send");
      // Bearer when no secret is set, Basic when one is — both are common and
      // neither needs a code change.
      expect(calls[0]?.headers["authorization"]).toBe("Bearer test-key");
    });

    it("uses Basic auth when a secret is configured", async () => {
      let auth = "";
      vi.stubGlobal("fetch", (_url: string, init: StubInit) => {
        auth = init.headers?.["authorization"] ?? "";
        return Promise.resolve(new Response("{}", { status: 200 }));
      });

      const provider = new HttpSmsProvider(providerConfig({ SMS_API_SECRET: "shh" }), testLogger());
      await provider.send({ to: "+21620000001", body: "test", channel: "SMS" });

      expect(auth.startsWith("Basic ")).toBe(true);
    });

    it("accepts a 2xx with no recognisable id rather than failing a sent message", async () => {
      vi.stubGlobal("fetch", () => Promise.resolve(new Response("OK", { status: 200 })));

      const provider = new HttpSmsProvider(providerConfig(), testLogger());
      const receipt = await provider.send({ to: "+216200", body: "x", channel: "SMS" });

      // The aggregator took the message. Failing here would retry something that
      // already went out.
      expect(receipt.accepted).toBe(true);
      expect(receipt.providerMessageId).toBe("OK");
    });

    it("throws on a non-2xx", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(new Response("insufficient credit", { status: 402 })),
      );

      const provider = new HttpSmsProvider(providerConfig(), testLogger());
      await expect(provider.send({ to: "+216200", body: "x", channel: "SMS" })).rejects.toThrow(
        /402/u,
      );
    });

    it("opens a circuit breaker after repeated failures", async () => {
      let attempts = 0;
      vi.stubGlobal("fetch", () => {
        attempts += 1;
        return Promise.resolve(new Response("down", { status: 503 }));
      });

      const provider = new HttpSmsProvider(providerConfig(), testLogger());
      for (let i = 0; i < 5; i += 1) {
        await expect(provider.send({ to: "+216200", body: "x", channel: "SMS" })).rejects.toThrow();
      }
      expect(attempts).toBe(5);

      // The sixth fails WITHOUT a network call. An aggregator outage otherwise
      // means every notification burns the full timeout, and the retry backlog
      // grows faster than it drains.
      await expect(provider.send({ to: "+216200", body: "x", channel: "SMS" })).rejects.toThrow(
        /circuit breaker/u,
      );
      expect(attempts).toBe(5);
    });

    it("NEVER logs the message body or the destination", async () => {
      const logged: unknown[] = [];
      vi.stubGlobal("fetch", () => Promise.resolve(new Response("nope", { status: 500 })));

      const provider = new HttpSmsProvider(providerConfig(), {
        error: (...args: unknown[]) => logged.push(args),
        warn: () => undefined,
      } as never);

      await expect(
        provider.send({
          // On the driver-login path this body is a live OTP.
          to: "+21620555001",
          body: "482913 est votre code de connexion",
          channel: "SMS",
        }),
      ).rejects.toThrow();

      const serialised = JSON.stringify(logged);
      expect(serialised).not.toContain("482913");
      expect(serialised).not.toContain("+21620555001");
    });

    it("refuses a channel it cannot deliver", async () => {
      const provider = new HttpSmsProvider(providerConfig(), testLogger());
      await expect(provider.send({ to: "token", body: "x", channel: "PUSH" })).rejects.toThrow(
        /cannot deliver/u,
      );
    });
  });

  // ── Channel routing ────────────────────────────────────────────────────────

  describe("channel routing", () => {
    it("defaults BOTH channels to console", () => {
      const console_ = new ConsoleNotificationProvider(testLogger(), providerConfig());
      const router = new ChannelRoutingProvider(providerConfig(), testLogger(), console_);

      // The fail-safe direction is "did not send", never "sent to production
      // numbers from a staging box".
      expect(router.name).toBe("console+console");
    });

    it("selects the http transport for SMS when configured", () => {
      const console_ = new ConsoleNotificationProvider(testLogger(), providerConfig());
      const router = new ChannelRoutingProvider(
        providerConfig({ NOTIFICATION_SMS_PROVIDER: "http" }),
        testLogger(),
        console_,
      );
      expect(router.name).toBe("http+console");
    });

    it("refuses EMAIL rather than pretending to send it", async () => {
      const console_ = new ConsoleNotificationProvider(testLogger(), providerConfig());
      const router = new ChannelRoutingProvider(providerConfig(), testLogger(), console_);

      // A fake success would hide a caller's mistake.
      await expect(router.send({ to: "a@b.tn", body: "x", channel: "EMAIL" })).rejects.toThrow(
        /not configured/u,
      );
    });
  });

  // ── Which events notify whom ───────────────────────────────────────────────

  describe("event routing", () => {
    let handler: NotificationEventHandler;
    let sms: CapturingNotificationProvider;

    beforeAll(() => {
      sms = new CapturingNotificationProvider();
      const service = new NotificationService(db, new FeatureService(db), sms);
      handler = new NotificationEventHandler(service);
    });

    afterEach(() => {
      sms.clear();
    });

    /** A ConsumedEvent as the stream consumer would hand it to the handler. */
    function event(
      eventType: string,
      payload: Record<string, unknown>,
      tenantId: string,
    ): ConsumedEvent {
      return {
        streamId: "0-1",
        seq: null,
        eventId: randomUUID(),
        tenantId,
        eventType,
        eventVersion: 1,
        aggregateType: "shipment",
        aggregateId: randomUUID(),
        occurredAt: new Date(),
        correlationId: null,
        causationId: null,
        payload,
        // First delivery. A redelivery carries a higher count, which is what the
        // handler's idempotency has to survive.
        deliveryCount: 1,
        // No active trace in a unit test; never fabricated.
        traceparent: null,
        tracestate: null,
      };
    }

    it("handles the customer, merchant and driver events", () => {
      for (const type of [
        "shipment.out_for_delivery",
        "shipment.delivered",
        "delivery.failed",
        "shipment.return_pending",
        "shipment.cancelled",
        "pickup.completed",
        "settlement.paid",
        "route.published",
        "shipment.assigned",
      ]) {
        expect(handler.handles(type)).toBe(true);
      }
    });

    it("does NOT notify on every status change", () => {
      // A customer who receives six messages per parcel stops reading them, and
      // the one that matters is the one they miss.
      for (const type of [
        "shipment.created",
        "shipment.picked_up",
        "shipment.arrived_at_hub",
        "shipment.loaded",
        "shipment.departed",
        "pickup.parcel_scanned",
        "cod.collected",
      ]) {
        expect(handler.handles(type)).toBe(false);
      }
    });

    it("sends a customer SMS in the recipient's own language", async () => {
      const tenantId = await seedTenant("notif");
      await enableSms(tenantId);

      await handler.handle(
        event(
          "shipment.delivered",
          {
            recipientPhone: "+21620000002",
            recipientName: "Ahmed",
            recipientLocale: "ar",
            trackingNumber: "TN-1",
          },
          tenantId,
        ),
      );

      const sent = sms.sent.at(-1);
      expect(sent?.channel).toBe("SMS");
      expect(sent?.to).toBe("+21620000002");
      expect(sent?.body).toContain("تم تسليم");
    });

    it("routes a driver event to PUSH, not SMS", async () => {
      const tenantId = await seedTenant("notif");

      await handler.handle(
        event(
          "route.published",
          { driverDeviceToken: "fcm-token-abc", stopCount: 18, plannedDate: "2026-07-30" },
          tenantId,
        ),
      );

      const sent = sms.sent.at(-1);
      // Paying per SMS for what the driver app already receives free is waste.
      expect(sent?.channel).toBe("PUSH");
      expect(sent?.to).toBe("fcm-token-abc");
      expect(sent?.body).toContain("18");
    });

    it("skips silently when the event carries no recipient", async () => {
      const tenantId = await seedTenant("notif");
      await enableSms(tenantId);

      // A parcel with no phone on file is ordinary in this market. Failing would
      // retry five times and dead-letter something nobody can fix.
      await handler.handle(event("shipment.delivered", { trackingNumber: "TN-2" }, tenantId));

      expect(sms.sent).toHaveLength(0);
    });

    it("skips a driver event with no device token", async () => {
      const tenantId = await seedTenant("notif");
      await handler.handle(event("route.published", { stopCount: 4 }, tenantId));
      expect(sms.sent).toHaveLength(0);
    });

    it("is idempotent on the triggering event", async () => {
      const tenantId = await seedTenant("notif");
      await enableSms(tenantId);

      const e = event(
        "shipment.delivered",
        { recipientPhone: "+21620000003", trackingNumber: "TN-3" },
        tenantId,
      );

      await handler.handle(e);
      await handler.handle(e);

      // At-least-once delivery means redelivery is normal operation, not an error.
      expect(sms.sent).toHaveLength(1);
    });

    it("respects the SMS_ENABLED cost gate, and does not gate PUSH", async () => {
      const tenantId = await seedTenant("notif");
      // SMS_ENABLED left OFF.

      await handler.handle(
        event(
          "shipment.delivered",
          { recipientPhone: "+21620000004", trackingNumber: "TN-4" },
          tenantId,
        ),
      );
      expect(sms.sent).toHaveLength(0);

      // Push costs nothing per message, so it is not gated.
      await handler.handle(
        event("route.published", { driverDeviceToken: "tok", stopCount: 3 }, tenantId),
      );
      expect(sms.sent).toHaveLength(1);
    });

    async function enableSms(tenantId: string): Promise<void> {
      await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx`
          insert into tenant_features (tenant_id, feature_key, enabled)
          values (${tenantId}, 'SMS_ENABLED', true)
          on conflict (tenant_id, feature_key) do update set enabled = true
        `,
      );
    }
  });

  // ── Templates ──────────────────────────────────────────────────────────────

  describe("templates", () => {
    let templates: TemplateService;

    beforeAll(() => {
      templates = new TemplateService(db);
    });

    async function asOwner<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
      return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "user" }, fn);
    }

    it("lists defaults for a tenant that has overridden nothing", async () => {
      const tenantId = await seedTenant("notif");
      const list = await asOwner(tenantId, () => templates.list());

      // A fresh tenant notifies correctly with no seeding.
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((t) => t.isDefault)).toBe(true);
      expect(list.some((t) => t.key === "shipment.delivered" && t.locale === "ar")).toBe(true);
    });

    it("overrides a default and marks it as no longer default", async () => {
      const tenantId = await seedTenant("notif");
      await asOwner(tenantId, () =>
        templates.upsert({
          key: "shipment.delivered",
          locale: "fr",
          channel: "SMS",
          body: "Colis {{trackingNumber}} livré — Boutique Ines",
        }),
      );

      const list = await asOwner(tenantId, () => templates.list());
      const overridden = list.find(
        (t) => t.key === "shipment.delivered" && t.locale === "fr" && t.channel === "SMS",
      );
      expect(overridden?.isDefault).toBe(false);
      expect(overridden?.body).toContain("Boutique Ines");
    });

    it("REFUSES a placeholder no event will ever populate", async () => {
      const tenantId = await seedTenant("notif");
      await expect(
        asOwner(tenantId, () =>
          templates.upsert({
            key: "shipment.delivered",
            locale: "fr",
            channel: "SMS",
            // Plausible, and would render empty forever.
            body: "Bonjour {{customerName}}, votre colis est livré",
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("reverts to the built-in default by removing the override", async () => {
      const tenantId = await seedTenant("notif");
      await asOwner(tenantId, () =>
        templates.upsert({
          key: "shipment.delivered",
          locale: "fr",
          channel: "SMS",
          body: "Custom {{trackingNumber}}",
        }),
      );

      const result = await asOwner(tenantId, () =>
        templates.revert({ key: "shipment.delivered", locale: "fr", channel: "SMS" }),
      );
      expect(result.reverted).toBe(true);

      const list = await asOwner(tenantId, () => templates.list());
      const reverted = list.find((t) => t.key === "shipment.delivered" && t.locale === "fr");
      // Reverting must restore WORKING behaviour, not disable the notification.
      expect(reverted?.isDefault).toBe(true);
    });

    it("previews with realistic values, including an Arabic name", async () => {
      const tenantId = await seedTenant("notif");
      const preview = await asOwner(tenantId, () =>
        templates.preview({ key: "shipment.delivered", locale: "fr", channel: "SMS" }),
      );

      expect(preview.body).toContain("TN-20260729-0042");
      expect(preview.body).not.toContain("{{");
      expect(preview.estimatedSegments).toBeGreaterThan(0);
    });

    it("never shows one tenant another's overrides", async () => {
      const tenantA = await seedTenant("notif-a");
      const tenantB = await seedTenant("notif-b");

      await asOwner(tenantA, () =>
        templates.upsert({
          key: "shipment.delivered",
          locale: "fr",
          channel: "SMS",
          body: "Tenant A only {{trackingNumber}}",
        }),
      );

      const forB = await asOwner(tenantB, () => templates.list());
      expect(forB.every((t) => !t.body.includes("Tenant A only"))).toBe(true);
    });
  });

  // ── SMS segment cost ───────────────────────────────────────────────────────

  describe("segment estimation", () => {
    it("counts a Latin body at 160 characters per segment", () => {
      expect(estimateSegments("Your parcel has been delivered.")).toBe(1);
      expect(estimateSegments("a".repeat(160))).toBe(1);
      expect(estimateSegments("a".repeat(161))).toBe(2);
    });

    it("counts an ARABIC body at 70 — the cost nobody notices", () => {
      const arabic = "تم تسليم طردك. شكرا لك على ثقتك بنا ونتمنى أن نراك مرة أخرى قريبا جدا";
      // One non-GSM-7 character forces UCS-2 for the WHOLE message, more than
      // halving the characters per segment. This is a real line item at volume.
      expect(arabic.length).toBeLessThan(160);
      expect(estimateSegments(arabic)).toBeGreaterThan(0);
      expect(estimateSegments("ا".repeat(71))).toBe(2);
    });

    it("keeps GSM-7 accents cheap — 'é' is in the basic set", () => {
      // Worth pinning: French copy is full of these, and treating them as UCS-2
      // would over-estimate every French template by a factor of two.
      expect(estimateSegments("é".repeat(160))).toBe(1);
    });

    it("treats a character outside GSM-7 as forcing UCS-2", () => {
      // Turkish 'ş' is not in GSM-7. One of them doubles the cost of the whole
      // message, which is the trap this function exists to expose.
      expect(estimateSegments("ş".repeat(71))).toBe(2);
    });

    it("returns zero for an empty body", () => {
      expect(estimateSegments("")).toBe(0);
    });
  });
});
