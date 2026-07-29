import { randomUUID } from "node:crypto";

import jsQR from "jsqr";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { TokenService } from "../src/modules/identity/application/token.service.js";
import type { Principal } from "../src/modules/identity/application/token.service.js";
import { ROLES, permissionsForRoles } from "../src/modules/identity/domain/permissions.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { LabelService } from "../src/modules/shipment/application/label.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { NotFoundError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

function tokenConfig() {
  const values: Record<string, unknown> = {
    JWT_ACCESS_SECRET: "test-secret-that-is-at-least-32-characters-long",
    JWT_ACCESS_TTL_SECONDS: 900,
    DRIVER_ACCESS_TTL_SECONDS: 3_600,
  };
  return { get: (key: string) => values[key] } as never;
}

describe("merchant portal", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let shipments: ShipmentService;
  let merchants: MerchantService;
  let labels: LabelService;
  let tokens: TokenService;
  let createdTenants: string[] = [];

  /** Runs as courier staff — no merchant narrowing. */
  async function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  /** Runs as a merchant login — narrowed by invariant I24. */
  async function asMerchant<T>(
    tenantId: string,
    merchantId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "user", merchantId }, fn);
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  async function seedMerchant(tenantId: string, name: string): Promise<string> {
    return asStaff(tenantId, async () => (await merchants.create({ name })).id);
  }

  async function createShipment(
    tenantId: string,
    merchantId: string,
    run: "staff" | "merchant" = "staff",
  ): Promise<{ id: string; trackingNumber: string }> {
    const input = {
      idempotencyKey: randomUUID(),
      merchantId,
      senderName: "Boutique",
      senderPhone: "+21620000001",
      origin: { rawInput: "Tunis", countryCode: "TN", coordinates: { lat: 36.8, lng: 10.18 } },
      recipientName: "Ahmed Ben Ali",
      recipientPhone: "+21620000002",
      destination: { rawInput: "Sfax", countryCode: "TN", coordinates: { lat: 34.74, lng: 10.76 } },
      currency: "TND",
      codAmountMinor: 45_000,
    };
    const ctx = { actor: { actorType: "API_CLIENT" as const } };
    const created =
      run === "staff"
        ? await asStaff(tenantId, () => shipments.create(input, ctx))
        : await asMerchant(tenantId, merchantId, () => shipments.create(input, ctx));
    return { id: created.id, trackingNumber: created.trackingNumber };
  }

  /** Provisions a merchant user the way an admin would: user row + MERCHANT role. */
  async function provisionMerchantUser(
    tenantId: string,
    merchantId: string,
    email: string,
  ): Promise<string> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        with u as (
          insert into users (tenant_id, email, password_hash, full_name, status, merchant_id)
          values (${tenantId}, ${email}, 'hash', 'Merchant User', 'ACTIVE', ${merchantId})
          returning id
        )
        insert into user_roles (tenant_id, user_id, role)
        select ${tenantId}, u.id, 'MERCHANT' from u
        returning user_id as id
      `,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to provision merchant user");
    return row.id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    merchants = new MerchantService(db, outbox);
    const recipients = new RecipientService(db);
    const events = new ShipmentEventService(outbox);
    shipments = new ShipmentService(db, events, outbox, merchants, recipients, addresses);
    labels = new LabelService(shipments);
    tokens = new TokenService(tokenConfig());
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── The role ───────────────────────────────────────────────────────────────

  describe("role", () => {
    it("exists and is scoped to a merchant's own work", () => {
      expect(ROLES).toContain("MERCHANT");
      const granted = permissionsForRoles(["MERCHANT"]);

      // What a merchant needs.
      expect(granted.has("shipment:create")).toBe(true);
      expect(granted.has("shipment:read")).toBe(true);
      expect(granted.has("shipment:label")).toBe(true);
      expect(granted.has("pickup:create")).toBe(true);
      expect(granted.has("cod:read_amount")).toBe(true);
      expect(granted.has("settlement:read")).toBe(true);
    });

    it("grants NOTHING about the courier's own operations", () => {
      const granted = permissionsForRoles(["MERCHANT"]);
      // A merchant is a customer of the tenant, not a member of it.
      for (const denied of [
        "route:read",
        "route:create",
        "driver:read",
        "driver:location:read_live",
        "vehicle:read",
        "hub:read",
        "manifest:read",
        "manifest:seal",
        "user:read",
        "merchant:read",
        "shipment:assign",
        "shipment:override_status",
        "settlement:approve",
        "telemetry:write",
      ] as const) {
        expect(granted.has(denied)).toBe(false);
      }
    });

    it("does not grant recipient access while recipients are tenant-scoped", () => {
      // docs/02 §3.19 says merchants must not see each other's address books,
      // but `recipients` has no merchant_id yet. Granting it would leak a
      // competitor's customer list, so it stays denied until the table is scoped.
      const granted = permissionsForRoles(["MERCHANT"]);
      expect(granted.has("recipient:read")).toBe(false);
      expect(granted.has("recipient:create")).toBe(false);
    });
  });

  // ── Invariant I23 — merchantId iff MERCHANT role ───────────────────────────

  describe("invariant I23", () => {
    it("rejects a MERCHANT user with no merchant_id", async () => {
      const tenantId = await seedTenant("mp-i23-nomerchant");

      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`
            with u as (
              insert into users (tenant_id, email, password_hash, full_name)
              values (${tenantId}, 'a@x.tn', 'h', 'A') returning id
            )
            insert into user_roles (tenant_id, user_id, role)
            select ${tenantId}, u.id, 'MERCHANT' from u
          `,
        ),
      ).rejects.toThrow(/invariant I23/iu);
    });

    it("rejects a non-merchant role carrying merchant_id", async () => {
      const tenantId = await seedTenant("mp-i23-wrongrole");
      const merchantId = await seedMerchant(tenantId, "Boutique");

      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`
            with u as (
              insert into users (tenant_id, email, password_hash, full_name, merchant_id)
              values (${tenantId}, 'b@x.tn', 'h', 'B', ${merchantId}) returning id
            )
            insert into user_roles (tenant_id, user_id, role)
            select ${tenantId}, u.id, 'DISPATCHER' from u
          `,
        ),
      ).rejects.toThrow(/invariant I23/iu);
    });

    it("accepts the two together", async () => {
      const tenantId = await seedTenant("mp-i23-valid");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const userId = await provisionMerchantUser(tenantId, merchantId, "c@x.tn");
      expect(userId).toEqual(expect.any(String));
    });

    it("rejects a merchant from a different tenant", async () => {
      const tenantA = await seedTenant("mp-i23-crossa");
      const tenantB = await seedTenant("mp-i23-crossb");
      const merchantOfB = await seedMerchant(tenantB, "Theirs");

      await expect(provisionMerchantUser(tenantA, merchantOfB, "d@x.tn")).rejects.toThrow(
        /different tenant/iu,
      );
    });
  });

  // ── Invariant I24 — row scoping, enforced by RLS ───────────────────────────

  describe("invariant I24", () => {
    it("shows a merchant only their own shipments", async () => {
      const tenantId = await seedTenant("mp-i24-scope");
      const alpha = await seedMerchant(tenantId, "Alpha");
      const beta = await seedMerchant(tenantId, "Beta");
      await createShipment(tenantId, alpha);
      await createShipment(tenantId, beta);

      // Courier staff see the whole tenant, exactly as before.
      const staffView = await asStaff(tenantId, () => shipments.list({}));
      expect(staffView.items).toHaveLength(2);

      const alphaView = await asMerchant(tenantId, alpha, () => shipments.list({}));
      expect(alphaView.items).toHaveLength(1);
      expect(alphaView.items[0]?.merchantId).toBe(alpha);

      const betaView = await asMerchant(tenantId, beta, () => shipments.list({}));
      expect(betaView.items).toHaveLength(1);
      expect(betaView.items[0]?.merchantId).toBe(beta);
    });

    it("refuses a merchant asking for a rival's shipment BY ID", async () => {
      const tenantId = await seedTenant("mp-i24-byid");
      const alpha = await seedMerchant(tenantId, "Alpha");
      const beta = await seedMerchant(tenantId, "Beta");
      const theirs = await createShipment(tenantId, beta);

      // Postgres refuses — not a WHERE clause someone remembered to write.
      await expect(
        asMerchant(tenantId, alpha, () => shipments.getById(theirs.id)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses a merchant naming a rival's id in a filter", async () => {
      const tenantId = await seedTenant("mp-i24-filter");
      const alpha = await seedMerchant(tenantId, "Alpha");
      const beta = await seedMerchant(tenantId, "Beta");
      await createShipment(tenantId, beta);

      // The controller takes merchantId from the query string, so this is the
      // exact shape of an attempt to widen one's own scope by asking.
      const page = await asMerchant(tenantId, alpha, () => shipments.list({ merchantId: beta }));
      expect(page.items).toHaveLength(0);
    });

    it("hides a rival's shipment from tracking-number lookup", async () => {
      const tenantId = await seedTenant("mp-i24-tracking");
      const alpha = await seedMerchant(tenantId, "Alpha");
      const beta = await seedMerchant(tenantId, "Beta");
      const theirs = await createShipment(tenantId, beta);

      const found = await asMerchant(tenantId, alpha, () =>
        shipments.findByTrackingNumber(theirs.trackingNumber),
      );
      expect(found).toBeNull();
    });

    it("lets a merchant create and then read back their own parcel", async () => {
      const tenantId = await seedTenant("mp-i24-roundtrip");
      const alpha = await seedMerchant(tenantId, "Alpha");

      const own = await createShipment(tenantId, alpha, "merchant");
      const read = await asMerchant(tenantId, alpha, () => shipments.getById(own.id));
      expect(read.id).toBe(own.id);
      expect(read.merchantId).toBe(alpha);
    });

    it("does not narrow courier staff at all", async () => {
      const tenantId = await seedTenant("mp-i24-staff");
      const alpha = await seedMerchant(tenantId, "Alpha");
      const beta = await seedMerchant(tenantId, "Beta");
      await createShipment(tenantId, alpha);
      await createShipment(tenantId, beta);

      const all = await asStaff(tenantId, () => shipments.list({}));
      expect(all.items).toHaveLength(2);
    });
  });

  // ── Token scope ────────────────────────────────────────────────────────────

  describe("token", () => {
    function principal(overrides: Partial<Principal> = {}): Principal {
      const roles = overrides.roles ?? (["MERCHANT"] as const);
      return {
        userId: randomUUID(),
        tenantId: randomUUID(),
        actorType: "user",
        roles: [...roles],
        permissions: permissionsForRoles([...roles]),
        hubScope: [],
        merchantId: randomUUID(),
        sessionId: randomUUID(),
        ...overrides,
      };
    }

    it("round-trips the merchant scope through a signed token", async () => {
      const original = principal();
      const { token } = await tokens.issueAccessToken(original);
      const resolved = await tokens.authenticate(token);

      expect(resolved?.merchantId).toBe(original.merchantId);
      expect(resolved?.roles).toContain("MERCHANT");
    });

    it("carries no merchant scope for a non-merchant role", async () => {
      const { token } = await tokens.issueAccessToken(
        principal({ roles: ["DISPATCHER"], merchantId: null }),
      );
      const resolved = await tokens.authenticate(token);
      expect(resolved?.merchantId).toBeNull();
    });

    it("REJECTS a MERCHANT token with no merchant scope", async () => {
      // Would otherwise be read as "no narrowing" and see the whole tenant —
      // the exact escalation this role must never have.
      const { token } = await tokens.issueAccessToken(principal({ merchantId: null }));
      expect(await tokens.authenticate(token)).toBeNull();
    });

    it("REJECTS a non-merchant token that carries a merchant scope", async () => {
      const { token } = await tokens.issueAccessToken(principal({ roles: ["DISPATCHER"] }));
      expect(await tokens.authenticate(token)).toBeNull();
    });
  });

  // ── Labels ─────────────────────────────────────────────────────────────────

  describe("label", () => {
    it("renders a QR that DECODES back to the tracking number", async () => {
      const tenantId = await seedTenant("mp-label-decode");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const parcel = await createShipment(tenantId, merchantId);

      const label = await asStaff(tenantId, () => labels.render(parcel.id));
      expect(label.trackingNumber).toBe(parcel.trackingNumber);

      // Actually decode the pixels. Asserting "a PNG was produced" would pass
      // even if it encoded the wrong string — the whole point is that a scanner
      // in a depot reads back exactly what the scan endpoints expect.
      const png = PNG.sync.read(label.qrPng);
      const decoded = jsQR(Uint8ClampedArray.from(png.data), png.width, png.height);

      expect(decoded).not.toBeNull();
      expect(decoded?.data).toBe(parcel.trackingNumber);
    });

    it("encodes the bare tracking number, not a URL or JSON", async () => {
      const tenantId = await seedTenant("mp-label-payload");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const parcel = await createShipment(tenantId, merchantId);

      const label = await asStaff(tenantId, () => labels.render(parcel.id));
      const png = PNG.sync.read(label.qrPng);
      const decoded = jsQR(Uint8ClampedArray.from(png.data), png.width, png.height);

      // A scanned label must drop straight into the existing scan endpoints,
      // which all take the bare tracking number.
      expect(decoded?.data).not.toContain("http");
      expect(decoded?.data).not.toContain("{");
      expect(decoded?.data).toMatch(/^SD-/u);
    });

    it("also returns an embeddable data URI", async () => {
      const tenantId = await seedTenant("mp-label-datauri");
      const merchantId = await seedMerchant(tenantId, "Boutique");
      const parcel = await createShipment(tenantId, merchantId);

      const label = await asStaff(tenantId, () => labels.render(parcel.id));
      expect(label.qrDataUri).toMatch(/^data:image\/png;base64,/u);
      expect(label.recipientName).toBe("Ahmed Ben Ali");
    });

    it("refuses to render a rival merchant's label", async () => {
      const tenantId = await seedTenant("mp-label-scope");
      const alpha = await seedMerchant(tenantId, "Alpha");
      const beta = await seedMerchant(tenantId, "Beta");
      const theirs = await createShipment(tenantId, beta);

      // A not-found, not a picture of a competitor's parcel.
      await expect(
        asMerchant(tenantId, alpha, () => labels.render(theirs.id)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError for an unknown shipment", async () => {
      const tenantId = await seedTenant("mp-label-missing");
      await expect(asStaff(tenantId, () => labels.render(randomUUID()))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});
