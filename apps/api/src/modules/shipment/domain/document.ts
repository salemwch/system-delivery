/**
 * Delivery paperwork (docs/01-mvp-scope.md §4.2 #2.14).
 *
 * Paper documents are standard practice in Tunisian courier operations: a driver
 * carries a bon de livraison, a merchant keeps a bon d'envoi, and a returned
 * parcel travels back with a bon de retour. All three are printed, signed, and
 * filed, which is why the layout is A5 with wide margins and a signature block —
 * these are objects that get folded into a pocket, not web pages.
 *
 * ⚠️ RENDERS PRINT-READY HTML, NOT PDF BYTES, AND THAT IS THE CORRECT CHOICE FOR
 * THIS MARKET. Arabic needs bidirectional layout and contextual glyph shaping —
 * the same letter has different forms initial, medial and final. Browsers do both
 * natively; `pdfkit` and `pdf-lib` do NEITHER, so Arabic through them comes out as
 * disconnected letters in left-to-right order: a document a Tunisian customer
 * cannot read. The browser's own Print-to-PDF produces a correct PDF from this
 * HTML. If attachable PDF bytes are needed later, one headless renderer converts
 * these same templates and nothing here changes.
 *
 * Pure — no I/O, no framework. Everything it needs arrives in {@link DocumentData}.
 */

