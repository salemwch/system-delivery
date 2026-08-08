/**
 * The parts every printed document shares.
 *
 * ⚠️ EXTRACTED BECAUSE THERE WERE ALREADY TWO COPIES. `shipment/domain/document.ts`
 * and `finance/domain/invoice-document.ts` each carried their own locale union,
 * their own `directionOf`, and their own near-identical print CSS. Two more
 * documents (bon de distribution, bon de payment) would have made four, and the
 * fourth copy is where the Arabic bidi isolation quietly goes missing from one.
 *
 * What is NOT here: layout. A bon de livraison is an A5 card for a pocket, an
 * invoice is an A4 tax document, a route manifest is an A4 table of thirty
 * stops. Forcing one layout on all three would produce three bad documents.
 * This module owns the typography, the direction rules and the signature block —
 * the parts that must never differ.
 *
 * Pure — no I/O, no framework.
 */

const DOCUMENT_LOCALES = ["ar", "fr", "en"] as const;
export type DocumentLocale = (typeof DOCUMENT_LOCALES)[number];

const LOCALE_SET: ReadonlySet<string> = new Set<string>(DOCUMENT_LOCALES);

/**
 * French by default, not English.
 *
 * French is the working language of Tunisian courier administration, so an
 * operator who prints without choosing a language gets the document they would
 * have chosen anyway.
 */
export function toDocumentLocale(value: string | undefined): DocumentLocale {
  return value !== undefined && LOCALE_SET.has(value) ? (value as DocumentLocale) : "fr";
}

export function directionOf(locale: DocumentLocale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

/**
 * A date as the tenant's own timezone shows it.
 *
 * ⚠️ Arabic uses `ar-TN-u-nu-latn` — LATIN digits. Eastern Arabic numerals
 * (٢٠٢٦) are correct Arabic typography and wrong on a courier document: the
 * number gets read back down a phone line to someone reading a Latin-digit
 * screen, and the two must match.
 */
export function formatDocumentDate(
  at: Date,
  timezone: string,
  locale: DocumentLocale,
  withTime = false,
): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-TN-u-nu-latn" : `${locale}-TN`, {
    timeZone: timezone,
    dateStyle: "short",
    ...(withTime ? { timeStyle: "short" as const } : {}),
  }).format(at);
}

/**
 * The typography and direction rules every document needs.
 *
 * Callers append their own layout rules. Kept as a template string rather than a
 * separate stylesheet because a document is served as ONE self-contained
 * response — an external stylesheet is a second request that can fail, on a
 * page whose entire purpose is to be printed reliably.
 */
export const BASE_PRINT_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    /* System stack: no webfont, so nothing to fetch and nothing to fail. The OS
       Arabic font shapes correctly wherever the document is opened. */
    font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans Arabic", Arial, sans-serif;
    color: #111;
  }
  /*
    ⚠️ LATIN IDENTIFIERS STAY LTR INSIDE AN RTL DOCUMENT. A tracking number, a
    phone number or a plate read back to a call centre must not be mirrored, and
    an RTL paragraph would otherwise reorder them.
  */
  .ltr { direction: ltr; unicode-bidi: isolate; }
  .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
  .muted { color: #777; }
  header { display: flex; justify-content: space-between; align-items: flex-start;
           gap: 8mm; border-block-end: 1.5pt solid #111; padding-block-end: 3mm; }
  .courier { font-size: 13pt; font-weight: 700; }
  .doctype { font-size: 15pt; font-weight: 700; margin-block-start: 1mm; }
  .signatures { display: flex; gap: 6mm; margin-block-start: 8mm; }
  .sig { flex: 1 1 0; }
  .sig .line { border-block-end: 0.6pt solid #111; height: 16mm; }
  .sig .caption { font-size: 8.5pt; color: #555; margin-block-start: 1mm; }
  .print-hint { margin-block-start: 6mm; font-size: 9pt; color: #666; }
  @media print {
    /* A signature block split across a page break is not a signature block. */
    .signatures { break-inside: avoid; }
    .no-print { display: none; }
  }
`;
