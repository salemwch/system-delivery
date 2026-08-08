import { Injectable } from "@nestjs/common";
import { and, desc, eq, lt, sql } from "drizzle-orm";

import { AuditService, OutboxService, TenantService } from "../../platform/index.js";
import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { CurrencyService } from "../../../shared/money/index.js";
import { renderInvoiceDocument, toInvoiceLocale } from "../domain/invoice-document.js";
import {
  NUMBER_PREFIX,
  computeInvoiceTotals,
  formatDocumentNumber,
} from "../domain/invoice-totals.js";
import {
  addInvoiceLineSchema,
  createCreditNoteSchema,
  createInvoiceSchema,
  listInvoicesSchema,
  updateBillingSettingsSchema,
} from "../domain/dtos.js";
import { billingSettings, invoiceLines, invoices } from "../domain/schema.js";
import type { BillingSettings, Invoice, InvoiceLine } from "../domain/schema.js";

/** An invoice with its lines, which is the only way anyone reads one. */
export interface InvoiceView {
  readonly invoice: Invoice;
  readonly lines: readonly InvoiceLine[];
}

export interface InvoicePage {
  readonly items: readonly Invoice[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Defaults for a tenant that has never opened the billing settings.
 *
 * Carries the same SHAPE as a stored row, nulls included. A narrower object
 * would force every consumer to branch on whether the row exists — and the
 * document renderer, the response mapper and the party snapshot would each
 * invent their own way of doing it.
 */
const FALLBACK_SETTINGS = {
  vatRateBp: 1900,
  stampDutyMinor: 1000n,
  paymentTermsDays: 30,
  legalName: null,
  taxIdentifier: null,
  legalAddress: null,
} as const;

/**
 * Factures and avoirs.
 *
 * An invoice here is a TAX DOCUMENT, and three rules follow from that. Each is
 * enforced by the database as well as by this service — the service gives a
 * readable error, the database guarantees the property:
 *
 *  1. **Numbers are gapless.** A missing number reads to an auditor as a
 *     destroyed invoice.
 *  2. **An issued invoice is immutable.** Corrections are credit notes.
 *  3. **The totals are arithmetic.** Computed in one pure function
 *     ({@link computeInvoiceTotals}) and re-checked by a CHECK constraint.
 */
@Injectable()
export class InvoiceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly tenants: TenantService,
    private readonly currency: CurrencyService,
  ) {}

