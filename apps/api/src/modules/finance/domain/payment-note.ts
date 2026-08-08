/**
 * Bon de payment — the receipt a merchant signs when they are paid.
 *
 * In a COD market the courier collects the customer's cash and later hands the
 * merchant their share. This is the paper that proves the handover happened: the
 * period, the parcels, what was collected, what the courier kept, what was
 * actually paid, and the merchant's signature.
 *
 * ⚠️ THIS IS NOT AN INVOICE. An invoice is a TAX DOCUMENT the courier issues for
 * its own services, with a gapless legal number and TVA. This is a payment
 * RECEIPT for money flowing the other way, and it carries no fiscal series —
 * conflating them would put a settlement into the tax numbering sequence, where a
 * gap reads to an auditor as a destroyed invoice.
 *
 * ⚠️ THE ARITHMETIC IS SHOWN, NOT ASSERTED. Gross − fees ± adjustments = net,
 * printed line by line, because the single question a merchant asks about this
 * document is "why is it less than I expected?" and a bare total cannot answer.
 *
 * Pure — no I/O, no framework.
 */

import { escapeHtml } from "../../../shared/http/index.js";
import {
  BASE_PRINT_CSS,
  directionOf,
  formatDocumentDate,
} from "../../../shared/documents/index.js";
import type { DocumentLocale } from "../../../shared/documents/index.js";

export interface PaymentNoteData {
  readonly locale: DocumentLocale;
  readonly courierName: string;
  readonly reference: string;
  readonly merchantName: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly shipmentCount: number;
  /** Every amount already formatted through the currency's real exponent. */
  readonly grossCod: string;
  readonly deliveryFees: string;
  readonly adjustments: string;
  readonly netPayable: string;
  readonly currency: string;
  readonly paymentMethod: string | null;
  readonly paymentReference: string | null;
  readonly paidAt: Date | null;
  readonly issuedAt: Date;
  readonly timezone: string;
}

interface Labels {
  readonly title: string;
  readonly reference: string;
  readonly merchant: string;
  readonly period: string;
  readonly parcels: string;
  readonly grossCod: string;
  readonly deliveryFees: string;
  readonly adjustments: string;
  readonly netPayable: string;
  readonly paymentMethod: string;
  readonly paymentReference: string;
  readonly paidAt: string;
  readonly issuedAt: string;
  readonly notPaidYet: string;
  readonly signatureCourier: string;
  readonly signatureMerchant: string;
  readonly nameAndDate: string;
  readonly receiptNotice: string;
  readonly printHint: string;
}

const LABELS: Readonly<Record<DocumentLocale, Labels>> = {
  fr: {
    title: "Bon de paiement",
    reference: "Référence",
    merchant: "Expéditeur",
    period: "Période",
    parcels: "Colis livrés",
    grossCod: "Encaissements bruts",
    deliveryFees: "Frais de livraison",
    adjustments: "Ajustements",
    netPayable: "Net versé",
    paymentMethod: "Mode de paiement",
    paymentReference: "Référence du virement",
    paidAt: "Payé le",
    issuedAt: "Édité le",
    notPaidYet: "En attente de paiement",
    signatureCourier: "Pour le transporteur",
    signatureMerchant: "Pour l’expéditeur",
    nameAndDate: "Nom, date et signature",
    receiptNotice: "L’expéditeur reconnaît avoir reçu le montant net indiqué ci-dessus.",
    printHint: "Imprimez ce document et faites-le signer à la remise des fonds.",
  },
  ar: {
    title: "وصل الدفع",
    reference: "المرجع",
    merchant: "المرسل",
    period: "الفترة",
    parcels: "الطرود المسلّمة",
    grossCod: "المبالغ المحصّلة",
    deliveryFees: "معاليم التوصيل",
    adjustments: "تعديلات",
    netPayable: "الصافي المدفوع",
    paymentMethod: "طريقة الدفع",
    paymentReference: "مرجع التحويل",
    paidAt: "دُفع في",
    issuedAt: "حُرّر في",
    notPaidYet: "في انتظار الدفع",
    signatureCourier: "عن الناقل",
    signatureMerchant: "عن المرسل",
    nameAndDate: "الاسم والتاريخ والإمضاء",
    receiptNotice: "يقر المرسل باستلام المبلغ الصافي المذكور أعلاه.",
    printHint: "اطبع هذه الوثيقة ووقّعها عند تسليم المبلغ.",
  },
  en: {
    title: "Payment note",
    reference: "Reference",
    merchant: "Merchant",
    period: "Period",
    parcels: "Parcels delivered",
    grossCod: "Gross collections",
    deliveryFees: "Delivery fees",
    adjustments: "Adjustments",
    netPayable: "Net paid",
    paymentMethod: "Payment method",
    paymentReference: "Transfer reference",
    paidAt: "Paid on",
    issuedAt: "Issued",
    notPaidYet: "Awaiting payment",
    signatureCourier: "For the courier",
    signatureMerchant: "For the merchant",
    nameAndDate: "Name, date and signature",
    receiptNotice: "The merchant confirms receipt of the net amount shown above.",
    printHint: "Print this and have it signed when the money changes hands.",
  },
};

