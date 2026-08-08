import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrencyService } from "../../../shared/money/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { InvoiceService } from "../application/invoice.service.js";
import type { InvoiceView } from "../application/invoice.service.js";
import {
  addInvoiceLineSchema,
  createCreditNoteSchema,
  createInvoiceSchema,
  updateBillingSettingsSchema,
} from "../domain/dtos.js";
import type { InvoiceLine } from "../domain/schema.js";

/**
 * Factures et avoirs (docs/01-mvp-scope.md §7).
 *
 * ⚠️ `invoice:draft` and `invoice:issue` are DIFFERENT permissions, and the
 * split is the point. Drafting produces a working document with no legal
 * weight; issuing consumes a number from a gapless series and freezes the
 * record forever. A courier that wants four-eyes on its billing grants the
 * first widely and the second narrowly.
 */

/** Only the language; the invoice id comes from the path. */
const documentQuerySchema = z.object({
  locale: z.enum(["ar", "fr", "en"]).optional(),
});

const cancelSchema = z.strictObject({
  reason: z.string().trim().min(1, "reason is required").max(500),
});

interface InvoiceLineResponse {
  readonly id: string;
  readonly position: number;
  readonly description: string;
  readonly quantity: number;
  /** Minor units as a decimal STRING — a bigint that would round as a number. */
  readonly unitPriceMinor: string;
  readonly lineTotalMinor: string;
}

