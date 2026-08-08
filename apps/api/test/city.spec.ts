import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuditService, OutboxService } from "../src/modules/platform/index.js";
import { CityService } from "../src/modules/network/application/city.service.js";
import { ZoneService } from "../src/modules/network/application/zone.service.js";
import { normaliseCityKey, searchKeysFor } from "../src/modules/network/domain/city-key.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { ConflictError, NotFoundError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Villes — coverage and tariff.
 *
 * The pure normalisation is tested on its own, because it is the whole feature:
 * if `أريانة` and `Ariana-Ville` do not reduce to the same key, a CSV import
 * silently prices 400 parcels at the wrong tariff and nothing raises an error.
 * The database half then proves the parts normalisation cannot: the collision
 * guard, tenant isolation, and that a retired city stops being quoted.
 *
 * Amounts are TND millimes — 4_500 is 4.500 TND.
 */
describe("cities", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let service: CityService;
  let zones: ZoneService;
  let createdTenants: string[] = [];

  const ACTOR_ID = randomUUID();

  function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run(
      { tenantId: asTenantId(tenantId), actorType: "user", actorId: ACTOR_ID },
      fn,
    );
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  /** The shape most cases start from; every field overridable. */
  function cityInput(overrides: Record<string, unknown> = {}) {
    return {
      code: `C-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "Ariana",
      governorate: "Ariana",
      currency: "TND",
      deliveryFeeMinor: 7_000,
      returnFeeMinor: 3_500,
      ...overrides,
    };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    service = new CityService(db, outbox, new AuditService(db));
    zones = new ZoneService(db, outbox);
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    await database.close();
  });

  // ── The matching key ───────────────────────────────────────────────────────
  describe("normaliseCityKey", () => {
    it("folds case and French accents", () => {
      expect(normaliseCityKey("Béja")).toBe("beja");
      expect(normaliseCityKey("BÉJA")).toBe("beja");
      expect(normaliseCityKey("beja")).toBe("beja");
      expect(normaliseCityKey("Médenine")).toBe("medenine");
    });

    it("collapses punctuation and spacing to a single space", () => {
      expect(normaliseCityKey("Ariana-Ville")).toBe("ariana ville");
      expect(normaliseCityKey("Ariana  Ville")).toBe("ariana ville");
      expect(normaliseCityKey("M'saken")).toBe("m saken");
      expect(normaliseCityKey("  Sousse  ")).toBe("sousse");
    });

    it("unifies the Arabic letter forms that a keyboard chooses between", () => {
      // أ / إ / آ / ٱ are all alef once the hamza is stripped.
      expect(normaliseCityKey("أريانة")).toBe(normaliseCityKey("اريانه"));
      expect(normaliseCityKey("إريانة")).toBe(normaliseCityKey("اريانه"));
      // ة and ه are typed interchangeably at the end of a word.
      expect(normaliseCityKey("سوسة")).toBe(normaliseCityKey("سوسه"));
      // ى → ي.
      expect(normaliseCityKey("ى")).toBe("ي");
    });

    it("strips tashkeel and tatweel, which are decoration not identity", () => {
      expect(normaliseCityKey("سُوسَة")).toBe(normaliseCityKey("سوسة"));
      expect(normaliseCityKey("ســوسة")).toBe(normaliseCityKey("سوسة"));
    });

    it("keeps genuinely different cities apart", () => {
      expect(normaliseCityKey("Sousse")).not.toBe(normaliseCityKey("Sfax"));
      expect(normaliseCityKey("Tunis")).not.toBe(normaliseCityKey("Tunis Nord"));
    });

    it("returns an empty key for input with no letters or digits", () => {
      // Callers must treat "" as NO key. A key that is the empty string would
      // sit in search_keys and overlap with every other row that has one.
      expect(normaliseCityKey("---")).toBe("");
      expect(normaliseCityKey("   ")).toBe("");
    });
  });

  describe("searchKeysFor", () => {
    it("covers the name, the Arabic name and every alias", () => {
      expect(
        searchKeysFor({ name: "Ariana", nameAr: "أريانة", aliases: ["Ariana Ville", "Aryanah"] }),
      ).toEqual(["ariana", "اريانه", "ariana ville", "aryanah"]);
    });

    it("deduplicates without losing order", () => {
      expect(searchKeysFor({ name: "Sousse", aliases: ["SOUSSE", "sousse", "Susah"] })).toEqual([
        "sousse",
        "susah",
      ]);
    });

    it("drops empty keys rather than storing one", () => {
      expect(searchKeysFor({ name: "Gabès", nameAr: null, aliases: ["--", ""] })).toEqual(["gabes"]);
    });
  });

  // ── Writing ────────────────────────────────────────────────────────────────
  describe("create", () => {
    let tenantId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("city-create");
    });

    it("stores the tariff in minor units against its currency", async () => {
      const city = await asStaff(tenantId, () => service.create(cityInput()));

      expect(city.deliveryFeeMinor).toBe(7_000n);
      expect(city.returnFeeMinor).toBe(3_500n);
      expect(city.currency).toBe("TND");
      expect(city.deliveryDelayDays).toBe(1);
      expect(city.active).toBe(true);
    });

    it("derives the search keys — they are never supplied by the caller", async () => {
      const city = await asStaff(tenantId, () =>
        service.create(cityInput({ name: "Béja", nameAr: "باجة", aliases: ["Bajah"] })),
      );

      expect(city.searchKeys).toEqual(["beja", "باجه", "bajah"]);
      // The aliases keep the operator's spelling; only the keys are folded.
      expect(city.aliases).toEqual(["Bajah"]);
    });

    it("upper-cases a lower-case currency rather than failing the foreign key", async () => {
      const city = await asStaff(tenantId, () => service.create(cityInput({ currency: "tnd" })));
      expect(city.currency).toBe("TND");
    });

    it("refuses a duplicate code", async () => {
      await asStaff(tenantId, () => service.create(cityInput({ code: "TUN-01" })));

      await expect(
        asStaff(tenantId, () => service.create(cityInput({ code: "TUN-01", name: "Autre" }))),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("refuses a city that answers to an active city's name", async () => {
      await asStaff(tenantId, () => service.create(cityInput({ name: "Ariana" })));

      // A different spelling of the same place — exactly what must be caught,
      // because two matches make the resolved tariff arbitrary.
      await expect(
        asStaff(tenantId, () => service.create(cityInput({ name: "ARIANA" }))),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("catches a collision hiding in an ALIAS, not just the name", async () => {
      await asStaff(tenantId, () => service.create(cityInput({ name: "Sousse" })));

      await expect(
        asStaff(tenantId, () =>
          service.create(cityInput({ name: "Msaken", aliases: ["sousse"] })),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("allows reuse of a RETIRED city's name", async () => {
      const first = await asStaff(tenantId, () => service.create(cityInput({ name: "Kairouan" })));
      await asStaff(tenantId, () => service.update(first.id, { active: false }));

      const second = await asStaff(tenantId, () => service.create(cityInput({ name: "Kairouan" })));
      expect(second.id).not.toBe(first.id);
    });

    it("records the opening tariff on the audit trail", async () => {
      const city = await asStaff(tenantId, () => service.create(cityInput()));

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ action: string; changes: unknown }[]>`
          select action, changes from audit_log
           where resource_id = ${city.id} and action = 'city.tariff_changed'
        `,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.changes).toMatchObject({
        deliveryFeeMinor: { from: null, to: "7000" },
      });
    });

    it("publishes city.updated with the tariff inside the event", async () => {
      const city = await asStaff(tenantId, () => service.create(cityInput()));

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ event_type: string; payload: Record<string, unknown> }[]>`
          select event_type, payload from outbox where aggregate_id = ${city.id}
        `,
      );
      expect(rows[0]?.event_type).toBe("city.updated");
      // Self-contained: a consumer never reads the table back.
      expect(rows[0]?.payload).toMatchObject({
        code: city.code,
        deliveryFeeMinor: "7000",
        returnFeeMinor: "3500",
        active: true,
      });
    });
  });

  describe("update", () => {
    let tenantId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("city-update");
    });

    it("recomputes the search keys when the name changes", async () => {
      const city = await asStaff(tenantId, () => service.create(cityInput({ name: "Ariana" })));

      const updated = await asStaff(tenantId, () => service.update(city.id, { name: "Aryanah" }));

      // The OLD key must be gone, or the city answers to a name it no longer has.
      expect(updated.searchKeys).toEqual(["aryanah"]);
    });

    it("recomputes the keys when only the aliases change", async () => {
      const city = await asStaff(tenantId, () => service.create(cityInput({ name: "Nabeul" })));

      const updated = await asStaff(tenantId, () =>
        service.update(city.id, { aliases: ["نابل"] }),
      );

      expect(updated.searchKeys).toEqual(["nabeul", "نابل"]);
    });

    it("clears the Arabic name when told to, and drops its key with it", async () => {
      const city = await asStaff(tenantId, () =>
        service.create(cityInput({ name: "Gabès", nameAr: "قابس" })),
      );

      const updated = await asStaff(tenantId, () => service.update(city.id, { nameAr: null }));

      expect(updated.nameAr).toBeNull();
      expect(updated.searchKeys).toEqual(["gabes"]);
    });

    it("does not collide with ITSELF when the name is unchanged", async () => {
      const city = await asStaff(tenantId, () => service.create(cityInput({ name: "Bizerte" })));

      const updated = await asStaff(tenantId, () =>
        service.update(city.id, { deliveryFeeMinor: 9_000 }),
      );
      expect(updated.deliveryFeeMinor).toBe(9_000n);
    });

    it("refuses a rename onto another active city's name", async () => {
      await asStaff(tenantId, () => service.create(cityInput({ name: "Sfax" })));
      const other = await asStaff(tenantId, () => service.create(cityInput({ name: "Gafsa" })));

      await expect(
        asStaff(tenantId, () => service.update(other.id, { name: "SFAX" })),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("audits a fee change with both sides", async () => {
      const city = await asStaff(tenantId, () => service.create(cityInput()));

      await asStaff(tenantId, () => service.update(city.id, { deliveryFeeMinor: 8_500 }));

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ changes: Record<string, unknown> }[]>`
          select changes from audit_log
           where resource_id = ${city.id} and action = 'city.tariff_changed'
           order by created_at asc, id asc
        `,
      );
      expect(rows).toHaveLength(2);
      expect(rows[1]?.changes).toEqual({
        deliveryFeeMinor: { from: "7000", to: "8500" },
      });
    });

    it("does NOT audit a spelling correction as a tariff change", async () => {
      const city = await asStaff(tenantId, () => service.create(cityInput({ name: "Tozeur" })));

      await asStaff(tenantId, () => service.update(city.id, { name: "Tozeur Ville" }));

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ id: string }[]>`
          select id from audit_log
           where resource_id = ${city.id} and action = 'city.tariff_changed'
        `,
      );
      // Only the create. A rename buried among tariff entries makes the trail
      // useless for the one question it is kept to answer.
      expect(rows).toHaveLength(1);
    });

    it("404s on an unknown id", async () => {
      await expect(
        asStaff(tenantId, () => service.update(randomUUID(), { name: "Nowhere" })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── Reading ────────────────────────────────────────────────────────────────
  describe("list", () => {
    let tenantId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("city-list");
      for (const [name, governorate] of [
        ["Tunis", "Tunis"],
        ["Ariana", "Ariana"],
        ["Sousse", "Sousse"],
        ["Msaken", "Sousse"],
      ] as const) {
        await asStaff(tenantId, () => service.create(cityInput({ name, governorate })));
      }
    });

    it("returns the tenant's cities", async () => {
      const page = await asStaff(tenantId, () => service.list());
      expect(page.items).toHaveLength(4);
      expect(page.nextCursor).toBeNull();
    });

    it("filters by governorate", async () => {
      const page = await asStaff(tenantId, () => service.list({ governorate: "Sousse" }));
      expect(page.items.map((c) => c.name).sort()).toEqual(["Msaken", "Sousse"]);
    });

    it("filters by active", async () => {
      const all = await asStaff(tenantId, () => service.list());
      const first = all.items[0];
      if (first === undefined) throw new Error("expected a city");
      await asStaff(tenantId, () => service.update(first.id, { active: false }));

      const active = await asStaff(tenantId, () => service.list({ active: true }));
      expect(active.items).toHaveLength(3);
    });

    it("searches on a normalised PREFIX, so typing three letters is enough", async () => {
      const page = await asStaff(tenantId, () => service.list({ search: "sou" }));
      expect(page.items.map((c) => c.name)).toEqual(["Sousse"]);
    });

    it("searches accent-insensitively", async () => {
      await asStaff(tenantId, () => service.create(cityInput({ name: "Béja" })));

      const page = await asStaff(tenantId, () => service.list({ search: "beja" }));
      expect(page.items.map((c) => c.name)).toEqual(["Béja"]);
    });

    it("pages forward with a cursor and never repeats a row", async () => {
      const first = await asStaff(tenantId, () => service.list({ limit: 2 }));
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await asStaff(tenantId, () =>
        service.list({ limit: 2, cursor: first.nextCursor ?? undefined }),
      );
      const ids = new Set([...first.items, ...second.items].map((c) => c.id));
      expect(ids.size).toBe(4);
      expect(second.nextCursor).toBeNull();
    });
  });

  describe("resolveMany", () => {
    let tenantId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("city-resolve");
      await asStaff(tenantId, () =>
        service.create(
          cityInput({
            code: "TUN-ARIANA",
            name: "Ariana",
            nameAr: "أريانة",
            aliases: ["Ariana Ville"],
            deliveryFeeMinor: 7_000,
          }),
        ),
      );
      await asStaff(tenantId, () =>
        service.create(
          cityInput({ code: "TUN-SFAX", name: "Sfax", governorate: "Sfax", deliveryFeeMinor: 9_500 }),
        ),
      );
    });

    it("matches on the name, an alias, and the Arabic form alike", async () => {
      const matches = await asStaff(tenantId, () =>
        service.resolveMany({ names: ["Ariana", "ariana ville", "أريانة", "اريانه"] }),
      );

      expect(matches.map((m) => m.city?.code)).toEqual([
        "TUN-ARIANA",
        "TUN-ARIANA",
        "TUN-ARIANA",
        "TUN-ARIANA",
      ]);
    });

    it("returns null for a city the courier does not serve", async () => {
      const matches = await asStaff(tenantId, () =>
        service.resolveMany({ names: ["Sfax", "Tataouine"] }),
      );

      expect(matches[0]?.city?.deliveryFeeMinor).toBe(9_500n);
      expect(matches[1]?.city).toBeNull();
      expect(matches[1]?.query).toBe("Tataouine");
    });

    it("preserves the caller's order and count, duplicates included", async () => {
      const matches = await asStaff(tenantId, () =>
        service.resolveMany({ names: ["Sfax", "Ariana", "Sfax"] }),
      );

      // A 500-row CSV must get 500 answers back, positionally aligned.
      expect(matches.map((m) => m.query)).toEqual(["Sfax", "Ariana", "Sfax"]);
      expect(matches.map((m) => m.city?.code)).toEqual(["TUN-SFAX", "TUN-ARIANA", "TUN-SFAX"]);
    });

    it("does NOT quote a retired city", async () => {
      const page = await asStaff(tenantId, () => service.list({ search: "sfax" }));
      const sfax = page.items[0];
      if (sfax === undefined) throw new Error("expected Sfax");
      await asStaff(tenantId, () => service.update(sfax.id, { active: false }));

      const matches = await asStaff(tenantId, () => service.resolveMany({ names: ["Sfax"] }));
      expect(matches[0]?.city).toBeNull();
    });

    it("returns nulls, not an error, when nothing normalises to a key", async () => {
      const matches = await asStaff(tenantId, () => service.resolveMany({ names: ["---", "   ."] }));
      expect(matches.map((m) => m.city)).toEqual([null, null]);
    });
  });

  // ── Isolation ──────────────────────────────────────────────────────────────
  describe("tenant isolation", () => {
    it("never resolves another tenant's city, even with the same name", async () => {
      const alpha = await seedTenant("city-iso-a");
      const beta = await seedTenant("city-iso-b");

      await asStaff(alpha, () =>
        service.create(cityInput({ code: "SHARED", name: "Tunis", deliveryFeeMinor: 5_000 })),
      );
      await asStaff(beta, () =>
        service.create(cityInput({ code: "SHARED", name: "Tunis", deliveryFeeMinor: 12_000 })),
      );

      // Same code AND same name in both tenants: the unique index and the
      // collision guard are both per-tenant, and each sees only its own tariff.
      const forAlpha = await asStaff(alpha, () => service.resolveMany({ names: ["Tunis"] }));
      const forBeta = await asStaff(beta, () => service.resolveMany({ names: ["Tunis"] }));

      expect(forAlpha[0]?.city?.deliveryFeeMinor).toBe(5_000n);
      expect(forBeta[0]?.city?.deliveryFeeMinor).toBe(12_000n);
    });

    it("cannot read another tenant's city by id", async () => {
      const alpha = await seedTenant("city-iso-c");
      const beta = await seedTenant("city-iso-d");
      const city = await asStaff(alpha, () => service.create(cityInput()));

      await expect(asStaff(beta, () => service.getById(city.id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  // ── The zone link ──────────────────────────────────────────────────────────
  describe("zone link", () => {
    it("keeps the tariff when the zone it referenced is retired", async () => {
      const tenantId = await seedTenant("city-zone");
      const zone = await asStaff(tenantId, () =>
        zones.create({
          code: "Z-CITY",
          name: "Grand Tunis",
          boundary: {
            type: "Polygon",
            coordinates: [
              [
                [10.0, 36.7],
                [10.3, 36.7],
                [10.3, 36.9],
                [10.0, 36.9],
                [10.0, 36.7],
              ],
            ],
          },
        }),
      );

      const city = await asStaff(tenantId, () =>
        service.create(cityInput({ name: "Le Bardo", zoneId: zone.id })),
      );
      expect(city.zoneId).toBe(zone.id);

      const listed = await asStaff(tenantId, () => service.list({ zoneId: zone.id }));
      expect(listed.items.map((c) => c.id)).toEqual([city.id]);
    });
  });
});
