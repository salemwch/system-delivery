import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { PasswordService } from "../src/modules/identity/application/password.service.js";
import { UserService } from "../src/modules/identity/application/user.service.js";
import { createUserSchema } from "../src/modules/identity/domain/dtos.js";
import { ROLES, permissionsForRoles } from "../src/modules/identity/domain/permissions.js";
import { PickupService } from "../src/modules/pickup/application/pickup.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
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

/**
 * The COMMERCIAL role and the portfolio scope (invariant I25, migration 0030).
 *
 * The point of every test below is the same one: a commercial must see their
 * own book of business and NOTHING ELSE inside a tenant that also holds their
 * colleagues' accounts. That is enforced in Row-Level Security, so it is
 * verified here against real policies on a real PostgreSQL — a mocked
 * repository would agree with whatever the service happened to do.
 *
 * Each isolation test asserts BOTH directions. "The commercial sees their own"
 * passing on its own proves nothing: a policy that was never attached passes it
 * too, and only the "does not see the other's" half catches that.
 */
describe("commercial portfolio", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let merchants: MerchantService;
  let shipments: ShipmentService;
  let addresses: AddressService;
  let pickups: PickupService;
  let users: UserService;
  let createdTenants: string[] = [];

  /** Runs as courier staff — tenant-wide, no portfolio narrowing. */
  async function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  /** Runs as a commercial login — narrowed to the merchants they manage. */
  async function asCommercial<T>(
    tenantId: string,
    accountManagerId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return TenantContext.run(
      { tenantId: asTenantId(tenantId), actorType: "user", actorId: accountManagerId, accountManagerId },
      fn,
    );
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  /** Provisions a staff user with the given role, the way an admin would. */
  async function seedUser(tenantId: string, role: string, email: string): Promise<string> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        with u as (
          insert into users (tenant_id, email, password_hash, full_name, status)
          values (${tenantId}, ${email}, 'hash', ${email}, 'ACTIVE')
          returning id
        )
        insert into user_roles (tenant_id, user_id, role)
        select ${tenantId}, u.id, ${role} from u
        returning user_id as id
      `,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to provision user");
    return row.id;
  }

  async function createShipment(tenantId: string, merchantId: string): Promise<string> {
    const created = await asStaff(tenantId, () =>
      shipments.create(
        {
          idempotencyKey: randomUUID(),
          merchantId,
          senderName: "Boutique",
          senderPhone: "+21620000001",
          origin: { rawInput: "Tunis", countryCode: "TN", coordinates: { lat: 36.8, lng: 10.18 } },
          recipientName: "Ahmed Ben Ali",
          recipientPhone: "+21620000002",
          destination: {
            rawInput: "Sfax",
            countryCode: "TN",
            coordinates: { lat: 34.74, lng: 10.76 },
          },
          currency: "TND",
          codAmountMinor: 45_000,
        },
        { actor: { actorType: "API_CLIENT" as const } },
      ),
    );
    return created.id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const audit = new AuditService(db);
    addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    pickups = new PickupService(db, outbox);
    merchants = new MerchantService(db, outbox, audit);
    const recipients = new RecipientService(db);
    shipments = new ShipmentService(
      db,
      new ShipmentEventService(outbox),
      outbox,
      merchants,
      recipients,
      addresses,
      new OperatingConfigService(db),
    );
    users = new UserService(db, new PasswordService(), outbox, audit);
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
    it("exists and can sign a merchant up, collect from them, and follow the account", () => {
      expect(ROLES).toContain("COMMERCIAL");
      const granted = permissionsForRoles(["COMMERCIAL"]);

      // Sign them up, including the portal login.
      expect(granted.has("merchant:create")).toBe(true);
      expect(granted.has("merchant:update")).toBe(true);
      expect(granted.has("merchant:onboard")).toBe(true);
      // Go and collect the parcels.
      expect(granted.has("pickup:create")).toBe(true);
      expect(granted.has("pickup:accept")).toBe(true);
      expect(granted.has("pickup:collect")).toBe(true);
      // Answer "how is my account doing?".
      expect(granted.has("shipment:read")).toBe(true);
      expect(granted.has("cod:read_amount")).toBe(true);
      expect(granted.has("settlement:read")).toBe(true);
      expect(granted.has("complaint:create")).toBe(true);
    });

    it("cannot mint arbitrary logins, take a colleague's accounts, or read the address book", () => {
      const granted = permissionsForRoles(["COMMERCIAL"]);

      // `merchant:onboard` exists precisely so this one is not needed.
      expect(granted.has("user:manage")).toBe(false);
      expect(granted.has("role:assign")).toBe(false);
      // The escalation the portfolio scope exists to prevent.
      expect(granted.has("merchant:assign_manager")).toBe(false);
      // Recipients are tenant-scoped and carry no merchant, so RLS cannot narrow
      // them — the read would hand over the whole customer list.
      expect(granted.has("recipient:read")).toBe(false);
      // Suspending an account is the courier's decision, not the salesperson's.
      expect(granted.has("merchant:block")).toBe(false);
      // The operations plane is none of their business.
      expect(granted.has("route:create")).toBe(false);
      expect(granted.has("driver:location:read_live")).toBe(false);
      expect(granted.has("manifest:seal")).toBe(false);
      expect(granted.has("ledger:adjust")).toBe(false);
    });

    it("refuses to be combined with a tenant-wide role", () => {
      const result = createUserSchema.safeParse({
        email: "hybrid@courier.tn",
        fullName: "Hybrid",
        roles: ["COMMERCIAL", "DISPATCHER"],
      });
      expect(result.success).toBe(false);
    });

    it("accepts a commercial on its own, with no merchant id", () => {
      const result = createUserSchema.safeParse({
        email: "salem@courier.tn",
        fullName: "Salem",
        roles: ["COMMERCIAL"],
      });
      expect(result.success).toBe(true);
    });
  });

  // ── Ownership on creation ──────────────────────────────────────────────────

  describe("signing a merchant up", () => {
    it("makes the commercial who registered it the account manager", async () => {
      const tenantId = await seedTenant("com-own");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);

      const merchant = await asCommercial(tenantId, salem, () =>
        merchants.create({ name: "Boutique Farah" }),
      );

      expect(merchant.accountManagerId).toBe(salem);
    });

    it("leaves a merchant registered by staff house-managed", async () => {
      const tenantId = await seedTenant("com-house");

      const merchant = await asStaff(tenantId, () => merchants.create({ name: "Walk-in" }));

      expect(merchant.accountManagerId).toBeNull();
    });
  });

  // ── The isolation itself ───────────────────────────────────────────────────

  describe("row-level isolation", () => {
    it("shows a commercial their own merchants and neither a colleague's nor the house's", async () => {
      const tenantId = await seedTenant("com-rls");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);
      const nadia = await seedUser(tenantId, "COMMERCIAL", `nadia-${randomUUID()}@courier.tn`);

      const mine = await asCommercial(tenantId, salem, () => merchants.create({ name: "Mine" }));
      const theirs = await asCommercial(tenantId, nadia, () => merchants.create({ name: "Theirs" }));
      const house = await asStaff(tenantId, () => merchants.create({ name: "House" }));

      const visible = await asCommercial(tenantId, salem, () => merchants.list());
      const ids = visible.items.map((m) => m.id);

      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
      expect(ids).not.toContain(house.id);

      // And the single-row read agrees with the list — a 404, never a leak.
      await expect(asCommercial(tenantId, salem, () => merchants.getById(theirs.id))).rejects.toThrow(
        NotFoundError,
      );
    });

    it("still shows courier staff every merchant in the tenant", async () => {
      const tenantId = await seedTenant("com-staff");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);

      const owned = await asCommercial(tenantId, salem, () => merchants.create({ name: "Owned" }));
      const house = await asStaff(tenantId, () => merchants.create({ name: "House" }));

      const visible = await asStaff(tenantId, () => merchants.list());
      const ids = visible.items.map((m) => m.id);

      expect(ids).toContain(owned.id);
      expect(ids).toContain(house.id);
    });

    it("narrows shipments to the parcels of the merchants they manage", async () => {
      const tenantId = await seedTenant("com-ship");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);
      const nadia = await seedUser(tenantId, "COMMERCIAL", `nadia-${randomUUID()}@courier.tn`);

      const mine = await asCommercial(tenantId, salem, () => merchants.create({ name: "Mine" }));
      const theirs = await asCommercial(tenantId, nadia, () => merchants.create({ name: "Theirs" }));

      const ownShipment = await createShipment(tenantId, mine.id);
      const otherShipment = await createShipment(tenantId, theirs.id);

      const own = await asCommercial(tenantId, salem, () => shipments.getById(ownShipment));
      expect(own.id).toBe(ownShipment);

      await expect(
        asCommercial(tenantId, salem, () => shipments.getById(otherShipment)),
      ).rejects.toThrow(NotFoundError);
    });

    it("narrows every merchant-bearing table, not only the ones a service reads", async () => {
      const tenantId = await seedTenant("com-tables");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);
      const nadia = await seedUser(tenantId, "COMMERCIAL", `nadia-${randomUUID()}@courier.tn`);

      const mine = await asCommercial(tenantId, salem, () => merchants.create({ name: "Mine" }));
      const theirs = await asCommercial(tenantId, nadia, () => merchants.create({ name: "Theirs" }));

      // Asserted through the policy functions directly rather than by wiring up
      // four more services: this proves the predicate itself, which is the thing
      // that would silently be missing from a table someone forgets to list.
      const verdicts = await database.app.begin(async (tx) => {
        await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx`select set_config('app.current_account_manager_id', ${salem}, true)`;
        return tx<{ own: boolean; other: boolean; orphan: boolean }[]>`
          select current_portfolio_allows(${mine.id}::uuid)  as own,
                 current_portfolio_allows(${theirs.id}::uuid) as other,
                 current_portfolio_allows(null::uuid)         as orphan
        `;
      });

      const verdict = verdicts[0];
      expect(verdict?.own).toBe(true);
      expect(verdict?.other).toBe(false);
      // Fails CLOSED on a row with no merchant: that row is the courier's own
      // operation, not any commercial's.
      expect(verdict?.orphan).toBe(false);
    });

    it("is a no-op for every session that is not a commercial login", async () => {
      const tenantId = await seedTenant("com-noop");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);
      const theirs = await asCommercial(tenantId, salem, () => merchants.create({ name: "Theirs" }));

      const verdicts = await database.app.begin(async (tx) => {
        await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx`select set_config('app.current_account_manager_id', '', true)`;
        return tx<{ any_merchant: boolean; orphan: boolean }[]>`
          select current_portfolio_allows(${theirs.id}::uuid) as any_merchant,
                 current_portfolio_allows(null::uuid)          as orphan
        `;
      });

      const verdict = verdicts[0];
      expect(verdict?.any_merchant).toBe(true);
      // Unscoped sessions are not narrowed at all — including on rows with no
      // merchant, which staff must keep seeing.
      expect(verdict?.orphan).toBe(true);
    });
  });

  // ── Onboarding the portal login ────────────────────────────────────────────

  describe("merchant portal login", () => {
    it("mints a MERCHANT login for a merchant the commercial manages", async () => {
      const tenantId = await seedTenant("com-login");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);
      const merchant = await asCommercial(tenantId, salem, () =>
        merchants.create({ name: "Boutique Farah" }),
      );

      const created = await asCommercial(tenantId, salem, () =>
        users.createMerchantLogin({
          merchantId: merchant.id,
          email: `farah-${randomUUID()}@boutique.tn`,
          fullName: "Farah Ben Salah",
        }),
      );

      expect(created.user.roles).toEqual(["MERCHANT"]);
      expect(created.user.merchantId).toBe(merchant.id);
      // Generated, returned once, never stored in plaintext.
      expect(created.temporaryPassword).not.toBeNull();
      expect(created.temporaryPassword?.length).toBeGreaterThan(16);
    });

    it("refuses — as a plain 404 — to mint one for a colleague's merchant", async () => {
      const tenantId = await seedTenant("com-login-x");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);
      const nadia = await seedUser(tenantId, "COMMERCIAL", `nadia-${randomUUID()}@courier.tn`);
      const theirs = await asCommercial(tenantId, nadia, () => merchants.create({ name: "Theirs" }));

      // 404 rather than 403: confirming the id exists would turn this endpoint
      // into an oracle for enumerating a colleague's book of business.
      await expect(
        asCommercial(tenantId, salem, () =>
          users.createMerchantLogin({
            merchantId: theirs.id,
            email: `intruder-${randomUUID()}@boutique.tn`,
            fullName: "Intruder",
          }),
        ),
      ).rejects.toThrow(NotFoundError);
    });

    it("lets courier staff onboard any merchant, portfolio or not", async () => {
      const tenantId = await seedTenant("com-login-staff");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);
      const theirs = await asCommercial(tenantId, salem, () => merchants.create({ name: "Theirs" }));

      const created = await asStaff(tenantId, () =>
        users.createMerchantLogin({
          merchantId: theirs.id,
          email: `owner-made-${randomUUID()}@boutique.tn`,
          fullName: "Owner Made",
        }),
      );

      expect(created.user.merchantId).toBe(theirs.id);
    });
  });

  // ── The collection run ─────────────────────────────────────────────────────

  describe("collecting parcels", () => {
    /** Requests and accepts a pickup for a merchant, returning its id. */
    async function pendingPickup(
      tenantId: string,
      commercialId: string,
      merchantId: string,
    ): Promise<string> {
      return asCommercial(tenantId, commercialId, async () => {
        const addressId = await asStaff(tenantId, async () =>
          (
            await addresses.resolve({
              rawInput: "Avenue Habib Bourguiba, Tunis",
              countryCode: "TN",
              coordinates: { lat: 36.8, lng: 10.18 },
            })
          ).addressId,
        );
        const from = new Date(Date.now() + 60 * 60 * 1000);
        const to = new Date(from.getTime() + 2 * 60 * 60 * 1000);
        const created = await pickups.request(
          {
            idempotencyKey: randomUUID(),
            merchantId,
            pickupAddressId: addressId,
            contactName: "Farah",
            contactPhone: "+21620000003",
            requestedWindowFrom: from.toISOString(),
            requestedWindowTo: to.toISOString(),
          },
          { actorId: commercialId },
        );
        await pickups.accept(
          created.id,
          { idempotencyKey: randomUUID() },
          { actorId: commercialId },
        );
        return created.id;
      });
    }

    it("lets a commercial claim their own merchant's run, naming themselves", async () => {
      const tenantId = await seedTenant("com-claim");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);
      const merchant = await asCommercial(tenantId, salem, () =>
        merchants.create({ name: "Mine" }),
      );
      const pickupId = await pendingPickup(tenantId, salem, merchant.id);

      const claimed = await asCommercial(tenantId, salem, () =>
        pickups.claim(pickupId, { idempotencyKey: randomUUID() }, { actorId: salem }),
      );

      expect(claimed.status).toBe("ASSIGNED");
      // The collector is the caller — there is no field on the command that
      // could have named anyone else.
      expect(claimed.assignedDriverId).toBe(salem);
      // Claimed runs are errands, not sequenced stops on an optimised route.
      expect(claimed.assignedRouteStopId).toBeNull();
    });

    it("cannot claim a run belonging to a colleague's merchant", async () => {
      const tenantId = await seedTenant("com-claim-x");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);
      const nadia = await seedUser(tenantId, "COMMERCIAL", `nadia-${randomUUID()}@courier.tn`);
      const theirs = await asCommercial(tenantId, nadia, () => merchants.create({ name: "Theirs" }));
      const pickupId = await pendingPickup(tenantId, nadia, theirs.id);

      // RLS never returns the row, so this is a 404 — not a forbidden, which
      // would confirm the pickup exists.
      await expect(
        asCommercial(tenantId, salem, () =>
          pickups.claim(pickupId, { idempotencyKey: randomUUID() }, { actorId: salem }),
        ),
      ).rejects.toThrow(NotFoundError);
    });

    it("holds claim but NOT assign — it cannot route another person's work", () => {
      const granted = permissionsForRoles(["COMMERCIAL"]);
      expect(granted.has("pickup:claim")).toBe(true);
      expect(granted.has("pickup:assign")).toBe(false);
    });
  });

  // ── Moving an account ──────────────────────────────────────────────────────

  describe("account reassignment", () => {
    it("moves visibility with the account, in both directions", async () => {
      const tenantId = await seedTenant("com-move");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);
      const nadia = await seedUser(tenantId, "COMMERCIAL", `nadia-${randomUUID()}@courier.tn`);
      const merchant = await asCommercial(tenantId, salem, () =>
        merchants.create({ name: "Moving" }),
      );

      await asStaff(tenantId, () =>
        merchants.assignAccountManager(merchant.id, { accountManagerId: nadia }),
      );

      const nadiaSees = await asCommercial(tenantId, nadia, () => merchants.list());
      expect(nadiaSees.items.map((m) => m.id)).toContain(merchant.id);

      const salemSees = await asCommercial(tenantId, salem, () => merchants.list());
      expect(salemSees.items.map((m) => m.id)).not.toContain(merchant.id);
    });

    it("unassigns to house-managed, which no commercial can see", async () => {
      const tenantId = await seedTenant("com-unassign");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);
      const merchant = await asCommercial(tenantId, salem, () =>
        merchants.create({ name: "Reclaimed" }),
      );

      const updated = await asStaff(tenantId, () =>
        merchants.assignAccountManager(merchant.id, { accountManagerId: null }),
      );

      expect(updated.accountManagerId).toBeNull();
      const salemSees = await asCommercial(tenantId, salem, () => merchants.list());
      expect(salemSees.items.map((m) => m.id)).not.toContain(merchant.id);
    });

    it("records the move in the audit trail, naming both sides", async () => {
      const tenantId = await seedTenant("com-audit");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);
      const nadia = await seedUser(tenantId, "COMMERCIAL", `nadia-${randomUUID()}@courier.tn`);
      const merchant = await asCommercial(tenantId, salem, () =>
        merchants.create({ name: "Audited" }),
      );

      await asStaff(tenantId, () =>
        merchants.assignAccountManager(merchant.id, { accountManagerId: nadia }),
      );

      const entries = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ action: string; changes: Record<string, { from: unknown; to: unknown }> }[]>`
          select action, changes from audit_log
           where resource_id = ${merchant.id}
             and action = 'merchant.account_manager_assigned'
        `,
      );

      expect(entries).toHaveLength(1);
      // Both sides: an entry that named only the new owner could not answer who
      // lost the account.
      expect(entries[0]?.changes["accountManagerId"]?.from).toBe(salem);
      expect(entries[0]?.changes["accountManagerId"]?.to).toBe(nadia);
    });

    it("is idempotent — reassigning to the same manager writes nothing", async () => {
      const tenantId = await seedTenant("com-idem");
      const salem = await seedUser(tenantId, "COMMERCIAL", `salem-${randomUUID()}@courier.tn`);
      const merchant = await asCommercial(tenantId, salem, () =>
        merchants.create({ name: "Stable" }),
      );

      await asStaff(tenantId, () =>
        merchants.assignAccountManager(merchant.id, { accountManagerId: salem }),
      );

      const entries = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ action: string }[]>`
          select action from audit_log
           where resource_id = ${merchant.id}
             and action = 'merchant.account_manager_assigned'
        `,
      );
      expect(entries).toHaveLength(0);
    });

    it("refuses a manager from another tenant", async () => {
      const tenantA = await seedTenant("com-cross-a");
      const tenantB = await seedTenant("com-cross-b");
      const outsider = await seedUser(tenantB, "COMMERCIAL", `outsider-${randomUUID()}@other.tn`);
      const merchant = await asStaff(tenantA, () => merchants.create({ name: "Target" }));

      await expect(
        asStaff(tenantA, () =>
          merchants.assignAccountManager(merchant.id, { accountManagerId: outsider }),
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