  /**
   * Opens a draft. No number is taken — an abandoned draft must consume none.
   *
   * The VAT rate is copied onto the invoice at creation rather than read at
   * issue time, so a rate change tomorrow cannot silently alter a draft an
   * operator has already reviewed.
   */
  async createDraft(input: unknown, actorId: string): Promise<InvoiceView> {
    const dto = parseWithZod(createInvoiceSchema, input);

    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const settings = await this.settingsFor(tx);

      const totals = computeInvoiceTotals(
        dto.lines ?? [],
        settings.vatRateBp,
        settings.stampDutyMinor,
      );

      const inserted = await tx
        .insert(invoices)
        .values({
          tenantId,
          merchantId: dto.merchantId,
          kind: "INVOICE",
          status: "DRAFT",
          periodFrom: dto.periodFrom,
          periodTo: dto.periodTo,
          currency: dto.currency,
          subtotalMinor: totals.subtotalMinor,
          vatRateBp: totals.vatRateBp,
          vatAmountMinor: totals.vatAmountMinor,
          stampDutyMinor: totals.stampDutyMinor,
          totalMinor: totals.totalMinor,
          createdByUserId: actorId,
          ...(dto.notes === undefined ? {} : { notes: dto.notes }),
        })
        .returning();

      const invoice = requireRow(inserted);
      await this.replaceLines(tx, tenantId, invoice.id, totals.lines);

      await this.audit.record(tx, {
        action: "invoice.drafted",
        resourceType: "invoice",
        resourceId: invoice.id,
        context: { merchantId: dto.merchantId, lineCount: totals.lines.length },
      });

      return this.load(tx, invoice.id);
    });
  }

  /** Replaces the lines of a DRAFT and recomputes every total. */
  async setLines(id: string, input: unknown): Promise<InvoiceView> {
    const dto = parseWithZod(addInvoiceLineSchema, input);

    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const current = await this.loadInvoice(tx, id);
      assertDraft(current);

      const totals = computeInvoiceTotals(dto.lines, current.vatRateBp, current.stampDutyMinor);
      await this.replaceLines(tx, tenantId, id, totals.lines);

      await tx
        .update(invoices)
        .set({
          subtotalMinor: totals.subtotalMinor,
          vatAmountMinor: totals.vatAmountMinor,
          totalMinor: totals.totalMinor,
          updatedAt: sql`now()`,
        })
        .where(eq(invoices.id, id));

      return this.load(tx, id);
    });
  }

  /**
   * Issues the document: assigns its number and freezes it.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * THE GAPLESS SEQUENCE
   *
   * `SELECT … FOR UPDATE` on the counter row, inside the same transaction as
   * the invoice update. Two concurrent issues for one tenant-year queue rather
   * than race, and a failure after taking the number rolls it back — which a
   * Postgres sequence would not do.
   *
   * The whole issuance is therefore single-file per tenant per year. That is
   * not a limitation to work around: invoices in a legal series MUST have a
   * defined order, and concurrency here would mean the order is whatever the
   * scheduler chose.
   * ─────────────────────────────────────────────────────────────────────────
   *
   * The seller and buyer identities are SNAPSHOT here, not joined at read time.
   * A document must still print correctly years later when the merchant has
   * moved and the courier has renamed itself.
   */
  async issue(id: string, actorId: string): Promise<InvoiceView> {
    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const invoice = await this.loadInvoice(tx, id);
      assertDraft(invoice);

      const lines = await this.linesOf(tx, id);
      if (lines.length === 0) {
        throw new BusinessRuleError(
          "INVOICE_EMPTY",
          "An invoice must have at least one line before it can be issued.",
        );
      }

      const settings = await this.settingsFor(tx);
      const issuedAt = new Date();
      const year = issuedAt.getUTCFullYear();
      const kind = invoice.kind === "CREDIT_NOTE" ? "CREDIT_NOTE" : "INVOICE";
      const sequence = await nextSequence(tx, tenantId, kind, year);

      const party = await partiesFor(tx, invoice.merchantId, settings);

      const updated = await tx
        .update(invoices)
        .set({
          status: "ISSUED",
          number: formatDocumentNumber(NUMBER_PREFIX[kind], year, sequence),
          numberYear: year,
          issuedAt,
          dueAt: addDays(issuedAt, settings.paymentTermsDays),
          issuedByUserId: actorId,
          ...party,
          updatedAt: sql`now()`,
        })
        .where(eq(invoices.id, id))
        .returning();

      const issued = requireRow(updated);

      // §10 makes this mandatory: issuing creates a legal obligation, and the
      // number it consumed can never be reused.
      await this.audit.record(tx, {
        action: "invoice.issued",
        resourceType: "invoice",
        resourceId: id,
        changes: {
          status: { from: "DRAFT", to: "ISSUED" },
          number: { from: null, to: issued.number },
        },
        context: { totalMinor: issued.totalMinor.toString(), currency: issued.currency },
      });

      await this.outbox.publish(tx, {
        eventType: kind === "CREDIT_NOTE" ? "credit_note.issued" : "invoice.issued",
        aggregateType: "invoice",
        aggregateId: id,
        payload: {
          merchantId: issued.merchantId,
          number: issued.number,
          totalMinor: issued.totalMinor.toString(),
          currency: issued.currency,
        },
      });

      return this.load(tx, id);
    });
  }

  /**
   * A credit note (avoir) correcting an issued invoice.
   *
   * The ONLY way to correct an issued document. It is created as its own draft
   * so the amounts can be checked before it too becomes a numbered legal
   * record — a full credit and a partial one are both ordinary here.
   */
  async createCreditNote(input: unknown, actorId: string): Promise<InvoiceView> {
    const dto = parseWithZod(createCreditNoteSchema, input);

    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const original = await this.loadInvoice(tx, dto.correctsInvoiceId);

      if (original.kind !== "INVOICE") {
        throw new BusinessRuleError(
          "INVOICE_NOT_CREDITABLE",
          "A credit note corrects an invoice, not another credit note.",
        );
      }
      if (original.status === "DRAFT" || original.status === "CANCELLED") {
        // A draft is edited and a cancelled draft never existed legally.
        // Crediting either would put a number against nothing.
        throw new BusinessRuleError(
          "INVOICE_NOT_ISSUED",
          "Only an issued invoice can be credited; edit or cancel a draft instead.",
        );
      }

      const lines = dto.lines ?? (await this.linesOf(tx, original.id)).map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
      }));

      // The ORIGINAL invoice's rate, not today's. A credit note reverses a
      // specific document and must reverse the tax that document charged.
      const totals = computeInvoiceTotals(lines, original.vatRateBp, original.stampDutyMinor);

      const inserted = await tx
        .insert(invoices)
        .values({
          tenantId,
          merchantId: original.merchantId,
          kind: "CREDIT_NOTE",
          status: "DRAFT",
          periodFrom: original.periodFrom,
          periodTo: original.periodTo,
          currency: original.currency,
          subtotalMinor: totals.subtotalMinor,
          vatRateBp: totals.vatRateBp,
          vatAmountMinor: totals.vatAmountMinor,
          stampDutyMinor: totals.stampDutyMinor,
          totalMinor: totals.totalMinor,
          correctsInvoiceId: original.id,
          createdByUserId: actorId,
          ...(dto.reason === undefined ? {} : { notes: dto.reason }),
        })
        .returning();

      const creditNote = requireRow(inserted);
      await this.replaceLines(tx, tenantId, creditNote.id, totals.lines);

      await this.audit.record(tx, {
        action: "credit_note.drafted",
        resourceType: "invoice",
        resourceId: creditNote.id,
        context: { correctsInvoiceId: original.id, correctsNumber: original.number },
      });

      return this.load(tx, creditNote.id);
    });
  }

  /** Records payment. ISSUED → PAID; the trigger refuses anything else. */
  async markPaid(id: string, actorId: string): Promise<InvoiceView> {
    return this.database.withTenant(async (tx) => {
      const invoice = await this.loadInvoice(tx, id);
      if (invoice.status !== "ISSUED") {
        throw new BusinessRuleError(
          "INVOICE_NOT_PAYABLE",
          `An invoice must be ISSUED to be marked paid — this one is ${invoice.status}.`,
        );
      }

      await tx
        .update(invoices)
        .set({ status: "PAID", updatedAt: sql`now()` })
        .where(eq(invoices.id, id));

      await this.audit.record(tx, {
        action: "invoice.paid",
        resourceType: "invoice",
        resourceId: id,
        changes: { status: { from: "ISSUED", to: "PAID" } },
        context: { markedBy: actorId, number: invoice.number },
      });

      return this.load(tx, id);
    });
  }

  /**
   * Cancels a DRAFT.
   *
   * Only a draft. An issued invoice has a number that has been reported, and
   * cancelling it would leave a hole in the series — that is what credit notes
   * are for.
   */
  async cancelDraft(id: string, reason: string): Promise<InvoiceView> {
    return this.database.withTenant(async (tx) => {
      const invoice = await this.loadInvoice(tx, id);
      if (invoice.status !== "DRAFT") {
        throw new BusinessRuleError(
          "INVOICE_ALREADY_ISSUED",
          "An issued invoice cannot be cancelled; issue a credit note instead.",
        );
      }

      await tx
        .update(invoices)
        .set({ status: "CANCELLED", notes: reason, updatedAt: sql`now()` })
        .where(eq(invoices.id, id));

      await this.audit.record(tx, {
        action: "invoice.cancelled",
        resourceType: "invoice",
        resourceId: id,
        changes: { status: { from: "DRAFT", to: "CANCELLED" } },
        context: { reason },
      });

      return this.load(tx, id);
    });
  }

  async getById(id: string): Promise<InvoiceView> {
    return this.database.withTenant((tx) => this.load(tx, id));
  }

  /**
   * The printable facture / avoir, as self-contained HTML.
   *
   * ⚠️ Every amount goes through {@link CurrencyService}, which reads the
   * exponent from the `currencies` table. **TND has three decimal places**, so a
   * hardcoded ×100 would print 12.50 on a document a customer pays against —
   * a tenfold error on the one number the whole document exists to state.
   *
   * The document is rendered from the SNAPSHOT columns (`seller_name`,
   * `buyer_name`, …), never from a live join, so reprinting an old invoice
   * reproduces it exactly. A draft has no snapshot yet, so it falls back to the
   * live parties — and prints a DRAFT watermark saying so.
   */
  async renderDocument(id: string, locale: string | undefined): Promise<string> {
    const [{ invoice, lines }, profile] = await Promise.all([
      this.getById(id),
      this.tenants.profile(),
    ]);

    const fallbackParties =
      invoice.sellerName === null || invoice.buyerName === null
        ? await this.database.withTenant((tx) =>
            partiesFor(tx, invoice.merchantId, {}),
          )
        : null;

    // One pass over the amounts rather than an await per line: `toDecimal`
    // resolves the exponent from a per-process cache, and an invoice with 200
    // lines would otherwise serialise 200 trivial async calls.
    const money = (amount: bigint): Promise<string> => this.currency.toDecimal(amount, invoice.currency);
    const [subtotal, vatAmount, stampDuty, total, ...lineAmounts] = await Promise.all([
      money(invoice.subtotalMinor),
      money(invoice.vatAmountMinor),
      money(invoice.stampDutyMinor),
      money(invoice.totalMinor),
      ...lines.flatMap((line) => [money(line.unitPriceMinor), money(line.lineTotalMinor)]),
    ]);

    const correctsNumber =
      invoice.correctsInvoiceId === null
        ? null
        : (await this.getById(invoice.correctsInvoiceId)).invoice.number;

    return renderInvoiceDocument({
      locale: toInvoiceLocale(locale ?? profile.defaultLocale),
      kind: invoice.kind === "CREDIT_NOTE" ? "CREDIT_NOTE" : "INVOICE",
      number: invoice.number,
      status: invoice.status,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      periodFrom: invoice.periodFrom,
      periodTo: invoice.periodTo,
      timezone: profile.timezone,
      sellerName: invoice.sellerName ?? fallbackParties?.sellerName ?? profile.name,
      sellerTaxId: invoice.sellerTaxId,
      sellerAddress: invoice.sellerAddress,
      buyerName: invoice.buyerName ?? fallbackParties?.buyerName ?? "—",
      buyerTaxId: invoice.buyerTaxId,
      buyerAddress: invoice.buyerAddress ?? fallbackParties?.buyerAddress ?? null,
      lines: lines.map((line, index) => ({
        position: line.position,
        description: line.description,
        quantity: line.quantity,
        unitPrice: lineAmounts[index * 2] ?? "0",
        lineTotal: lineAmounts[index * 2 + 1] ?? "0",
      })),
      currency: invoice.currency,
      subtotal: subtotal ?? "0",
      vatRate: (invoice.vatRateBp / 100).toFixed(2),
      vatAmount: vatAmount ?? "0",
      stampDuty: stampDuty ?? "0",
      total: total ?? "0",
      correctsNumber,
      notes: invoice.notes,
    });
  }

  async list(input: unknown): Promise<InvoicePage> {
    const params = parseWithZod(listInvoicesSchema, input);
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, params.limit ?? DEFAULT_PAGE_SIZE));

    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(params.status === undefined ? [] : [eq(invoices.status, params.status)]),
        ...(params.merchantId === undefined ? [] : [eq(invoices.merchantId, params.merchantId)]),
        ...(params.kind === undefined ? [] : [eq(invoices.kind, params.kind)]),
        ...(params.cursor === undefined ? [] : [lt(invoices.id, params.cursor)]),
      ];

      const rows = await tx
        .select()
        .from(invoices)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(invoices.id))
        .limit(limit + 1);

      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  /** The tenant's billing configuration, or the defaults if never set. */
  async settings(): Promise<BillingSettings | typeof FALLBACK_SETTINGS> {
    return this.database.withTenant((tx) => this.settingsFor(tx));
  }

  /**
   * Writes the tenant's billing configuration.
   *
   * Upsert, because the row is created lazily on first edit rather than at
   * provisioning: a tenant that never invoices should not carry a settings row
   * it never asked for, and the fallbacks make one unnecessary until then.
   *
   * ⚠️ Changing the rate NEVER touches an existing document. Every invoice
   * stores the rate it was drafted with, so a correction today cannot rewrite
   * what a customer was charged last quarter.
   */
  async updateSettings(input: unknown): Promise<BillingSettings> {
    const dto = parseWithZod(updateBillingSettingsSchema, input);

    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const before = await this.settingsFor(tx);

      const rows = await tx
        .insert(billingSettings)
        .values({ tenantId, ...dto })
        .onConflictDoUpdate({ target: billingSettings.tenantId, set: { ...dto, updatedAt: sql`now()` } })
        .returning();

      const settings = rows[0];
      if (settings === undefined) {
        throw new Error("Billing settings write returned no row");
      }

      // §10: the VAT rate and stamp duty decide what every future customer is
      // charged. A change to them is a configuration change worth a trail.
      await this.audit.record(tx, {
        action: "tenant.updated",
        resourceType: "billing_settings",
        resourceId: tenantId,
        changes: {
          vatRateBp: { from: before.vatRateBp, to: settings.vatRateBp },
          stampDutyMinor: {
            from: before.stampDutyMinor.toString(),
            to: settings.stampDutyMinor.toString(),
          },
        },
      });

      return settings;
    });
  }

  private async settingsFor(
    tx: TenantTransaction,
  ): Promise<BillingSettings | typeof FALLBACK_SETTINGS> {
    const rows = await tx.select().from(billingSettings).limit(1);
    return rows[0] ?? FALLBACK_SETTINGS;
  }

  /**
   * Rewrites a draft's lines wholesale.
   *
   * Delete-then-insert rather than a diff: positions are contiguous and
   * 1-based, so reordering or removing a middle line renumbers everything
   * after it. A diff would be more code for an identical result.
   */
  private async replaceLines(
    tx: TenantTransaction,
    tenantId: string,
    invoiceId: string,
    lines: readonly { position: number; description: string; quantity: number; unitPriceMinor: bigint; lineTotalMinor: bigint }[],
  ): Promise<void> {
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    if (lines.length === 0) {
      return;
    }
    await tx.insert(invoiceLines).values(
      lines.map((line) => ({
        tenantId,
        invoiceId,
        position: line.position,
        description: line.description,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        lineTotalMinor: line.lineTotalMinor,
      })),
    );
  }

  private async load(tx: TenantTransaction, id: string): Promise<InvoiceView> {
    return { invoice: await this.loadInvoice(tx, id), lines: await this.linesOf(tx, id) };
  }

  private async loadInvoice(tx: TenantTransaction, id: string): Promise<Invoice> {
    const rows = await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Invoice");
    }
    return row;
  }

  private async linesOf(tx: TenantTransaction, invoiceId: string): Promise<InvoiceLine[]> {
    return tx
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId))
      .orderBy(invoiceLines.position);
  }
}

