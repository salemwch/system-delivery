import QRCode from "qrcode";

/**
 * Renders an `otpauth://` provisioning URI as an inline SVG.
 *
 * Server-side because the URI CONTAINS THE SHARED SECRET. Drawing it in the
 * browser would put the second factor into client JavaScript and into any
 * script sharing that page — the opposite of what the rest of this app does
 * with credentials.
 *
 * SVG rather than a PNG data URI: it is markup, so it renders under a strict
 * `img-src` without a `data:` allowance, and it stays sharp at whatever size
 * the stylesheet picks.
 */

/**
 * Medium correction — ~15% recoverable.
 *
 * A phone camera reads this off a screen at arm's length, not off a smudged
 * label, so the higher levels only make the modules smaller and harder to scan.
 */
const ERROR_CORRECTION = "M" as const;

export async function totpQrSvg(provisioningUri: string): Promise<string> {
  const svg = await QRCode.toString(provisioningUri, {
    type: "svg",
    errorCorrectionLevel: ERROR_CORRECTION,
    margin: 2,
  });
  return (
    svg
      // Inlined into an HTML body, where a stray prolog is a parse error in
      // some renderers.
      .replace(/<\?xml[^>]*\?>\s*/iu, "")
      // Drop the fixed dimensions so CSS controls the size through the viewBox.
      .replace(/\s(width|height)="[^"]*"/giu, "")
  );
}