interface InvoiceResponse {
  readonly id: string;
  readonly kind: string;
  /** NULL while a draft: an abandoned draft consumes no number. */
  readonly number: string | null;
  readonly status: string;
  readonly merchantId: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly issuedAt: string | null;
  readonly dueAt: string | null;
  readonly currency: string;
  /**
   * ISO 4217 minor-unit exponent for `currency`, from the `currencies` table.
   *
   * ⚠️ Sent with every response so no client ever hardcodes ÷100. **TND has
   * THREE decimals** — a UI that assumes two renders a 215.200 TND invoice as
   * 2152.00, and this is a document a merchant pays against.
   */
  readonly currencyExponent: number;
  readonly subtotalMinor: string;
  /** Basis points: 1900 = 19.00%. */
  readonly vatRateBp: number;
  readonly vatAmountMinor: string;
  readonly stampDutyMinor: string;
  readonly totalMinor: string;
  readonly sellerName: string | null;
  readonly sellerTaxId: string | null;
  readonly buyerName: string | null;
  readonly correctsInvoiceId: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly lines: readonly InvoiceLineResponse[];
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

interface BillingSettingsResponse {
  readonly vatRateBp: number;
  readonly stampDutyMinor: string;
  readonly paymentTermsDays: number;
  readonly legalName: string | null;
  readonly taxIdentifier: string | null;
  readonly legalAddress: string | null;
}

@Controller("v1/invoices")
export class InvoiceController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly currencies: CurrencyService,
  ) {}

  @Post()
  @RequirePermissions("invoice:draft")
  async createDraft(
    @Body(zodBody(createInvoiceSchema)) body: z.infer<typeof createInvoiceSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InvoiceResponse> {
    return this.render(await this.invoices.createDraft(body, principal.userId));
  }

  /**
   * The tenant's billing configuration.
   *
   * Declared BEFORE `:id`, or Nest matches "settings" as an invoice id and the
   * route 404s on a document that does not exist.
   */
  @Get("settings")
  @RequirePermissions("invoice:read")
  async getSettings(): Promise<BillingSettingsResponse> {
    return toSettingsResponse(await this.invoices.settings());
  }

  /** Changes the VAT rate, timbre fiscal, legal identity or payment terms. */
  @Put("settings")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("tenant:update")
  async updateSettings(
    @Body(zodBody(updateBillingSettingsSchema)) body: z.infer<typeof updateBillingSettingsSchema>,
  ): Promise<BillingSettingsResponse> {
    return toSettingsResponse(await this.invoices.updateSettings(body));
  }

  @Get()
  @RequirePermissions("invoice:read")
  async list(@Query() query: unknown): Promise<PageResponse<InvoiceResponse>> {
    const page = await this.invoices.list(query ?? {});

    // One lookup per DISTINCT currency, not per row. `exponentOf` is cached per
    // process, but a 200-row page would still resolve 200 awaits in sequence
    // for at most a handful of distinct answers.
    const exponents = new Map<string, number>();
    for (const currency of new Set(page.items.map((invoice) => invoice.currency))) {
      exponents.set(currency, await this.currencies.exponentOf(currency));
    }

    return {
      // The list carries no lines: a page of 50 invoices would mean 50 extra
      // queries for detail nobody reads in a table.
      data: page.items.map((invoice) =>
        toResponse({ invoice, lines: [] }, exponents.get(invoice.currency) ?? 0),
      ),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  @Get(":id")
  @RequirePermissions("invoice:read")
  async getById(@Param("id") id: string): Promise<InvoiceResponse> {
    return this.render(await this.invoices.getById(id));
  }

  /**
   * The printable facture / avoir.
   *
   * Returns HTML, not PDF bytes. Arabic needs bidirectional layout and
   * contextual glyph shaping; browsers do both natively and the Node PDF
   * libraries do neither, so a PDF built server-side renders Arabic as
   * disconnected letters in the wrong order. The browser's Print-to-PDF turns
   * this page into a correct PDF.
   *
   * `invoice:read`, the same authority as seeing the invoice at all: the
   * document contains nothing the JSON does not.
   */
  @Get(":id/document")
  @RequirePermissions("invoice:read")
  @Header("content-type", "text/html; charset=utf-8")
  // A draft changes as it is edited, and an issued one is immutable but may be
  // reprinted after a correction elsewhere. Neither benefits from a cache, and a
  // stale invoice in a customer's hands is a dispute.
  @Header("cache-control", "no-store")
  async document(@Param("id") id: string, @Query() query: unknown): Promise<string> {
    const { locale } = documentQuerySchema.parse(query);
    return this.invoices.renderDocument(id, locale);
  }

  /** Replaces every line on a DRAFT and recomputes the totals. */
  @Put(":id/lines")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("invoice:draft")
  async setLines(
    @Param("id") id: string,
    @Body(zodBody(addInvoiceLineSchema)) body: z.infer<typeof addInvoiceLineSchema>,
  ): Promise<InvoiceResponse> {
    return this.render(await this.invoices.setLines(id, body));
  }

  /**
   * Issues the document — irreversible.
   *
   * Takes the next number in the tenant's series and freezes the record. From
   * here the only corrections are a credit note or, if it is genuinely paid,
   * `POST :id/pay`.
   */
  @Post(":id/issue")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("invoice:issue")
  async issue(
    @Param("id") id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InvoiceResponse> {
    return this.render(await this.invoices.issue(id, principal.userId));
  }

  @Post(":id/pay")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("invoice:issue")
  async markPaid(
    @Param("id") id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InvoiceResponse> {
    return this.render(await this.invoices.markPaid(id, principal.userId));
  }

  /** Cancels a DRAFT. An issued invoice is credited, never cancelled. */
  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("invoice:draft")
  async cancel(
    @Param("id") id: string,
    @Body(zodBody(cancelSchema)) body: z.infer<typeof cancelSchema>,
  ): Promise<InvoiceResponse> {
    return this.render(await this.invoices.cancelDraft(id, body.reason));
  }

  /**
   * Drafts a credit note against an issued invoice.
   *
   * `invoice:issue`, not `invoice:draft`: a credit note reverses money that has
   * already been billed, so the authority to start one belongs with the
   * authority to commit one.
   */
  @Post("credit-notes")
  @RequirePermissions("invoice:issue")
  async createCreditNote(
    @Body(zodBody(createCreditNoteSchema)) body: z.infer<typeof createCreditNoteSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InvoiceResponse> {
    return this.render(await this.invoices.createCreditNote(body, principal.userId));
  }

  /**
   * Shapes one invoice, resolving its currency's exponent.
   *
   * Every single-document handler goes through here so none of them can forget
   * `currencyExponent` — a response missing it makes the client fall back to a
   * guess, and the guess is always 2.
   */
  private async render(view: InvoiceView): Promise<InvoiceResponse> {
    return toResponse(view, await this.currencies.exponentOf(view.invoice.currency));
  }
}

function toResponse(view: InvoiceView, currencyExponent: number): InvoiceResponse {
  const { invoice, lines } = view;
  return {
    id: invoice.id,
    kind: invoice.kind,
    number: invoice.number,
    status: invoice.status,
    merchantId: invoice.merchantId,
    periodFrom: invoice.periodFrom,
    periodTo: invoice.periodTo,
    issuedAt: invoice.issuedAt?.toISOString() ?? null,
    dueAt: invoice.dueAt?.toISOString() ?? null,
    currency: invoice.currency,
    currencyExponent,
    // Every amount as a string. JSON has no bigint, and a number would round
    // silently on a large total.
    subtotalMinor: invoice.subtotalMinor.toString(),
    vatRateBp: invoice.vatRateBp,
    vatAmountMinor: invoice.vatAmountMinor.toString(),
    stampDutyMinor: invoice.stampDutyMinor.toString(),
    totalMinor: invoice.totalMinor.toString(),
    sellerName: invoice.sellerName,
    sellerTaxId: invoice.sellerTaxId,
    buyerName: invoice.buyerName,
    correctsInvoiceId: invoice.correctsInvoiceId,
    notes: invoice.notes,
    createdAt: invoice.createdAt.toISOString(),
    lines: lines.map(toLineResponse),
  };
}

function toLineResponse(line: InvoiceLine): InvoiceLineResponse {
  return {
    id: line.id,
    position: line.position,
    description: line.description,
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor.toString(),
    lineTotalMinor: line.lineTotalMinor.toString(),
  };
}

/**
 * Shapes both the stored row and the fallback defaults.
 *
 * A tenant that has never opened the settings gets the same JSON as one that
 * has, so the client needs no "unconfigured" branch.
 */
function toSettingsResponse(settings: BillingSettingsSource): BillingSettingsResponse {
  return {
    vatRateBp: settings.vatRateBp,
    stampDutyMinor: settings.stampDutyMinor.toString(),
    paymentTermsDays: settings.paymentTermsDays,
    legalName: settings.legalName,
    taxIdentifier: settings.taxIdentifier,
    legalAddress: settings.legalAddress,
  };
}

type BillingSettingsSource = Awaited<ReturnType<InvoiceService["settings"]>>;
