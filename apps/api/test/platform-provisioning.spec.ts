import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";

import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { TenantService } from "../src/modules/platform/application/tenant.service.js";
import { FeatureService } from "../src/modules/platform/application/feature.service.js";
import { PasswordService } from "../src/modules/identity/application/password.service.js";
import { ProvisioningService } from "../src/modules/identity/application/provisioning.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import type { TenantId, TenantTransaction } from "../src/shared/database/index.js";
import { createTestDatabase, withTenantContext } from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Platform provisioning and feature flags.
 *
 * Provisioning is a control-plane operation, so these tests drive it through
 * the migration-privileged connection (which alone may insert into `tenants`),
 * exactly as the seed CLI does.
 */
describe("platform provisioning", () => {
  let database: TestDatabase;
  let features: FeatureService;
  let provisioning: ProvisioningService;
  let operatingConfig: OperatingConfigService;
  const createdTenants: string[] = [];

  const uniqueSlug = (label: string): string =>
    `prov-${label}-${Math.random().toString(36).slice(2, 8)}`;

  async function provisionTenant(slug: string, overrides = {}): Promise<TenantId> {
    const migratorDb = drizzle(database.migrator);
    const result = await migratorDb.transaction(async (tx) =>
      provisioning.provision(tx, {
        tenant: {
          name: `Test ${slug}`,
          slug,
          countryCode: "TN",
          defaultCurrency: "TND",
          defaultTimezone: "Africa/Tunis",
          defaultLocale: "fr",
          plan: "PILOT",
          ...overrides,
        },
        owner: {
          email: `owner-${slug}@test.tn`,
          fullName: "Test Owner",
          password: "seed-test-password-7781",
        },
      }),
    );
    createdTenants.push(result.tenantId);
    return result.tenantId;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    const dbService = new DatabaseService(database.app);
    const outbox = new OutboxService();
    operatingConfig = new OperatingConfigService(dbService);
    const tenantService = new TenantService(dbService, outbox, operatingConfig);
    features = new FeatureService(dbService);
    provisioning = new ProvisioningService(tenantService, new PasswordService());
  });

  afterAll(async () => {
    if (createdTenants.length > 0) {
      await database.migrator`delete from tenants where id = any(${database.migrator.array(createdTenants)}::uuid[])`;
    }
    await database.close();
  });

  describe("provision", () => {
    it("creates a tenant, its owner, default features, and a provisioned event", async () => {
      const slug = uniqueSlug("full");
      const tenantId = await provisionTenant(slug);

      const [tenant, userRows, featureRows, outboxRows] = await Promise.all([
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx<{ status: string }[]>`select status from tenants where id = ${tenantId}`,
        ),
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) =>
            tx<{ role: string }[]>`
            select ur.role from user_roles ur where ur.tenant_id = ${tenantId}
          `,
        ),
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) =>
            tx<
              { count: string }[]
            >`select count(*)::text from tenant_features where tenant_id = ${tenantId}`,
        ),
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) =>
            tx<
              { event_type: string }[]
            >`select event_type from outbox where tenant_id = ${tenantId}`,
        ),
      ]);

      expect(tenant[0]?.status).toBe("ACTIVE");
      expect(userRows.map((r) => r.role)).toEqual(["OWNER"]);
      expect(Number(featureRows[0]?.count)).toBe(14);
      expect(outboxRows.map((r) => r.event_type)).toEqual(["tenant.provisioned"]);
    });

    /**
     * ⚠️ The bug this test exists for.
     *
     * Failure reasons, working hours and SLA templates were seeded by migration
     * 0026 with a `CROSS JOIN tenants` — which reaches only the tenants that
     * exist when the migration runs. Every courier onboarded after that deploy
     * started with an EMPTY failure taxonomy, so `decideReattempt` found no row
     * for `CUSTOMER_REFUSED`, failed open by design, and sent a driver back to a
     * customer who had already said no — twice — before returning the parcel.
     * The most expensive ordinary mistake in a COD market, and nothing errored.
     *
     * Asserting a specific reason rather than a count: this must fail if the
     * defaults are seeded but the non-re-attemptable ones are missing.
     */
    it("gives the new tenant the operating configuration every code path assumes", async () => {
      const tenantId = await provisionTenant(uniqueSlug("opcfg"));

      const [reasons, templates, calendar] = await TenantContext.run(
        { tenantId, actorType: "system" },
        async () =>
          Promise.all([
            operatingConfig.listFailureReasons(),
            operatingConfig.listSlaTemplates(),
            withTenantContext(
              database.migrator,
              tenantId,
              (tx) =>
                tx<{ count: string }[]>`
                select count(*)::text from working_hours where tenant_id = ${tenantId}
              `,
            ),
          ]),
      );

      expect(reasons.find((r) => r.code === "CUSTOMER_REFUSED")?.allowsReattempt).toBe(false);
      expect(reasons.find((r) => r.code === "CUSTOMER_UNAVAILABLE")?.allowsReattempt).toBe(true);
      // One per `shipments.service_level`. A level with no template gets no
      // promised-by date and silently falls back to a hardcoded delay.
      expect(templates.map((t) => t.serviceLevel).sort()).toEqual([
        "EXPRESS",
        "SCHEDULED",
        "STANDARD",
      ]);
      expect(Number(calendar[0]?.count)).toBe(7);
    });

    it("writes the provisioned event unpublished, for the relay to pick up", async () => {
      const tenantId = await provisionTenant(uniqueSlug("unpub"));
      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) =>
          tx<{ published_at: string | null }[]>`
          select published_at from outbox where tenant_id = ${tenantId}
        `,
      );
      expect(rows[0]?.published_at).toBeNull();
    });

    it("is atomic: a duplicate slug rolls back the whole provisioning", async () => {
      const slug = uniqueSlug("dupe");
      await provisionTenant(slug);

      const migratorDb = drizzle(database.migrator);
      await expect(
        migratorDb.transaction(async (tx) =>
          provisioning.provision(tx, {
            tenant: {
              name: "Duplicate",
              slug,
              countryCode: "TN",
              defaultCurrency: "TND",
              defaultTimezone: "Africa/Tunis",
            },
            owner: { email: "dupe@test.tn", fullName: "Dupe", password: "password-1234567" },
          }),
        ),
      ).rejects.toThrow();

      // Exactly one tenant with that slug — the failed attempt left nothing.
      const rows = await database.migrator<{ count: string }[]>`
        select count(*)::text from tenants where slug = ${slug}
      `;
      expect(Number(rows[0]?.count)).toBe(1);
    });
  });

  describe("feature flags", () => {
    it("resolves a seeded-enabled feature as enabled", async () => {
      const tenantId = await provisionTenant(uniqueSlug("feat-on"));
      expect(await features.isEnabled(tenantId, "COD_ENABLED")).toBe(true);
    });

    it("resolves a seeded-disabled feature as disabled", async () => {
      const tenantId = await provisionTenant(uniqueSlug("feat-off"));
      // POD_PHOTO_REQUIRED defaults to false.
      expect(await features.isEnabled(tenantId, "POD_PHOTO_REQUIRED")).toBe(false);
    });

    it("fails closed for a tenant with no such feature row", async () => {
      // A tenant id that was never provisioned has no rows at all.
      const ghost = asTenantId("019f0000-0000-7000-8000-0000000000ff");
      expect(await features.isEnabled(ghost, "COD_ENABLED")).toBe(false);
    });

    it("respects an override that disables a normally-on feature", async () => {
      const tenantId = await provisionTenant(uniqueSlug("feat-override"), {
        featureOverrides: { SMS_ENABLED: false },
      });
      expect(await features.isEnabled(tenantId, "SMS_ENABLED")).toBe(false);
      expect(await features.isEnabled(tenantId, "COD_ENABLED")).toBe(true);
    });

    it("treats an expired feature as disabled", async () => {
      const tenantId = await provisionTenant(uniqueSlug("feat-expired"));
      await withTenantContext(
        database.migrator,
        tenantId,
        (tx) =>
          tx`update tenant_features set expires_at = now() - interval '1 hour' where tenant_id = ${tenantId} and feature_key = 'COD_ENABLED'`,
      );
      expect(await features.isEnabled(tenantId, "COD_ENABLED")).toBe(false);
    });

    it("requireEnabled throws FEATURE_NOT_ENTITLED when disabled", async () => {
      const tenantId = await provisionTenant(uniqueSlug("feat-require"));
      await expect(features.requireEnabled(tenantId, "POD_OTP_REQUIRED")).rejects.toMatchObject({
        code: "FEATURE_NOT_ENTITLED",
      });
    });

    it("enabledKeys lists only the enabled, unexpired features", async () => {
      const tenantId = await provisionTenant(uniqueSlug("feat-keys"));
      const keys = await features.enabledKeys(tenantId);
      expect(keys).toContain("COD_ENABLED");
      expect(keys).not.toContain("POD_PHOTO_REQUIRED");
      expect(keys.length).toBe(11);
    });
  });

  describe("outbox event validation", () => {
    it("rejects an event type that is not domain.fact past tense", () => {
      const outbox = new OutboxService();
      // The validator runs before any DB work; a fake tx is never reached.
      const fakeTx = {} as TenantTransaction;
      return expect(
        outbox.publish(fakeTx, {
          eventType: "ShipmentDelivered",
          aggregateType: "shipment",
          aggregateId: "019f0000-0000-7000-8000-000000000001",
          payload: {},
        }),
      ).rejects.toThrow(/Invalid event type/);
    });
  });
});
