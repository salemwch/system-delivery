/**
 * The printable facture / avoir.
 *
 * A Tunisian invoice is a fiscal document with a legally expected shape: the
 * issuer's *matricule fiscal*, a number from an unbroken series, the taxable
 * base, the TVA shown separately at its rate, the *timbre fiscal* as its own
 * line, and a total. An operator prints it, stamps it, and files it — so what is
 * rendered here is the artefact itself, not a screen that summarises one.
 *
 * ⚠️ PRINT-READY HTML, NOT PDF BYTES — the same decision as the delivery
 * documents, for the same reason. Arabic needs bidirectional layout and
 * contextual glyph shaping; browsers do both natively, `pdfkit` and `pdf-lib` do
 * neither and render Arabic as disconnected letters in the wrong order. The
 * browser's Print-to-PDF turns this into a correct PDF.
 *
 * A4, not A5: an invoice is filed flat in an accounting binder, and a line table
 * of any length needs the width.
 *
 * Pure — no I/O, no framework, no database. Everything arrives in
 * {@link InvoiceDocumentData}, already formatted through the currency's real
 * exponent by the caller.
 */

import { escapeHtml } from "../../../shared/http/index.js";
import { BASE_PRINT_CSS, directionOf, toDocumentLocale } from "../../../shared/documents/index.js";
import type { DocumentLocale } from "../../../shared/documents/index.js";

/**
 * An invoice's locale is a document locale — the same three, defaulting to
 * French for the same reason. Aliased rather than redefined so the definition
 * lives in one place now that four modules render printed pages.
 *
 * Not exported: callers that need the type import `DocumentLocale` from
 * `shared/documents`, which is where it belongs. The alias exists so this
 * file's own signatures still read in invoice terms.
 */
type InvoiceLocale = DocumentLocale;

/** French by default: the language a Tunisian accountant expects. */
export const toInvoiceLocale = toDocumentLocale;

/** One printed line. Reachable through {@link InvoiceDocumentData}. */
interface InvoiceDocumentLine {
  readonly position: number;
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly lineTotal: string;
}

/** Everything the document prints. */
export interface InvoiceDocumentData {
  readonly locale: InvoiceLocale;
  readonly kind: "INVOICE" | "CREDIT_NOTE";
  /** NULL on a draft — the document then prints a DRAFT watermark instead. */
  readonly number: string | null;
  readonly status: string;
  readonly issuedAt: Date | null;
  readonly dueAt: Date | null;
  readonly periodFrom: string;
  readonly periodTo: string;
  /** IANA zone, so a printed date is the local one. */
  readonly timezone: string;

  readonly sellerName: string;
  readonly sellerTaxId: string | null;
  readonly sellerAddress: string | null;
  readonly buyerName: string;
  readonly buyerTaxId: string | null;
  readonly buyerAddress: string | null;

  readonly lines: readonly InvoiceDocumentLine[];
  readonly currency: string;
  readonly subtotal: string;
  /** Rendered percentage, e.g. "19.00". */
  readonly vatRate: string;
  readonly vatAmount: string;
  readonly stampDuty: string;
  readonly total: string;
  /** The invoice a credit note corrects, printed as a legal reference. */
  readonly correctsNumber: string | null;
  readonly notes: string | null;
}

interface Labels {
  readonly title: Readonly<Record<"INVOICE" | "CREDIT_NOTE", string>>;
  readonly number: string;
  readonly issuedAt: string;
  readonly dueAt: string;
  readonly period: string;
  readonly seller: string;
  readonly buyer: string;
  readonly taxId: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly lineTotal: string;
  readonly subtotal: string;
  readonly vat: string;
  readonly stampDuty: string;
  readonly total: string;
  readonly notes: string;
  readonly corrects: string;
  readonly draftWatermark: string;
  readonly cancelledWatermark: string;
  readonly paid: string;
  readonly creditNotice: string;
}