export function renderPaymentNote(data: PaymentNoteData): string {
  const labels = LABELS[data.locale];
  const dir = directionOf(data.locale);
  const e = escapeHtml;

  const money = (amount: string): string =>
    `<span class="ltr">${e(amount)} ${e(data.currency)}</span>`;

  return `<!doctype html>
<html lang="${data.locale}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(labels.title)} — ${e(data.reference)}</title>
<style>
  /* A5: a receipt handed across a counter, like the other dockets. */
  @page { size: A5; margin: 10mm; }
  ${BASE_PRINT_CSS}
  body { font-size: 11pt; line-height: 1.45; }
  .meta { margin-block-start: 3mm; font-size: 9.5pt; color: #555; }
  .party { margin-block-start: 4mm; }
  .party h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.4pt;
              margin: 0 0 1mm; color: #555; }
  .party .name { font-size: 12pt; font-weight: 700; }
  table.amounts { width: 100%; border-collapse: collapse; margin-block-start: 5mm; }
  table.amounts th, table.amounts td {
    text-align: start; padding: 1.8mm 0; border-block-end: 0.4pt solid #ddd;
  }
  table.amounts th { font-weight: 400; color: #555; }
  table.amounts td { text-align: end; white-space: nowrap; }
  /* The line the merchant actually reads. */
  tr.net th, tr.net td { border-block-end: none; border-block-start: 1pt solid #111;
                         font-size: 13pt; font-weight: 700; padding-block-start: 2.5mm; }
  .receipt-notice { margin-block-start: 4mm; padding: 2mm 3mm; border: 1pt solid #111;
                    font-weight: 600; font-size: 9.5pt; }
  .pending { display: inline-block; margin-block-start: 2mm; padding: 1mm 2.5mm;
             border: 0.8pt dashed #b45309; color: #b45309; font-size: 9pt;
             font-weight: 700; }
</style>
</head>
<body>
<article>
  <header>
    <div>
      <div class="courier">${e(data.courierName)}</div>
      <div class="doctype">${e(labels.title)}</div>
      <div class="ltr mono">${e(data.reference)}</div>
    </div>
    <div class="meta">
      <div>${e(labels.issuedAt)}: ${e(
        formatDocumentDate(data.issuedAt, data.timezone, data.locale),
      )}</div>
      ${
        data.paidAt === null
          ? `<div class="pending">${e(labels.notPaidYet)}</div>`
          : `<div>${e(labels.paidAt)}: ${e(
              formatDocumentDate(data.paidAt, data.timezone, data.locale),
            )}</div>`
      }
    </div>
  </header>

  <section class="party">
    <h2>${e(labels.merchant)}</h2>
    <div class="name">${e(data.merchantName)}</div>
    <div class="meta">
      ${e(labels.period)}: ${e(data.periodFrom)} → ${e(data.periodTo)} ·
      ${e(labels.parcels)}: ${String(data.shipmentCount)}
    </div>
  </section>

  <table class="amounts">
    <tbody>
      <tr><th>${e(labels.grossCod)}</th><td>${money(data.grossCod)}</td></tr>
      <tr><th>${e(labels.deliveryFees)}</th><td>− ${money(data.deliveryFees)}</td></tr>
      <tr><th>${e(labels.adjustments)}</th><td>${money(data.adjustments)}</td></tr>
      <tr class="net"><th>${e(labels.netPayable)}</th><td>${money(data.netPayable)}</td></tr>
    </tbody>
  </table>

  ${
    data.paymentMethod === null && data.paymentReference === null
      ? ""
      : `<div class="meta">
    ${
      data.paymentMethod === null
        ? ""
        : `<div>${e(labels.paymentMethod)}: ${e(data.paymentMethod)}</div>`
    }
    ${
      data.paymentReference === null
        ? ""
        : `<div>${e(labels.paymentReference)}: <span class="ltr mono">${e(
            data.paymentReference,
          )}</span></div>`
    }
  </div>`
  }

  <p class="receipt-notice">${e(labels.receiptNotice)}</p>

  <div class="signatures">
    <div class="sig">
      <div class="line"></div>
      <div class="caption">${e(labels.signatureCourier)} — ${e(labels.nameAndDate)}</div>
    </div>
    <div class="sig">
      <div class="line"></div>
      <div class="caption">${e(labels.signatureMerchant)} — ${e(labels.nameAndDate)}</div>
    </div>
  </div>

  <p class="print-hint no-print">${e(labels.printHint)}</p>
</article>
</body>
</html>`;
}
