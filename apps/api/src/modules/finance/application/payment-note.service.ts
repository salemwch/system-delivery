import { Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";

import { TenantService } from "../../platform/index.js";
import { DatabaseService } from "../../../shared/database/index.js";
import { toDocumentLocale } from "../../../shared/documents/index.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import { CurrencyService, formatMinorUnits } from "../../../shared/money/index.js";
import { renderPaymentNote } from "../domain/payment-note.js";
import { settlements } from "../domain/schema.js";

export interface RenderedPaymentNote {
  readonly html: string;
  readonly filename: string;
}

/**
 * Bon de payment — the receipt a merchant signs when they are paid.
 *
 * ⚠️ PRINTABLE BEFORE PAYMENT, deliberately. The courier prints it, takes it to
 * the merchant with the cash, and both sign at the handover — so an unpaid
 * settlement must still render. It carries a visible "awaiting payment" mark
 * instead, which is what stops an unpaid receipt being filed as a paid one.
 *
 * ⚠️ A DRAFT settlement is refused. Its figures are still being assembled, and a
 * signed receipt for a number that later changes is worse than no receipt.
 */
@Injectable()
export class PaymentNoteService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tenants: TenantService,
    private readonly currency: CurrencyService,
  ) {}

  async render(settlementId: string, locale?: string): Promise<RenderedPaymentNote> {
    // ⚠️ The merchant's NAME is read here, not through MerchantService. Injecting
    // it would make finance depend on the whole directory module — and its own
    // dependency graph — for one string, and would cost a second transaction on
    // the slowest path in the module. `InvoiceService.partiesFor` reads the same
    // name the same way; this is that pattern, not an exception to it.
    //
    // The read is RLS-filtered like any other, so a settlement whose merchant is
    // outside the caller's scope simply yields no name — never another tenant's.
    const { settlement, merchantName } = await this.database.withTenant(async (tx) => {
      const rows = await tx.select().from(settlements).where(eq(settlements.id, settlementId)).limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError("Settlement");
      }
      const merchants = await tx.execute<{ name: string }>(sql`
        select name from merchants where id = ${row.merchantId}
      `);
      const name = merchants[0]?.name;
      if (name === undefined) {
        throw new NotFoundError("Merchant");
      }
      return { settlement: row, merchantName: name };
    });

    if (settlement.status === "DRAFT") {
      throw new NotFoundError("Settlement receipt");
    }

    const [profile, exponent] = await Promise.all([
      this.tenants.profile(),
      this.currency.exponentOf(settlement.currency),
    ]);

    const money = (amount: bigint): string => formatMinorUnits(amount, exponent);

    const html = renderPaymentNote({
      locale: toDocumentLocale(locale ?? profile.defaultLocale),
      courierName: profile.name,
      reference: settlement.code,
      merchantName,
      periodFrom: settlement.periodFrom,
      periodTo: settlement.periodTo,
      shipmentCount: settlement.shipmentCount,
      grossCod: money(settlement.grossCodAmountMinor),
      deliveryFees: money(settlement.deliveryFeesMinor),
      adjustments: money(settlement.adjustmentsMinor),
      netPayable: money(settlement.netPayableMinor),
      currency: settlement.currency,
      paymentMethod: settlement.paymentMethod,
      paymentReference: settlement.paymentReference,
      paidAt: settlement.paidAt,
      issuedAt: new Date(),
      timezone: profile.timezone,
    });

    return { html, filename: `bon-de-paiement-${settlement.code}.html` };
  }
}