/**
 * Per-locale strings.
 *
 * Separate from the delivery-document labels: a facture and a bon de livraison
 * share no vocabulary and have no reason to change together. Deliberately NOT
 * loaded from `templates.ts` either — those are SMS bodies costed in segments.
 */
const LABELS: Readonly<Record<InvoiceLocale, Labels>> = {
  fr: {
    title: { INVOICE: "Facture", CREDIT_NOTE: "Avoir" },
    number: "N°",
    issuedAt: "Date d'émission",
    dueAt: "Échéance",
    period: "Période",
    seller: "Émetteur",
    buyer: "Client",
    taxId: "Matricule fiscal",
    description: "Désignation",
    quantity: "Qté",
    unitPrice: "P.U. HT",
    lineTotal: "Montant HT",
    subtotal: "Total HT",
    vat: "TVA",
    stampDuty: "Timbre fiscal",
    total: "Total TTC",
    notes: "Observations",
    corrects: "Annule et remplace la facture",
    draftWatermark: "BROUILLON",
    cancelledWatermark: "ANNULÉE",
    paid: "PAYÉE",
    creditNotice: "Le présent avoir vient en déduction de la facture référencée.",
  },
  ar: {
    title: { INVOICE: "فاتورة", CREDIT_NOTE: "إشعار دائن" },
    number: "رقم",
    issuedAt: "تاريخ الإصدار",
    dueAt: "تاريخ الاستحقاق",
    period: "الفترة",
    seller: "المُصدِر",
    buyer: "الحريف",
    taxId: "المعرف الجبائي",
    description: "البيان",
    quantity: "الكمية",
    unitPrice: "سعر الوحدة دون أداء",
    lineTotal: "المبلغ دون أداء",
    subtotal: "المجموع دون أداء",
    vat: "الأداء على القيمة المضافة",
    stampDuty: "الطابع الجبائي",
    total: "المجموع بالأداء",
    notes: "ملاحظات",
    corrects: "يلغي ويعوض الفاتورة",
    draftWatermark: "مسودة",
    cancelledWatermark: "ملغاة",
    paid: "خالصة",
    creditNotice: "يُخصم هذا الإشعار من الفاتورة المشار إليها.",
  },
  en: {
    title: { INVOICE: "Invoice", CREDIT_NOTE: "Credit note" },
    number: "No.",
    issuedAt: "Issue date",
    dueAt: "Due date",
    period: "Period",
    seller: "Issuer",
    buyer: "Customer",
    taxId: "Tax ID",
    description: "Description",
    quantity: "Qty",
    unitPrice: "Unit price",
    lineTotal: "Amount",
    subtotal: "Subtotal",
    vat: "VAT",
    stampDuty: "Stamp duty",
    total: "Total",
    notes: "Notes",
    corrects: "Cancels and replaces invoice",
    draftWatermark: "DRAFT",
    cancelledWatermark: "CANCELLED",
    paid: "PAID",
    creditNotice: "This credit note is deducted from the invoice referenced above.",
  },
};

/** Arabic is the only RTL locale here. */
/**
 * A date in the tenant's zone.
 *
 * Latin digits even in Arabic: an invoice number and a date are read back to an
 * accountant and typed into a ledger, and Eastern-Arabic numerals there are a
 * transcription error waiting to happen.
 */
