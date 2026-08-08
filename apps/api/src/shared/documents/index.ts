/**
 * Shared printing primitives.
 *
 * Typography, direction rules and date formatting for every printed document —
 * the parts that must never differ between a bon de livraison, an invoice and a
 * route manifest. Layout belongs to each document; this does not impose one.
 */
export {
  BASE_PRINT_CSS,
  directionOf,
  formatDocumentDate,
  toDocumentLocale,
} from "./print.js";
export type { DocumentLocale } from "./print.js";
