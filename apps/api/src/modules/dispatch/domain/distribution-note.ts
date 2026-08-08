/**
 * Bon de distribution — the manifest a driver signs for at the start of a run.
 *
 * The physical handover document: every parcel loaded into the van, the cash
 * expected against each, and two signatures — the dispatcher who handed them
 * over and the driver who took them. When a parcel is missing at the end of the
 * day, this is the paper that says it was ever in the van.
 *
 * ⚠️ A5 IS WRONG FOR THIS ONE. The other dockets are single-parcel cards that
 * fold into a pocket; this is a table of thirty stops that has to stay legible
 * on a clipboard. A4, and the header repeats on every printed page — a second
 * sheet with no column headings is a sheet nobody can read.
 *
 * Renders print-ready HTML, not PDF bytes, for the same reason as every other
 * document here: Arabic needs bidirectional layout and contextual glyph shaping,
 * which browsers do natively and `pdfkit`/`pdf-lib` do not.
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

/** One line of the manifest: a parcel the driver is taking. */
export interface DistributionStop {
  readonly sequence: number;
  readonly trackingNumber: string;
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly addressLine: string;
  /** Already formatted through the currency's real exponent. Null when no COD. */
  readonly codAmount: string | null;
}

export interface DistributionNoteData {
  readonly locale: DocumentLocale;
  readonly courierName: string;
  readonly routeCode: string;
  readonly plannedDate: string;
  readonly driverName: string;
  readonly vehiclePlate: string | null;
  readonly issuedAt: Date;
  /** IANA zone, so a printed time is the local one. */
  readonly timezone: string;
  readonly stops: readonly DistributionStop[];
  /** Sum of the COD column, already formatted. Null when nothing to collect. */
  readonly codTotal: string | null;
  readonly currency: string;
}

interface Labels {
  readonly title: string;
  readonly route: string;
  readonly date: string;
  readonly driver: string;
  readonly vehicle: string;
  readonly issuedAt: string;
  readonly seq: string;
  readonly tracking: string;
  readonly recipient: string;
  readonly address: string;
  readonly cod: string;
  readonly parcels: string;
  readonly codTotal: string;
  readonly signatureDispatcher: string;
  readonly signatureDriver: string;
  readonly nameAndDate: string;
  readonly codNotice: string;
  readonly printHint: string;
}

const LABELS: Readonly<Record<DocumentLocale, Labels>> = {
  fr: {
    title: "Bon de distribution",
    route: "Tournée",
    date: "Date",
    driver: "Livreur",
    vehicle: "Véhicule",
    issuedAt: "Édité le",
    seq: "N°",
    tracking: "Suivi",
    recipient: "Destinataire",
    address: "Adresse",
    cod: "Contre-remboursement",
    parcels: "Colis",
    codTotal: "Total à encaisser",
    signatureDispatcher: "Signature du répartiteur",
    signatureDriver: "Signature du livreur",
    nameAndDate: "Nom, date et signature",
    codNotice: "Le livreur reconnaît avoir reçu les colis et devoir encaisser le total ci-dessus.",
    printHint: "Imprimez ce document et faites-le signer avant le départ.",
  },
  ar: {
    title: "وصل التوزيع",
    route: "الجولة",
    date: "التاريخ",
    driver: "السائق",
    vehicle: "المركبة",
    issuedAt: "حُرّر في",
    seq: "الرقم",
    tracking: "التتبع",
    recipient: "المستلم",
    address: "العنوان",
    cod: "الدفع عند الاستلام",
    parcels: "الطرود",
    codTotal: "المجموع المطلوب تحصيله",
    signatureDispatcher: "إمضاء المنظّم",
    signatureDriver: "إمضاء السائق",
    nameAndDate: "الاسم والتاريخ والإمضاء",
    codNotice: "يقر السائق باستلام الطرود وبوجوب تحصيل المبلغ الإجمالي أعلاه.",
    printHint: "اطبع هذه الوثيقة ووقّعها قبل الانطلاق.",
  },
  en: {
    title: "Distribution note",
    route: "Route",
    date: "Date",
    driver: "Driver",
    vehicle: "Vehicle",
    issuedAt: "Issued",
    seq: "#",
    tracking: "Tracking",
    recipient: "Recipient",
    address: "Address",
    cod: "Cash on delivery",
    parcels: "Parcels",
    codTotal: "Total to collect",
    signatureDispatcher: "Dispatcher signature",
    signatureDriver: "Driver signature",
    nameAndDate: "Name, date and signature",
    codNotice: "The driver confirms receipt of the parcels and of the total to collect above.",
    printHint: "Print this and have it signed before departure.",
  },
};

