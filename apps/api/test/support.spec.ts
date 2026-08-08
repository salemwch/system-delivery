import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AddressService, MerchantService } from "../src/modules/directory/index.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { AuditService, OutboxService } from "../src/modules/platform/index.js";
import { SupportService } from "../src/modules/support/application/support.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError, NotFoundError, ValidationError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Support — the merchant/back-office conversation.
 *
 * ⚠️ THE TEST THAT MATTERS MOST IS THE INTERNAL-NOTE ONE. A back office needs to
 * write "this merchant always underpays" on the ticket, and the merchant must
 * not read it. That is enforced by RLS, so the test asserts it from a MERCHANT
 * CONTEXT rather than by checking a filter — a filter is one forgotten WHERE
 * clause away from disclosure, and a test of the filter would pass anyway.
 */
describe("support tickets", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let support: SupportService;
  let merchants: MerchantService;
  let createdTenants: string[] = [];

  const STAFF_ID = randomUUID();

  /** Back office: full tenant scope, no merchant narrowing. */
  function asStaff<T>(tenantId: string, fn: () => Promise<T>, actorId = STAFF_ID): Promise<T> {
    return TenantContext.run(
      { tenantId: asTenantId(tenantId), actorType: "user", actorId },
      fn,
    );
  }

  /** A merchant portal login: narrowed to one merchant (invariant I24). */
  function asMerchant<T>(
    tenantId: string,
    merchantId: string,
    fn: () => Promise<T>,
    actorId = STAFF_ID,
  ): Promise<T> {
    return TenantContext.run(
      { tenantId: asTenantId(tenantId), actorType: "user", actorId, merchantId },
      fn,
    );
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  async function seedUser(tenantId: string): Promise<string> {
    const email = `u-${Math.random().toString(36).slice(2, 8)}@test.tn`;
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, full_name, status)
        values (${tenantId}, ${email}, 'hash', 'Agent', 'ACTIVE')
        returning id`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed user");
    return row.id;
  }

  async function seedMerchant(tenantId: string, name = "Boutique Support"): Promise<string> {
    const merchant = await asStaff(tenantId, () =>
      merchants.create({ name, code: `M-${Math.random().toString(36).slice(2, 8)}` }),
    );
    return merchant.id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    merchants = new MerchantService(
      db,
      outbox,
      new AuditService(db),
      new AddressService(db, outbox, new ManualGeocodingProvider()),
    );
    support = new SupportService(db, outbox);
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    await database.close();
  });

  // ── Opening ────────────────────────────────────────────────────────────────
  describe("open", () => {
    let tenantId: string;
    let merchantId: string;
    let userId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("sup-open");
      merchantId = await seedMerchant(tenantId);
      userId = await seedUser(tenantId);
    });

    it("opens with the first message and a quotable reference", async () => {
      const view = await asMerchant(
        tenantId,
        merchantId,
        () =>
          support.open(
            { subject: "Facture en double", body: "J'ai été facturé deux fois." },
            userId,
            "MERCHANT",
          ),
        userId,
      );

      expect(view.ticket.status).toBe("OPEN");
      expect(view.ticket.merchantId).toBe(merchantId);
      // Quoted down the phone, so it has to be short and readable.
      expect(view.ticket.reference).toMatch(/^S-\d{4}-\d{5}$/u);
      expect(view.messages).toHaveLength(1);
      expect(view.messages[0]?.authorSide).toBe("MERCHANT");
      expect(view.messages[0]?.visibility).toBe("PUBLIC");
    });

    it("numbers references sequentially within a tenant", async () => {
      const first = await asMerchant(tenantId, merchantId, () =>
        support.open({ subject: "Un", body: "…" }, userId, "MERCHANT"),
      );
      const second = await asMerchant(tenantId, merchantId, () =>
        support.open({ subject: "Deux", body: "…" }, userId, "MERCHANT"),
      );

      const year = new Date().getUTCFullYear();
      expect(first.ticket.reference).toBe(`S-${String(year)}-00001`);
      expect(second.ticket.reference).toBe(`S-${String(year)}-00002`);
    });

    it("takes the merchant from the TOKEN, not the body", async () => {
      const other = await seedMerchant(tenantId, "Rival");

      // Naming someone else is refused rather than silently rescoped: a client
      // that believed it opened a ticket for another merchant should be told it
      // did not.
      await expect(
        asMerchant(tenantId, merchantId, () =>
          support.open({ subject: "X", body: "…", merchantId: other }, userId, "MERCHANT"),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("requires staff to name the merchant", async () => {
      // Staff have no ambient merchant, so there is nothing to infer — and
      // guessing would file the ticket against the wrong account.
      await expect(
        asStaff(tenantId, () => support.open({ subject: "X", body: "…" }, userId, "COURIER")),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("lets staff open one on a merchant's behalf — the phone-call case", async () => {
      const view = await asStaff(tenantId, () =>
        support.open({ subject: "Appel client", body: "Demande par téléphone", merchantId }, userId, "COURIER"),
      );
      expect(view.ticket.merchantId).toBe(merchantId);
      expect(view.messages[0]?.authorSide).toBe("COURIER");
    });

    it("refuses a ticket with no question", async () => {
      await expect(
        asMerchant(tenantId, merchantId, () =>
          support.open({ subject: "Vide", body: "   " }, userId, "MERCHANT"),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("publishes support.ticket_opened", async () => {
      const view = await asMerchant(tenantId, merchantId, () =>
        support.open({ subject: "Facturation", body: "…", category: "BILLING" }, userId, "MERCHANT"),
      );

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ event_type: string; payload: Record<string, unknown> }[]>`
          select event_type, payload from outbox where aggregate_id = ${view.ticket.id}`,
      );
      expect(rows[0]?.event_type).toBe("support.ticket_opened");
      expect(rows[0]?.payload).toMatchObject({
        reference: view.ticket.reference,
        category: "BILLING",
      });
    });
  });

  // ── The thread ─────────────────────────────────────────────────────────────
  describe("reply", () => {
    let tenantId: string;
    let merchantId: string;
    let userId: string;
    let ticketId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("sup-reply");
      merchantId = await seedMerchant(tenantId);
      userId = await seedUser(tenantId);
      const view = await asMerchant(tenantId, merchantId, () =>
        support.open({ subject: "Question", body: "Première question" }, userId, "MERCHANT"),
      );
      ticketId = view.ticket.id;
    });

    it("a courier reply puts the ball in the merchant's court", async () => {
      const view = await asStaff(tenantId, () =>
        support.reply(ticketId, { body: "Pouvez-vous préciser ?" }, userId, "COURIER"),
      );

      // PENDING_MERCHANT exists so a ticket waiting on the person who raised it
      // does not sit in the courier's backlog making the queue permanently red.
      expect(view.ticket.status).toBe("PENDING_MERCHANT");
    });

    it("a merchant reply puts it back", async () => {
      await asStaff(tenantId, () => support.reply(ticketId, { body: "Précisez ?" }, userId, "COURIER"));
      const view = await asMerchant(tenantId, merchantId, () =>
        support.reply(ticketId, { body: "Voici" }, userId, "MERCHANT"),
      );

      expect(view.ticket.status).toBe("OPEN");
      expect(view.messages).toHaveLength(3);
    });

    it("an INTERNAL note does not move the ticket", async () => {
      const view = await asStaff(tenantId, () =>
        support.reply(ticketId, { body: "Client mauvais payeur", internal: true }, userId, "COURIER"),
      );

      // Nobody is waiting on a remark the merchant cannot see; flipping to
      // PENDING_MERCHANT would tell the queue someone had been asked a question
      // that was never sent.
      expect(view.ticket.status).toBe("OPEN");
    });

    it("⚠️ HIDES an internal note from the merchant entirely", async () => {
      await asStaff(tenantId, () =>
        support.reply(ticketId, { body: "Ne pas accorder de crédit", internal: true }, userId, "COURIER"),
      );

      const staffView = await asStaff(tenantId, () => support.getById(ticketId));
      expect(staffView.messages).toHaveLength(2);

      // The whole point. RLS removes the row — this code never learns it was
      // withheld, which is what makes it impossible to leak by forgetting a
      // filter.
      const merchantView = await asMerchant(tenantId, merchantId, () =>
        support.getById(ticketId),
      );
      expect(merchantView.messages).toHaveLength(1);
      expect(merchantView.messages.map((m) => m.body)).toEqual(["Première question"]);
    });

    it("refuses an internal note from a merchant", async () => {
      // Also refused by `support_messages_internal_chk`; caught in the service so
      // the caller gets a field error rather than a raw 23514.
      await expect(
        asMerchant(tenantId, merchantId, () =>
          support.reply(ticketId, { body: "secret", internal: true }, userId, "MERCHANT"),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses a reply to a CLOSED ticket", async () => {
      await asStaff(tenantId, () => support.update(ticketId, { status: "CLOSED" }, userId));

      await expect(
        asStaff(tenantId, () => support.reply(ticketId, { body: "encore" }, userId, "COURIER")),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("keeps the thread in the order it was written", async () => {
      await asStaff(tenantId, () => support.reply(ticketId, { body: "Deux" }, userId, "COURIER"));
      await asMerchant(tenantId, merchantId, () =>
        support.reply(ticketId, { body: "Trois" }, userId, "MERCHANT"),
      );

      const view = await asStaff(tenantId, () => support.getById(ticketId));
      expect(view.messages.map((m) => m.body)).toEqual(["Première question", "Deux", "Trois"]);
    });
  });

  // ── Managing ───────────────────────────────────────────────────────────────
  describe("update", () => {
    let tenantId: string;
    let merchantId: string;
    let userId: string;
    let ticketId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("sup-update");
      merchantId = await seedMerchant(tenantId);
      userId = await seedUser(tenantId);
      const view = await asMerchant(tenantId, merchantId, () =>
        support.open({ subject: "Question", body: "…" }, userId, "MERCHANT"),
      );
      ticketId = view.ticket.id;
    });

    it("stamps the closer, and clears both halves on reopen", async () => {
      const closed = await asStaff(tenantId, () =>
        support.update(ticketId, { status: "CLOSED" }, userId),
      );
      expect(closed.ticket.closedAt).not.toBeNull();
      expect(closed.ticket.closedByUserId).toBe(userId);

      const reopened = await asStaff(tenantId, () =>
        support.update(ticketId, { status: "OPEN" }, userId),
      );
      // `support_tickets_closed_chk` treats them as a pair; leaving one behind
      // fails the constraint.
      expect(reopened.ticket.closedAt).toBeNull();
      expect(reopened.ticket.closedByUserId).toBeNull();
    });

    it("assigns and unassigns", async () => {
      const assignee = await seedUser(tenantId);
      const assigned = await asStaff(tenantId, () =>
        support.update(ticketId, { assignedToUserId: assignee }, userId),
      );
      expect(assigned.ticket.assignedToUserId).toBe(assignee);

      const pooled = await asStaff(tenantId, () =>
        support.update(ticketId, { assignedToUserId: null }, userId),
      );
      expect(pooled.ticket.assignedToUserId).toBeNull();
    });

    it("recategorises", async () => {
      const view = await asStaff(tenantId, () =>
        support.update(ticketId, { category: "BILLING" }, userId),
      );
      expect(view.ticket.category).toBe("BILLING");
    });

    it("404s on an unknown ticket", async () => {
      await expect(
        asStaff(tenantId, () => support.update(randomUUID(), { status: "CLOSED" }, userId)),
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
      tenantId = await seedTenant("sup-list");
      merchantId = await seedMerchant(tenantId, "Alpha");
      otherMerchantId = await seedMerchant(tenantId, "Beta");
      userId = await seedUser(tenantId);

      for (const subject of ["Un", "Deux"]) {
        await asMerchant(tenantId, merchantId, () =>
          support.open({ subject, body: "…" }, userId, "MERCHANT"),
        );
      }
      await asMerchant(tenantId, otherMerchantId, () =>
        support.open({ subject: "Rival", body: "…" }, userId, "MERCHANT"),
      );
    });

    it("shows staff every ticket in the tenant", async () => {
      expect((await asStaff(tenantId, () => support.list())).items).toHaveLength(3);
    });

    it("⚠️ shows a merchant only their OWN tickets", async () => {
      const mine = await asMerchant(tenantId, merchantId, () => support.list());
      expect(mine.items.map((t) => t.subject).sort()).toEqual(["Deux", "Un"]);
    });

    it("counts what still needs an answer, and stops once closed", async () => {
      expect(await asStaff(tenantId, () => support.openCount())).toBe(3);

      const all = await asStaff(tenantId, () => support.list());
      const first = all.items[0];
      if (first === undefined) throw new Error("expected a ticket");
      await asStaff(tenantId, () => support.update(first.id, { status: "CLOSED" }, userId));

      expect(await asStaff(tenantId, () => support.openCount())).toBe(2);
    });

    it("counts PENDING_MERCHANT as still open", async () => {
      const all = await asStaff(tenantId, () => support.list());
      const first = all.items[0];
      if (first === undefined) throw new Error("expected a ticket");
      await asStaff(tenantId, () => support.reply(first.id, { body: "?" }, userId, "COURIER"));

      // Waiting on the merchant is not resolved — it is still an open thread,
      // and a queue that dropped it would lose tickets nobody ever answers.
      expect(await asStaff(tenantId, () => support.openCount())).toBe(3);
    });

    it("filters to what still needs an answer", async () => {
      const all = await asStaff(tenantId, () => support.list());
      const first = all.items[0];
      if (first === undefined) throw new Error("expected a ticket");
      await asStaff(tenantId, () => support.update(first.id, { status: "CLOSED" }, userId));

      const open = await asStaff(tenantId, () => support.list({ openOnly: true }));
      expect(open.items).toHaveLength(2);
    });

    it("pages forward without repeating a row", async () => {
      const first = await asStaff(tenantId, () => support.list({ limit: 2 }));
      expect(first.items).toHaveLength(2);

      const second = await asStaff(tenantId, () =>
        support.list({ limit: 2, cursor: first.nextCursor ?? undefined }),
      );
      const ids = new Set([...first.items, ...second.items].map((t) => t.id));
      expect(ids.size).toBe(3);
    });
  });

  // ── Isolation ──────────────────────────────────────────────────────────────
  describe("tenant isolation", () => {
    it("never shows another tenant's tickets", async () => {
      const alpha = await seedTenant("sup-iso-a");
      const beta = await seedTenant("sup-iso-b");
      const merchantId = await seedMerchant(alpha);
      const userId = await seedUser(alpha);

      const view = await asMerchant(alpha, merchantId, () =>
        support.open({ subject: "Privé", body: "…" }, userId, "MERCHANT"),
      );

      expect((await asStaff(beta, () => support.list())).items).toHaveLength(0);
      expect(await asStaff(beta, () => support.openCount())).toBe(0);
      await expect(asStaff(beta, () => support.getById(view.ticket.id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("numbers references independently per tenant", async () => {
      const alpha = await seedTenant("sup-iso-c");
      const beta = await seedTenant("sup-iso-d");
      const year = new Date().getUTCFullYear();

      const alphaMerchant = await seedMerchant(alpha);
      const alphaUser = await seedUser(alpha);
      const betaMerchant = await seedMerchant(beta);
      const betaUser = await seedUser(beta);

      const a = await asStaff(alpha, () =>
        support.open({ subject: "A", body: "…", merchantId: alphaMerchant }, alphaUser, "COURIER"),
      );
      const b = await asStaff(beta, () =>
        support.open({ subject: "B", body: "…", merchantId: betaMerchant }, betaUser, "COURIER"),
      );

      // Both are the first ticket OF THEIR OWN tenant.
      expect(a.ticket.reference).toBe(`S-${String(year)}-00001`);
      expect(b.ticket.reference).toBe(`S-${String(year)}-00001`);
    });
  });
});
