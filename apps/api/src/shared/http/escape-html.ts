/**
 * Escapes text for interpolation into HTML.
 *
 * ⚠️ EVERY interpolated value goes through this. Recipient names, address lines,
 * invoice line descriptions and return reasons are all operator- or
 * merchant-supplied free text, so a value containing `<script>` would otherwise
 * execute in whatever browser opens the rendered document.
 *
 * `&` FIRST, or the entities the other replacements produce get escaped a second
 * time and `<` renders as the literal text `&lt;`.
 *
 * Lives in `shared/` rather than in whichever module first needed it: two
 * contexts render printable documents (shipment's bons, finance's factures), and
 * cross-module imports are forbidden. A second copy is how one of them quietly
 * stops escaping something.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