export function renderDistributionNote(data: DistributionNoteData): string {
  const labels = LABELS[data.locale];
  const dir = directionOf(data.locale);
  const e = escapeHtml;

  const rows = data.stops
    .map(
      (stop) => `
    <tr>
      <td class="seq">${String(stop.sequence)}</td>
      <td class="ltr mono">${e(stop.trackingNumber)}</td>
      <td>
        <div class="name">${e(stop.recipientName)}</div>
        <div class="ltr small">${e(stop.recipientPhone)}</div>
      </td>
      <td class="address">${e(stop.addressLine)}</td>
      <td class="cod">${
        stop.codAmount === null
          ? `<span class="muted">—</span>`
          : `${e(stop.codAmount)} ${e(data.currency)}`
      }</td>
      <td class="tick"></td>
    </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="${data.locale}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(labels.title)} — ${e(data.routeCode)}</title>
<style>
  /* A4: this is a table on a clipboard, not a card in a pocket. */
  @page { size: A4; margin: 12mm; }
  ${BASE_PRINT_CSS}
  body { font-size: 10pt; line-height: 1.35; }
  .meta { display: flex; flex-wrap: wrap; gap: 3mm 8mm; margin-block-start: 3mm;
          font-size: 9.5pt; }
  .meta div span { color: #555; }
  table.stops { width: 100%; border-collapse: collapse; margin-block-start: 5mm; }
  table.stops th, table.stops td {
    text-align: start; padding: 1.6mm 1.5mm; border: 0.4pt solid #bbb;
    vertical-align: top;
  }
  table.stops th { background: #f2f2f2; font-size: 8.5pt; text-transform: uppercase;
                   letter-spacing: 0.3pt; }
  .seq { width: 8mm; text-align: center; font-weight: 700; }
  .small { font-size: 8.5pt; color: #555; }
  .name { font-weight: 600; }
  .address { font-size: 9pt; }
  td.cod { text-align: end; white-space: nowrap; font-weight: 600; }
  /* The box a driver ticks per parcel as it goes into the van. This document is
     used while loading, not after. */
  .tick { width: 12mm; }
  tfoot td { font-weight: 700; border-block-start: 1pt solid #111; }
  .cod-notice { margin-block-start: 3mm; padding: 2mm 3mm; border: 1pt solid #111;
                font-weight: 600; font-size: 9pt; }
  @media print {
    /* ⚠️ The heading repeats on every sheet. A second page of thirty rows with
       no column headings is a page nobody can read. */
    thead { display: table-header-group; }
    tr { break-inside: avoid; }
  }
</style>
</head>
<body>
<article>
  <header>
    <div>
      <div class="courier">${e(data.courierName)}</div>
      <div class="doctype">${e(labels.title)}</div>
    </div>
    <div class="ltr mono">${e(data.routeCode)}</div>
  </header>

  <div class="meta">
    <div><span>${e(labels.date)}:</span> <strong>${e(data.plannedDate)}</strong></div>
    <div><span>${e(labels.driver)}:</span> <strong>${e(data.driverName)}</strong></div>
    ${
      data.vehiclePlate === null
        ? ""
        : `<div><span>${e(labels.vehicle)}:</span> <strong class="ltr">${e(data.vehiclePlate)}</strong></div>`
    }
    <div><span>${e(labels.parcels)}:</span> <strong>${String(data.stops.length)}</strong></div>
    <div><span>${e(labels.issuedAt)}:</span> ${e(
      formatDocumentDate(data.issuedAt, data.timezone, data.locale, true),
    )}</div>
  </div>

  <table class="stops">
    <thead>
      <tr>
        <th>${e(labels.seq)}</th>
        <th>${e(labels.tracking)}</th>
        <th>${e(labels.recipient)}</th>
        <th>${e(labels.address)}</th>
        <th>${e(labels.cod)}</th>
        <th></th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    ${
      data.codTotal === null
        ? ""
        : `<tfoot>
      <tr>
        <td colspan="4">${e(labels.codTotal)}</td>
        <td class="cod">${e(data.codTotal)} ${e(data.currency)}</td>
        <td></td>
      </tr>
    </tfoot>`
    }
  </table>

  ${data.codTotal === null ? "" : `<p class="cod-notice">${e(labels.codNotice)}</p>`}

  <div class="signatures">
    <div class="sig">
      <div class="line"></div>
      <div class="caption">${e(labels.signatureDispatcher)} — ${e(labels.nameAndDate)}</div>
    </div>
    <div class="sig">
      <div class="line"></div>
      <div class="caption">${e(labels.signatureDriver)} — ${e(labels.nameAndDate)}</div>
    </div>
  </div>

  <p class="print-hint no-print">${e(labels.printHint)}</p>
</article>
</body>
</html>`;
}
