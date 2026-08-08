import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { MerchantService } from "../../directory/index.js";
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
    private readonly merchants: MerchantService,
    private readonly tenants: TenantService,
    private readonly currency: CurrencyService,
  ) {}

  async render(settlementId: string, locale?: string): Promise<RenderedPaymentNote> {
    const settlement = await this.database.withTenant(async (tx) => {
      const rows = await tx.select().from(settlements).where(eq(settlements.id, settlementId)).limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError("Settlement");
      }
      return row;
    });

    if (settlement.status === "DRAFT") {
      throw new NotFoundError("Settlement receipt");
    }

    const [profile, merchant, exponent] = await Promise.all([
      this.tenants.profile(),
      this.merchants.getById(settlement.merchantId),
      this.currency.exponentOf(settlement.currency),
    ]);

    const money = (amount: bigint): string => formatMinorUnits(amount, exponent);

    const html = renderPaymentNote({
      locale: toDocumentLocale(locale ?? profile.defaultLocale),
      courierName: profile.name,
      reference: settlement.code,
      merchantName: merchant.name,
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
