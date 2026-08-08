import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AddressService, MerchantService } from "../src/modules/directory/index.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { NoteService } from "../src/modules/note/application/note.service.js";
import { AuditService, OutboxService } from "../src/modules/platform/index.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { NotFoundError, ValidationError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Remarques, against a real PostgreSQL.
 *
 * The two properties worth proving are both database guarantees:
 *
 *  1. A written body cannot change — enforced by a trigger, so the test attacks
 *     it with direct SQL, not through the service that already refuses.
 *  2. A note cannot point at a subject that does not exist, or at one in
 *     another tenant — enforced by three foreign keys, which is the entire
 *     reason this table is not (subject_type, subject_id).
 */
describe("notes", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let notes: NoteService;
  let merchants: MerchantService;
  let createdTenants: string[] = [];

  const AUTHOR_ID = randomUUID();

  function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run(
      { tenantId: asTenantId(tenantId), actorType: "user", actorId: AUTHOR_ID },
      fn,
    );
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  /** A real user row, because `author_user_id` is a foreign key. */
  async function seedUser(tenantId: string): Promise<string> {
    const email = `staff-${Math.random().toString(36).slice(2, 8)}@test.tn`;
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, full_name, status)
        values (${tenantId}, ${email}, 'hash', ${"Amine " + email}, 'ACTIVE')
        returning id
      `,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to provision user");
    return row.id;
  }

  async function seedMerchant(tenantId: string): Promise<string> {
    const merchant = await asStaff(tenantId, () =>
      merchants.create({
        name: "Boutique Remarque",
        code: `M-${Math.random().toString(36).slice(2, 8)}`,
      }),
    );
    return merchant.id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    notes = new NoteService(db);
    merchants = new MerchantService(
      db,
      outbox,
      new AuditService(db),
      new AddressService(db, outbox, new ManualGeocodingProvider()),
    );
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    await database.close();
  });

  // ── Writing ────────────────────────────────────────────────────────────────
  describe("create", () => {
    let tenantId: string;
    let merchantId: string;
    let userId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("note-create");
      merchantId = await seedMerchant(tenantId);
      userId = await seedUser(tenantId);
    });

    it("records the remark against its subject and its author", async () => {
      const note = await asStaff(tenantId, () =>
        notes.create(
          { subjectType: "MERCHANT", subjectId: merchantId, body: "Colis toujours sous-pesés" },
          userId,
        ),
      );

      expect(note.subjectType).toBe("MERCHANT");
      expect(note.subjectId).toBe(merchantId);
      expect(note.body).toBe("Colis toujours sous-pesés");
      expect(note.authorUserId).toBe(userId);
      expect(note.pinned).toBe(false);
      expect(note.resolvedAt).toBeNull();
    });

    it("resolves the author's NAME in the same query", async () => {
      const note = await asStaff(tenantId, () =>
        notes.create({ subjectType: "MERCHANT", subjectId: merchantId, body: "Note" }, userId),
      );
      // A list of remarks with only user ids is unreadable, and one query per
      // row to fix that is the N+1 the join exists to prevent.
      expect(note.authorName).toContain("Amine");
    });

    it("refuses a subject that does not exist, as a FIELD error", async () => {
      await expect(
        asStaff(tenantId, () =>
          notes.create({ subjectType: "MERCHANT", subjectId: randomUUID(), body: "x" }, userId),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses a subject belonging to ANOTHER tenant", async () => {
      const other = await seedTenant("note-create-other");
      const otherMerchant = await seedMerchant(other);

      // The foreign key cannot see the other tenant's row through RLS, so this
      // fails the same way a nonexistent id does — which is the correct answer
      // and, importantly, discloses nothing about whether it exists.
      await expect(
        asStaff(tenantId, () =>
          notes.create({ subjectType: "MERCHANT", subjectId: otherMerchant, body: "x" }, userId),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a body of whitespace", async () => {
      await expect(
        asStaff(tenantId, () =>
          notes.create({ subjectType: "MERCHANT", subjectId: merchantId, body: "   " }, userId),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a note with two subjects", async () => {
      // The discriminated union has no shape that carries both, so this is
      // refused at the boundary rather than by `notes_one_subject_chk`.
      await expect(
        asStaff(tenantId, () =>
          notes.create(
            {
              subjectType: "MERCHANT",
              subjectId: merchantId,
              shipmentId: randomUUID(),
              body: "x",
            },
            userId,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a note with no subject at all", async () => {
      await expect(
        asStaff(tenantId, () => notes.create({ body: "orphan" }, userId)),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // ── Immutability ───────────────────────────────────────────────────────────
  describe("immutability", () => {
    let tenantId: string;
    let merchantId: string;
    let userId: string;
    let noteId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("note-frozen");
      merchantId = await seedMerchant(tenantId);
      userId = await seedUser(tenantId);
      const note = await asStaff(tenantId, () =>
        notes.create(
          { subjectType: "MERCHANT", subjectId: merchantId, body: "written on Tuesday" },
          userId,
        ),
      );
      noteId = note.id;
    });

    it("refuses an edit to the body, from DIRECT SQL", async () => {
      // Through the service this is impossible — `updateNoteSchema` has no body
      // field. The guarantee has to hold against SQL, or it is a convention.
      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`update notes set body = 'rewritten' where id = ${noteId}`,
        ),
      ).rejects.toThrow(/written/u);
    });

    it("refuses reattaching the note to a different subject", async () => {
      const otherMerchant = await seedMerchant(tenantId);
      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`update notes set merchant_id = ${otherMerchant} where id = ${noteId}`,
        ),
      ).rejects.toThrow(/reattached/u);
    });

    it("refuses reattributing it to another author", async () => {
      const otherUser = await seedUser(tenantId);
      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`update notes set author_user_id = ${otherUser} where id = ${noteId}`,
        ),
      ).rejects.toThrow(/reattributed/u);
    });

    it("still allows the state to change — pinned and resolved are not content", async () => {
      const pinned = await asStaff(tenantId, () => notes.update(noteId, { pinned: true }, userId));
      expect(pinned.pinned).toBe(true);
    });
  });

  // ── Resolution ─────────────────────────────────────────────────────────────
  describe("resolve", () => {
    let tenantId: string;
    let merchantId: string;
    let userId: string;
    let noteId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("note-resolve");
      merchantId = await seedMerchant(tenantId);
      userId = await seedUser(tenantId);
      const note = await asStaff(tenantId, () =>
        notes.create({ subjectType: "MERCHANT", subjectId: merchantId, body: "open item" }, userId),
      );
      noteId = note.id;
    });

    it("stamps the time AND the actor together", async () => {
      const resolved = await asStaff(tenantId, () =>
        notes.update(noteId, { resolved: true }, userId),
      );

      // `notes_resolution_chk` treats them as a pair: a resolution with no
      // resolver records nothing.
      expect(resolved.resolvedAt).not.toBeNull();
      expect(resolved.resolvedByUserId).toBe(userId);
    });

    it("clears BOTH halves when reopened", async () => {
      await asStaff(tenantId, () => notes.update(noteId, { resolved: true }, userId));
      const reopened = await asStaff(tenantId, () =>
        notes.update(noteId, { resolved: false }, userId),
      );

      expect(reopened.resolvedAt).toBeNull();
      expect(reopened.resolvedByUserId).toBeNull();
    });

    it("drops the note out of the open queue", async () => {
      const before = await asStaff(tenantId, () => notes.openCount());
      await asStaff(tenantId, () => notes.update(noteId, { resolved: true }, userId));
      const after = await asStaff(tenantId, () => notes.openCount());

      expect(before).toBe(1);
      expect(after).toBe(0);
    });

    it("404s on an unknown id", async () => {
      await expect(
        asStaff(tenantId, () => notes.update(randomUUID(), { pinned: true }, userId)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── Reading ────────────────────────────────────────────────────────────────
  describe("list", () => {
    let tenantId: string;
    let merchantId: string;
    let otherMerchantId: string;
    let userId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("note-list");
      merchantId = await seedMerchant(tenantId);
      otherMerchantId = await seedMerchant(tenantId);
      userId = await seedUser(tenantId);

      for (const body of ["premier", "deuxième", "troisième"]) {
        await asStaff(tenantId, () =>
          notes.create({ subjectType: "MERCHANT", subjectId: merchantId, body }, userId),
        );
      }
      await asStaff(tenantId, () =>
        notes.create(
          { subjectType: "MERCHANT", subjectId: otherMerchantId, body: "autre client" },
          userId,
        ),
      );
    });

    it("defaults to OPEN notes — the queue is the open set", async () => {
      const all = await asStaff(tenantId, () => notes.list());
      expect(all.items).toHaveLength(4);

      const first = all.items[0];
      if (first === undefined) throw new Error("expected a note");
      await asStaff(tenantId, () => notes.update(first.id, { resolved: true }, userId));

      const open = await asStaff(tenantId, () => notes.list());
      expect(open.items).toHaveLength(3);
      const resolved = await asStaff(tenantId, () => notes.list({ resolved: true }));
      expect(resolved.items.map((n) => n.id)).toEqual([first.id]);
    });

    it("narrows to one subject", async () => {
      const page = await asStaff(tenantId, () =>
        notes.list({ subjectType: "MERCHANT", subjectId: otherMerchantId }),
      );
      expect(page.items.map((n) => n.body)).toEqual(["autre client"]);
    });

    it("refuses HALF a subject filter rather than listing every subject", async () => {
      // A type without an id would show another merchant's remarks on this
      // merchant's panel. Silently ignoring the filter is the dangerous option.
      await expect(
        asStaff(tenantId, () => notes.list({ subjectType: "MERCHANT" })),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        asStaff(tenantId, () => notes.list({ subjectId: merchantId })),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("puts pinned notes first, then newest", async () => {
      const page = await asStaff(tenantId, () =>
        notes.list({ subjectType: "MERCHANT", subjectId: merchantId }),
      );
      expect(page.items.map((n) => n.body)).toEqual(["troisième", "deuxième", "premier"]);

      const oldest = page.items[2];
      if (oldest === undefined) throw new Error("expected three notes");
      await asStaff(tenantId, () => notes.update(oldest.id, { pinned: true }, userId));

      const pinnedFirst = await asStaff(tenantId, () =>
        notes.list({ subjectType: "MERCHANT", subjectId: merchantId }),
      );
      expect(pinnedFirst.items.map((n) => n.body)).toEqual(["premier", "troisième", "deuxième"]);
    });

    it("pages forward without repeating a row", async () => {
      const first = await asStaff(tenantId, () => notes.list({ limit: 2 }));
      expect(first.items).toHaveLength(2);

      const second = await asStaff(tenantId, () =>
        notes.list({ limit: 2, cursor: first.nextCursor ?? undefined }),
      );
      const ids = new Set([...first.items, ...second.items].map((n) => n.id));
      expect(ids.size).toBe(4);
    });

    it("filters by author", async () => {
      const other = await seedUser(tenantId);
      await asStaff(tenantId, () =>
        notes.create({ subjectType: "MERCHANT", subjectId: merchantId, body: "par un autre" }, other),
      );

      const page = await asStaff(tenantId, () => notes.list({ authorUserId: other }));
      expect(page.items.map((n) => n.body)).toEqual(["par un autre"]);
    });
  });

  // ── Isolation ──────────────────────────────────────────────────────────────
  describe("tenant isolation", () => {
    it("never lists or reads another tenant's notes", async () => {
      const alpha = await seedTenant("note-iso-a");
      const beta = await seedTenant("note-iso-b");
      const merchantId = await seedMerchant(alpha);
      const userId = await seedUser(alpha);

      const note = await asStaff(alpha, () =>
        notes.create({ subjectType: "MERCHANT", subjectId: merchantId, body: "privé" }, userId),
      );

      const seenByBeta = await asStaff(beta, () => notes.list());
      expect(seenByBeta.items).toHaveLength(0);
      expect(await asStaff(beta, () => notes.openCount())).toBe(0);
      await expect(asStaff(beta, () => notes.getById(note.id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});