function formatDate(at: Date, timezone: string, locale: InvoiceLocale): string {
  const tag = locale === "ar" ? "ar-TN-u-nu-latn" : locale === "fr" ? "fr-TN" : "en-GB";
  return new Intl.DateTimeFormat(tag, {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * The status stamp printed across the page.
 *
 * ⚠️ A DRAFT MUST BE VISIBLY A DRAFT. Without this, a draft printed for internal
 * review is indistinguishable from a real invoice except for a missing number,
 * and it will end up in a customer's hands. The watermark is `position: fixed`
 * so it prints on every page, not only the first.
 */
function watermarkFor(status: string, labels: Labels): string | null {
  switch (status) {
    case "DRAFT":
      return labels.draftWatermark;
    case "CANCELLED":
      return labels.cancelledWatermark;
    case "PAID":
      return labels.paid;
    default:
      return null;
  }
}

/**
 * Renders one invoice as a self-contained print-ready HTML page.
 *
 * Self-contained is a hard requirement: inline CSS, no external font, image or
 * script. An accounting PC on a bad connection must print the same document as a
 * developer's laptop.
 *
 * CSS uses LOGICAL properties (`margin-inline`, `text-align: start`) per
 * CLAUDE.md, so one stylesheet mirrors correctly for Arabic rather than needing
 * an RTL variant.
 */
export function renderInvoiceDocument(data: InvoiceDocumentData): string {
  const labels = LABELS[data.locale];
  const dir = directionOf(data.locale);
  const e = escapeHtml;
  const title = labels.title[data.kind];
  const watermark = watermarkFor(data.status, labels);

  const heading = data.number === null ? title : `${title} ${data.number}`;

  const party = (
    label: string,
    name: string,
    taxId: string | null,
    address: string | null,
  ): string => `
      <section class="party">
        <h2>${e(label)}</h2>
        <div class="party-name">${e(name)}</div>
        ${address === null ? "" : `<div>${e(address)}</div>`}
        ${taxId === null ? "" : `<div class="tax-id">${e(labels.taxId)}: ${e(taxId)}</div>`}
      </section>`;

  const lineRows = data.lines
    .map(
      (line) => `
        <tr>
          <td class="num">${String(line.position)}</td>
          <td>${e(line.description)}</td>
          <td class="num">${String(line.quantity)}</td>
          <td class="num">${e(line.unitPrice)}</td>
          <td class="num">${e(line.lineTotal)}</td>
        </tr>`,
    )
    .join("");

  const totalRow = (label: string, amount: string, cls = ""): string => `
        <tr${cls === "" ? "" : ` class="${cls}"`}>
          <th>${e(label)}</th>
          <td class="num">${e(amount)} ${e(data.currency)}</td>
        </tr>`;

  const meta = (label: string, value: string): string =>
    `<tr><th>${e(label)}</th><td>${e(value)}</td></tr>`;

  return `<!doctype html>
<html lang="${data.locale}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(heading)}</title>
<style>
  /* A4: an invoice is filed flat, and the line table needs the width. */
  @page { size: A4; margin: 15mm; }
  @media print {
    /* Totals split across a page break stop being totals. */
    .totals, .parties, .stamp-box { break-inside: avoid; }
    .no-print { display: none; }
    thead { display: table-header-group; }
  }
${BASE_PRINT_CSS}
  body { font-size: 11pt; line-height: 1.45; padding: 8mm; }
  h1 { font-size: 18pt; margin: 0 0 2mm; }
  h2 {
    font-size: 9pt;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #555;
    margin: 0 0 1.5mm;
    font-weight: 600;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    gap: 6mm;
    justify-content: space-between;
    align-items: flex-start;
    border-block-end: 2px solid #111;
    padding-block-end: 4mm;
    margin-block-end: 5mm;
  }
  .meta td, .meta th {
    text-align: start;
    padding: 0.5mm 0;
    font-size: 10pt;
  }
  .meta th { font-weight: 600; color: #555; padding-inline-end: 4mm; white-space: nowrap; }
  .parties {
    display: flex;
    flex-wrap: wrap;
    gap: 8mm;
    margin-block-end: 6mm;
  }
  .party { flex: 1 1 60mm; }
  .party-name { font-weight: 600; font-size: 12pt; }
  .tax-id { font-variant-numeric: tabular-nums; }
  table.lines {
    inline-size: 100%;
    border-collapse: collapse;
    margin-block-end: 5mm;
  }
  table.lines th {
    text-align: start;
    font-size: 9pt;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-block-end: 1px solid #111;
    padding: 2mm 2mm;
    color: #333;
  }
  table.lines td {
    padding: 2mm;
    border-block-end: 1px solid #ddd;
    vertical-align: top;
  }
  /* Tabular numerals: columns of money must align on the decimal. */
  .num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table.lines th.num { text-align: end; }
  .totals-wrap { display: flex; justify-content: flex-end; }
  table.totals { border-collapse: collapse; min-inline-size: 70mm; }
  table.totals th {
    text-align: start;
    font-weight: 400;
    color: #444;
    padding: 1.5mm 4mm 1.5mm 0;
  }
  table.totals td { padding: 1.5mm 0; }
  table.totals tr.grand th, table.totals tr.grand td {
    border-block-start: 2px solid #111;
    font-weight: 700;
    font-size: 13pt;
    padding-block-start: 2.5mm;
  }
  .notes { margin-block-start: 6mm; font-size: 10pt; }
  .notes h2 { margin-block-end: 1mm; }
  .legal {
    margin-block-start: 8mm;
    padding-block-start: 3mm;
    border-block-start: 1px solid #ddd;
    font-size: 9pt;
    color: #555;
  }
  .stamp-box {
    margin-block-start: 10mm;
    inline-size: 55mm;
    block-size: 28mm;
    border: 1px dashed #999;
    margin-inline-start: auto;
  }
  /* Fixed, not absolute: it must appear on every printed page, not page one. */
  .watermark {
    position: fixed;
    inset-block-start: 40%;
    inset-inline-start: 0;
    inline-size: 100%;
    text-align: center;
    font-size: 60pt;
    font-weight: 800;
    color: rgba(17, 17, 17, 0.08);
    letter-spacing: 0.15em;
    transform: rotate(-24deg);
    pointer-events: none;
    z-index: 0;
  }
  main { position: relative; z-index: 1; }
</style>
</head>
<body>
${watermark === null ? "" : `<div class="watermark">${e(watermark)}</div>`}
<main>
  <header>
    <div>
      <h1>${e(heading)}</h1>
      ${
        data.correctsNumber === null
          ? ""
          : `<div>${e(labels.corrects)} <strong>${e(data.correctsNumber)}</strong></div>`
      }
    </div>
    <table class="meta">
      ${
        data.issuedAt === null
          ? ""
          : meta(labels.issuedAt, formatDate(data.issuedAt, data.timezone, data.locale))
      }
      ${
        data.dueAt === null
          ? ""
          : meta(labels.dueAt, formatDate(data.dueAt, data.timezone, data.locale))
      }
      ${meta(labels.period, `${data.periodFrom} → ${data.periodTo}`)}
    </table>
  </header>

  <div class="parties">
    ${party(labels.seller, data.sellerName, data.sellerTaxId, data.sellerAddress)}
    ${party(labels.buyer, data.buyerName, data.buyerTaxId, data.buyerAddress)}
  </div>

  <table class="lines">
    <thead>
      <tr>
        <th class="num">#</th>
        <th>${e(labels.description)}</th>
        <th class="num">${e(labels.quantity)}</th>
        <th class="num">${e(labels.unitPrice)}</th>
        <th class="num">${e(labels.lineTotal)}</th>
      </tr>
    </thead>
    <tbody>${lineRows}</tbody>
  </table>

  <div class="totals-wrap">
    <table class="totals">
      ${totalRow(labels.subtotal, data.subtotal)}
      ${totalRow(`${labels.vat} ${data.vatRate}%`, data.vatAmount)}
      ${totalRow(labels.stampDuty, data.stampDuty)}
      ${totalRow(labels.total, data.total, "grand")}
    </table>
  </div>

  ${
    data.notes === null
      ? ""
      : `<div class="notes"><h2>${e(labels.notes)}</h2><div>${e(data.notes)}</div></div>`
  }

  ${data.kind === "CREDIT_NOTE" ? `<div class="legal">${e(labels.creditNotice)}</div>` : ""}

  <div class="stamp-box"></div>
</main>
</body>
</html>`;
}