/**
 * Takes the next number in a series, gaplessly.
 *
 * ⚠️ `FOR UPDATE` is load-bearing. Without it two concurrent issues read the
 * same `last_number` and both write the same next value — one insert fails on
 * the unique index and the number is lost, which is precisely the gap this
 * table exists to prevent.
 *
 * The upsert creates the counter on first use, so a new tenant or a new year
 * needs no provisioning step that someone could forget.
 */
async function nextSequence(
  tx: TenantTransaction,
  tenantId: string,
  kind: "INVOICE" | "CREDIT_NOTE",
  year: number,
): Promise<number> {
  await tx.execute(sql`
    insert into invoice_sequences (tenant_id, kind, year, last_number)
    values (${tenantId}, ${kind}, ${year}, 0)
    on conflict (tenant_id, kind, year) do nothing
  `);

  const locked = await tx.execute<{ last_number: number }>(sql`
    select last_number from invoice_sequences
     where tenant_id = ${tenantId} and kind = ${kind} and year = ${year}
       for update
  `);

  const current = Number(locked[0]?.last_number ?? 0);
  const next = current + 1;

  await tx.execute(sql`
    update invoice_sequences set last_number = ${next}
     where tenant_id = ${tenantId} and kind = ${kind} and year = ${year}
  `);

  return next;
}

