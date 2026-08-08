import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Every tenant-scoped foreign key is composite (migration 0036).
 *
 * ⚠️ THIS IS THE TEST THAT FOUND THE BUG, generalised.
 *
 * A foreign key check does not go through Row-Level Security — Postgres runs it
 * with the privileges needed to see the whole referenced table, which is what
 * makes foreign keys work at all. Before 0036 that meant `REFERENCES merchants
 * (id)` accepted a merchant belonging to another tenant: the insert succeeded,
 * the row was invisible to the merchant's real tenant, and nothing anywhere
 * reported a problem.
 *
 * Two things are proven here, and the second matters as much as the first:
 *
 *  1. A cross-tenant reference is now REFUSED. Attempted as `dp_migrator` with
 *     the tenant GUC set — i.e. with RLS out of the way — because RLS is not
 *     what is being tested. If the constraint is the only thing standing in the
 *     way, the constraint has to be the thing that says no.
 *
 *  2. `ON DELETE SET NULL (column)` still works. A composite SET NULL without a
 *     column list nulls EVERY referencing column, `tenant_id` included — and
 *     `tenant_id` is NOT NULL, so the delete fails at runtime, months after this
 *     migration was reviewed and passed.
 */
describe("composite tenant foreign keys", () => {
  let database: TestDatabase;
  let alpha: string;
  let beta: string;
  let createdTenants: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    alpha = await createTenant(database.migrator, "fk-alpha");
    beta = await createTenant(database.migrator, "fk-beta");
    createdTenants = [alpha, beta];
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    await database.close();
  });

  /** A merchant owned by `tenantId`. */
  async function seedMerchant(tenantId: string): Promise<string> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into merchants (tenant_id, name, code, status)
        values (${tenantId}, 'FK probe', ${`FK-${Math.random().toString(36).slice(2, 8)}`}, 'ACTIVE')
        returning id`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed merchant");
    return row.id;
  }

  /** A zone owned by `tenantId` — the SET NULL parent. */
  async function seedZone(tenantId: string): Promise<string> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into zones (tenant_id, code, name, boundary)
        values (
          ${tenantId},
          ${`Z-${Math.random().toString(36).slice(2, 8)}`},
          'FK probe zone',
          ST_SetSRID(ST_Multi(ST_GeomFromText(
            'POLYGON((10 36, 10.2 36, 10.2 36.2, 10 36.2, 10 36))')), 4326)::geography
        )
        returning id`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed zone");
    return row.id;
  }

  async function seedCity(tenantId: string, zoneId: string | null): Promise<string> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into cities (tenant_id, code, name, governorate, currency,
                            delivery_fee_minor, return_fee_minor, zone_id)
        values (${tenantId}, ${`C-${Math.random().toString(36).slice(2, 8)}`},
                'FK probe city', 'Tunis', 'TND', 0, 0, ${zoneId})
        returning id`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed city");
    return row.id;
  }

  /** A user owned by `tenantId` — invoices record who drafted them. */
  async function seedUser(tenantId: string): Promise<string> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, full_name, status)
        values (${tenantId}, ${`fk-${Math.random().toString(36).slice(2, 8)}@test.tn`},
                'hash', 'FK probe', 'ACTIVE')
        returning id`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed user");
    return row.id;
  }

  it("refuses a merchant from another tenant on an INVOICE", async () => {
    const foreign = await seedMerchant(beta);
    const author = await seedUser(alpha);

    // The single-column key accepted this. It is the most damaging instance in
    // the schema: an invoice is a tax document, and one bound to another
    // tenant's merchant is a legal record naming a party that never agreed.
    await expect(
      withTenantContext(
        database.migrator,
        alpha,
        (tx) => tx`
          insert into invoices (tenant_id, merchant_id, kind, status, period_from,
                                period_to, currency, subtotal_minor, vat_rate_bp,
                                vat_amount_minor, stamp_duty_minor, total_minor,
                                created_by_user_id)
          values (${alpha}, ${foreign}, 'INVOICE', 'DRAFT', '2026-08-01', '2026-08-31',
                  'TND', 0, 1900, 0, 0, 0, ${author})`,
      ),
    ).rejects.toThrow(/foreign key/iu);
  });

  it("refuses a merchant from another tenant on a USER's sub-tenant scope", async () => {
    const foreign = await seedMerchant(beta);

    // `users.merchant_id` is invariant I24 — the claim that narrows a MERCHANT
    // login to one merchant. Pointing it at another tenant's merchant would
    // scope a login across the tenant boundary, which is the single worst
    // instance of this bug in the schema.
    await expect(
      withTenantContext(
        database.migrator,
        alpha,
        (tx) => tx`
          insert into users (tenant_id, email, password_hash, full_name, status, merchant_id)
          values (${alpha}, ${`fk-${Math.random().toString(36).slice(2, 8)}@test.tn`},
                  'hash', 'FK probe', 'ACTIVE', ${foreign})`,
      ),
    ).rejects.toThrow(/foreign key/iu);
  });

  it("refuses a zone from another tenant on a CITY", async () => {
    const foreign = await seedZone(beta);

    await expect(seedCity(alpha, foreign)).rejects.toThrow(/foreign key/iu);
  });

  it("still accepts a reference within the SAME tenant", async () => {
    // The constraint must reject the cross-tenant case WITHOUT rejecting the
    // ordinary one — a test that only proves refusal would also pass against a
    // foreign key that refuses everything.
    const own = await seedZone(alpha);
    await expect(seedCity(alpha, own)).resolves.toBeTypeOf("string");
  });

  it("still accepts NULL, because MATCH SIMPLE skips the check", async () => {
    // Every nullable foreign key in the schema depends on this. If the composite
    // key were MATCH FULL, a NULL child column with a non-null tenant_id would
    // be rejected and half the schema would stop accepting writes.
    await expect(seedCity(alpha, null)).resolves.toBeTypeOf("string");
  });

  it("nulls ONLY the referencing column on delete, not tenant_id", async () => {
    const zone = await seedZone(alpha);
    const city = await seedCity(alpha, zone);

    // ⚠️ The failure this guards against: `ON DELETE SET NULL` without a column
    // list nulls tenant_id too, which is NOT NULL — so this delete would raise
    // 23502 and the tenant could never retire a zone again.
    await withTenantContext(
      database.migrator,
      alpha,
      (tx) => tx`delete from zones where id = ${zone}`,
    );

    const rows = await withTenantContext(
      database.migrator,
      alpha,
      (tx) => tx<{ tenant_id: string; zone_id: string | null }[]>`
        select tenant_id, zone_id from cities where id = ${city}`,
    );
    expect(rows[0]?.zone_id).toBeNull();
    expect(rows[0]?.tenant_id).toBe(alpha);
  });

  it("leaves no single-column foreign key to a tenant-scoped parent", async () => {
    // The generalisation. A future migration that adds `REFERENCES merchants
    // (id)` reopens the hole silently — this fails the moment it does, and names
    // the constraint.
    const rows = await database.migrator<{ name: string; child: string }[]>`
      select con.conname as name, child.relname as child
        from pg_constraint con
        join pg_class child on child.oid = con.conrelid
        join pg_class parent on parent.oid = con.confrelid
        join pg_namespace n on n.oid = child.relnamespace
       where con.contype = 'f'
         and n.nspname = 'public'
         and array_length(con.conkey, 1) = 1
         and exists (select 1 from pg_attribute pa
                      where pa.attrelid = con.confrelid
                        and pa.attname = 'tenant_id' and pa.attnum > 0)
         and exists (select 1 from pg_attribute ca
                      where ca.attrelid = con.conrelid
                        and ca.attname = 'tenant_id' and ca.attnum > 0)
       order by 1`;

    expect(rows.map((r) => `${r.child}.${r.name}`)).toEqual([]);
  });
});