const DOCUMENT_TYPES = ["DELIVERY_NOTE", "CONSIGNMENT_NOTE", "RETURN_NOTE"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

const DOCUMENT_TYPE_SET: ReadonlySet<string> = new Set<string>(DOCUMENT_TYPES);

export function isDocumentType(value: string): value is DocumentType {
  return DOCUMENT_TYPE_SET.has(value);
}

const DOCUMENT_LOCALES = ["ar", "fr", "en"] as const;
export type DocumentLocale = (typeof DOCUMENT_LOCALES)[number];

const LOCALE_SET: ReadonlySet<string> = new Set<string>(DOCUMENT_LOCALES);

/**
 * French by default, not English.
 *
 * French is the working language of Tunisian courier administration, so an
 * operator who prints without choosing a language gets the document they would
 * have chosen.
 */
export function toDocumentLocale(value: string | undefined): DocumentLocale {
  return value !== undefined && LOCALE_SET.has(value) ? (value as DocumentLocale) : "fr";
}

/** Everything a document prints. Assembled by the service; this module is pure. */
export interface DocumentData {
  readonly documentType: DocumentType;
  readonly locale: DocumentLocale;
  /** The courier company printing it — the letterhead. */
  readonly courierName: string;
  readonly trackingNumber: string;
  /** Inline SVG markup for the tracking-number QR. Never a URL — see below. */
  readonly qrSvg: string;
  readonly issuedAt: Date;
  /** IANA zone the dates are rendered in, so a printed time is the local one. */
  readonly timezone: string;
  readonly senderName: string;
  readonly senderPhone: string;
  readonly originLines: readonly string[];
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly destinationLines: readonly string[];
  readonly parcelCount: number;
  readonly weightGrams: number;
  readonly serviceLevel: string;
  /** Already formatted through the currency's real exponent. Null when no COD. */
  readonly codAmount: string | null;
  readonly currency: string;
  readonly notes: string | null;
  /** Present on a bon de retour: why the parcel is going back. */
  readonly returnReason: string | null;
}

interface Labels {
  readonly title: Readonly<Record<DocumentType, string>>;
  readonly courier: string;
  readonly tracking: string;
  readonly issuedAt: string;
  readonly sender: string;
  readonly recipient: string;
  readonly phone: string;
  readonly parcels: string;
  readonly weight: string;
  readonly service: string;
  readonly cod: string;
  readonly codNone: string;
  readonly notes: string;
  readonly returnReason: string;
  readonly signatureRecipient: string;
  readonly signatureDriver: string;
  readonly signatureMerchant: string;
  readonly nameAndDate: string;
  readonly codNotice: string;
}

/**
 * Per-locale strings.
 *
 * Not reusing `notification/domain/templates.ts`: those are SMS bodies costed in
 * segments and owned by a different context. A document label and a text-message
 * body have no reason to change together.
 */
const LABELS: Readonly<Record<DocumentLocale, Labels>> = {
  fr: {
    title: {
      DELIVERY_NOTE: "Bon de livraison",
      CONSIGNMENT_NOTE: "Bon d'envoi",
      RETURN_NOTE: "Bon de retour",
    },
    courier: "Transporteur",
    tracking: "N° de suivi",
    issuedAt: "Émis le",
    sender: "Expéditeur",
    recipient: "Destinataire",
    phone: "Tél.",
    parcels: "Colis",
    weight: "Poids",
    service: "Service",
    cod: "Contre-remboursement",
    codNone: "Aucun",
    notes: "Observations",
    returnReason: "Motif du retour",
    signatureRecipient: "Signature du destinataire",
    signatureDriver: "Signature du livreur",
    signatureMerchant: "Signature de l'expéditeur",
    nameAndDate: "Nom et date",
    codNotice: "Montant à encaisser à la livraison.",
  },
  ar: {
    title: {
      DELIVERY_NOTE: "بون توصيل",
      CONSIGNMENT_NOTE: "بون إرسال",
      RETURN_NOTE: "بون إرجاع",
    },
    courier: "الناقل",
    tracking: "رقم التتبع",
    issuedAt: "تاريخ الإصدار",
    sender: "المرسل",
    recipient: "المرسل إليه",
    phone: "الهاتف",
    parcels: "الطرود",
    weight: "الوزن",
    service: "الخدمة",
    cod: "الدفع عند الاستلام",
    codNone: "لا شيء",
    notes: "ملاحظات",
    returnReason: "سبب الإرجاع",
    signatureRecipient: "توقيع المرسل إليه",
    signatureDriver: "توقيع الموزع",
    signatureMerchant: "توقيع المرسل",
    nameAndDate: "الاسم والتاريخ",
    codNotice: "المبلغ المطلوب تحصيله عند التسليم.",
  },
  en: {
    title: {
      DELIVERY_NOTE: "Delivery note",
      CONSIGNMENT_NOTE: "Consignment note",
      RETURN_NOTE: "Return note",
    },
    courier: "Carrier",
    tracking: "Tracking no.",
    issuedAt: "Issued",
    sender: "Sender",
    recipient: "Recipient",
    phone: "Tel.",
    parcels: "Parcels",
    weight: "Weight",
    service: "Service",
    cod: "Cash on delivery",
    codNone: "None",
    notes: "Notes",
    returnReason: "Reason for return",
    signatureRecipient: "Recipient signature",
    signatureDriver: "Driver signature",
    signatureMerchant: "Sender signature",
    nameAndDate: "Name and date",
    codNotice: "Amount to collect on delivery.",
  },
};

/** Arabic is the only RTL locale here; French and English are LTR. */
function directionOf(locale: DocumentLocale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

/**
 * Escapes text for HTML.
 *
 * ⚠️ EVERY interpolated value goes through this. A recipient name, an address line
 * and a return reason are all operator- or merchant-supplied free text, so a name
 * containing `<script>` would otherwise execute in whatever browser opens the
 * document. `&` first, or the other replacements get double-escaped.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/**
 * The document's local date and time.
 *
 * `Intl.DateTimeFormat` with the tenant's IANA zone: a bon de livraison printed
 * in Tunis must show Tunis time, and a hand-rolled offset is how "one hour out for
 * three weeks a year" gets onto signed paperwork. Latin digits even in Arabic —
 * a tracking reference and a date are read back to a call centre, and
 * Eastern-Arabic numerals are a transcription error waiting to happen.
 */
function formatLocalDateTime(at: Date, timezone: string, locale: DocumentLocale): string {
  const tag = locale === "ar" ? "ar-TN-u-nu-latn" : locale === "fr" ? "fr-TN" : "en-GB";
  return new Intl.DateTimeFormat(tag, {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

/** Grams → a printable weight. Metres and grams are the storage units (CLAUDE.md). */
function formatWeight(grams: number, locale: DocumentLocale): string {
  if (grams < 1000) {
    return locale === "ar" ? `${String(grams)} غ` : `${String(grams)} g`;
  }
  const kg = (grams / 1000).toFixed(grams % 1000 === 0 ? 0 : 2);
  return locale === "ar" ? `${kg} كغ` : `${kg} kg`;
}

/**
 * Which signature blocks a document carries — the difference between the three.
 *
 * A bon de livraison is signed by whoever receives the parcel; a bon d'envoi by
 * the merchant handing it over; a bon de retour by the merchant taking it back.
 * Printing the wrong pair makes the document useless as evidence, which is the
 * only reason it is on paper at all.
 */
function signatoriesFor(documentType: DocumentType, labels: Labels): readonly [string, string] {
  switch (documentType) {
    case "DELIVERY_NOTE":
      return [labels.signatureRecipient, labels.signatureDriver];
    case "CONSIGNMENT_NOTE":
      return [labels.signatureMerchant, labels.signatureDriver];
    case "RETURN_NOTE":
      return [labels.signatureMerchant, labels.signatureDriver];
  }
}

/**
 * Renders one document as a self-contained print-ready HTML page.
 *
 * Self-contained is a hard requirement: inline CSS, inline SVG QR, no external
 * font, image or script. A warehouse PC on a bad connection must print the same
 * document as a developer's laptop, and a document that silently loses its QR
 * because a CDN was unreachable is worse than one that never had it.
 *
 * CSS uses LOGICAL properties (`margin-inline`, `text-align: start`) per
 * CLAUDE.md, so the single stylesheet mirrors correctly for Arabic instead of
 * needing an RTL variant.
 */
export function renderDocument(data: DocumentData): string {
  const labels = LABELS[data.locale];
  const dir = directionOf(data.locale);
  const e = escapeHtml;
  const [leftSignatory, rightSignatory] = signatoriesFor(data.documentType, labels);

  const addressBlock = (lines: readonly string[]): string =>
    lines
      .filter((line) => line.trim().length > 0)
      .map((line) => `<div>${e(line)}</div>`)
      .join("");

  const row = (label: string, value: string): string =>
    `<tr><th>${e(label)}</th><td>${value}</td></tr>`;

  const codRow =
    data.codAmount === null
      ? row(labels.cod, `<span class="muted">${e(labels.codNone)}</span>`)
      : row(labels.cod, `<strong class="cod">${e(data.codAmount)} ${e(data.currency)}</strong>`);

  return `<!doctype html>
<html lang="${data.locale}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(labels.title[data.documentType])} — ${e(data.trackingNumber)}</title>
<style>
  /* A5: the size Tunisian couriers actually print these on, and two fit a sheet. */
  @page { size: A5; margin: 10mm; }
  @media print {
    /* A signature block split across a page break is not a signature block. */
    .signatures, .parties { break-inside: avoid; }
    .no-print { display: none; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    /* System stack: no webfont, so nothing to fetch and nothing to fail. The OS
       Arabic font shapes correctly wherever the document is opened. */
    font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans Arabic", Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.45;
    color: #111;
  }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm;
           border-block-end: 1.5pt solid #111; padding-block-end: 3mm; }
  .courier { font-size: 13pt; font-weight: 700; }
  .doctype { font-size: 15pt; font-weight: 700; margin-block-start: 1mm; }
  .qr { flex: 0 0 auto; text-align: center; }
  .qr svg { width: 24mm; height: 24mm; display: block; }
  .tracking { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
              font-size: 10pt; letter-spacing: 0.5pt; margin-block-start: 1mm;
              /* Latin, LTR even in an RTL document: a tracking number read back
                 to a call centre must not be mirrored. */
              direction: ltr; unicode-bidi: isolate; }
  .parties { display: flex; gap: 6mm; margin-block-start: 4mm; }
  .party { flex: 1 1 0; }
  .party h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.4pt;
              margin: 0 0 1mm; color: #555; }
  .party .name { font-weight: 700; }
  /* Phone numbers are E.164 and must stay LTR inside Arabic text. */
  .phone { direction: ltr; unicode-bidi: isolate; }
  table.details { width: 100%; border-collapse: collapse; margin-block-start: 4mm; }
  table.details th, table.details td {
    text-align: start; padding: 1.4mm 0; border-block-end: 0.4pt solid #ddd;
    vertical-align: top;
  }
  table.details th { width: 42%; font-weight: 400; color: #555; }
  .cod { font-size: 13pt; }
  .cod-notice { margin-block-start: 2mm; padding: 2mm 3mm; border: 1pt solid #111;
                font-weight: 700; }
  .muted { color: #777; }
  .signatures { display: flex; gap: 6mm; margin-block-start: 8mm; }
  .sig { flex: 1 1 0; }
  .sig .line { border-block-end: 0.6pt solid #111; height: 16mm; }
  .sig .caption { font-size: 8.5pt; color: #555; margin-block-start: 1mm; }
  .print-hint { margin-block-start: 6mm; font-size: 9pt; color: #666; }
</style>
</head>
<body>
<article>
  <header>
    <div>
      <div class="courier">${e(data.courierName)}</div>
      <div class="doctype">${e(labels.title[data.documentType])}</div>
      <div class="tracking">${e(data.trackingNumber)}</div>
    </div>
    <div class="qr">${data.qrSvg}</div>
  </header>

  <section class="parties">
    <div class="party">
      <h2>${e(labels.sender)}</h2>
      <div class="name">${e(data.senderName)}</div>
      <div class="phone">${e(data.senderPhone)}</div>
      ${addressBlock(data.originLines)}
    </div>
    <div class="party">
      <h2>${e(labels.recipient)}</h2>
      <div class="name">${e(data.recipientName)}</div>
      <div class="phone">${e(data.recipientPhone)}</div>
      ${addressBlock(data.destinationLines)}
    </div>
  </section>

  <table class="details">
    <tbody>
      ${row(labels.issuedAt, e(formatLocalDateTime(data.issuedAt, data.timezone, data.locale)))}
      ${row(labels.parcels, e(String(data.parcelCount)))}
      ${row(labels.weight, e(formatWeight(data.weightGrams, data.locale)))}
      ${row(labels.service, e(data.serviceLevel))}
      ${codRow}
      ${data.returnReason === null ? "" : row(labels.returnReason, e(data.returnReason))}
      ${data.notes === null ? "" : row(labels.notes, e(data.notes))}
    </tbody>
  </table>

  ${
    data.codAmount === null
      ? ""
      : `<div class="cod-notice">${e(labels.codNotice)} ${e(data.codAmount)} ${e(data.currency)}</div>`
  }

  <section class="signatures">
    <div class="sig">
      <div class="line"></div>
      <div class="caption">${e(leftSignatory)} — ${e(labels.nameAndDate)}</div>
    </div>
    <div class="sig">
      <div class="line"></div>
      <div class="caption">${e(rightSignatory)} — ${e(labels.nameAndDate)}</div>
    </div>
  </section>
</article>
</body>
</html>`;
}