/**
 * The issuer identity a document prints.
 *
 * Narrower than {@link BillingSettings} on purpose: rendering a draft has no
 * settings row to hand, and the renderer needs exactly these three fields.
 */
interface LegalIdentity {
  readonly legalName?: string | null;
  readonly taxIdentifier?: string | null;
  readonly legalAddress?: string | null;
}

/** The party identities frozen onto a document at issue time. */
interface PartySnapshot {
  readonly sellerName: string | null;
  readonly sellerTaxId: string | null;
  readonly sellerAddress: string | null;
  readonly buyerName: string | null;
  readonly buyerTaxId: string | null;
  readonly buyerAddress: string | null;
}

/**
 * The identities printed on the document.
 *
 * Read once and stored, never joined at render time — see {@link
 * InvoiceService.issue}. Both reads are RLS-filtered like any other, so a
 * merchant outside the caller's scope simply yields no row.
 */
async function partiesFor(
  tx: TenantTransaction,
  merchantId: string,
  identity: LegalIdentity,
): Promise<PartySnapshot> {
  // One query, not two: the buyer's postal address lives on `addresses` behind
  // the merchant's default pickup address, and a second round-trip for one
  // string on the slowest path in the module is not worth it.
  const rows = await tx.execute<{ name: string; address: string | null }>(sql`
    select m.name,
           coalesce(
             nullif(concat_ws(', ', a.normalised_line1, a.normalised_line2, a.city, a.postal_code), ''),
             a.raw_input
           ) as address
      from merchants m
      left join addresses a on a.id = m.default_pickup_address_id
     where m.id = ${merchantId}
  `);
  const merchant = rows[0];
  const tenantRows = await tx.execute<{ name: string }>(sql`
    select name from tenants where id = current_setting('app.current_tenant_id', true)::uuid
  `);

  return {
    // The configured legal name, else the tenant's own — a courier that has not
    // filled in its billing settings still gets a usable document.
    sellerName: identity.legalName ?? tenantRows[0]?.name ?? null,
    sellerTaxId: identity.taxIdentifier ?? null,
    sellerAddress: identity.legalAddress ?? null,
    buyerName: merchant?.name ?? null,
    // Merchants carry no tax identifier yet; printing nothing beats inventing
    // one — a wrong matricule fiscal on a tax document is worse than a blank.
    buyerTaxId: null,
    buyerAddress: merchant?.address ?? null,
  };
}

function assertDraft(invoice: Invoice): void {
  if (invoice.status !== "DRAFT") {
    throw new BusinessRuleError(
      "INVOICE_NOT_DRAFT",
      `This document is ${invoice.status} and is immutable; corrections are made with a credit note.`,
    );
  }
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

function requireRow(rows: Invoice[]): Invoice {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Invoice write returned no row");
  }
  return row;
}
