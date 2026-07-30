import QRCode from "qrcode";

/**
 * The parcel QR code, in the three forms the codebase needs.
 *
 * Shared by {@link LabelService} (thermal label) and the document renderer
 * (printed paperwork) so the error-correction decision below is made ONCE. Two
 * copies of it would drift, and the copy that drifted downward would produce
 * labels that fail to scan in the field — discovered by a driver, not by a test.
 *
 * The payload is deliberately the **bare tracking number**, not a URL and not
 * JSON:
 *
 *  1. Every existing scan endpoint expects exactly that string, so a scanned code
 *     round-trips into custody with no parsing layer to disagree.
 *  2. It keeps the code sparse, which scans faster on a cheap handheld and
 *     survives more damage.
 *  3. A URL would leak the deployment's hostname onto every parcel and would break
 *     the moment the domain changes — while the tracking number is already the
 *     shipment's public identity (domain rule 10).
 */

/**
 * Error correction level.
 *
 * `M` (~15% recoverable) rather than the default `L`. A parcel label gets scuffed,
 * taped over, and rained on between the merchant's table and the recipient's
 * door; the extra redundancy costs a slightly denser code and buys scans that
 * would otherwise fail.
 */
const ERROR_CORRECTION = "M" as const;

/** Printed at ~30mm on a thermal label; 8 px/module keeps it crisp at 203 dpi. */
const MODULE_SCALE = 8;

const RASTER_OPTIONS = {
  errorCorrectionLevel: ERROR_CORRECTION,
  scale: MODULE_SCALE,
  margin: 2,
} as const;

/** PNG bytes — for a thermal label printer. */
export async function parcelQrPng(trackingNumber: string): Promise<Buffer> {
  return QRCode.toBuffer(trackingNumber, RASTER_OPTIONS);
}

/** A data URI — for embedding in HTML without a second request. */
export async function parcelQrDataUri(trackingNumber: string): Promise<string> {
  return QRCode.toDataURL(trackingNumber, RASTER_OPTIONS);
}

/**
 * Inline SVG markup — for printed paperwork.
 *
 * Vector rather than raster because these documents go to an ordinary office
 * printer at 600 dpi, where a PNG scaled to 24 mm shows its pixels. The XML
 * prolog is stripped: this markup is inlined into an HTML body, and a stray
 * `<?xml …?>` there is a parse error in some renderers.
 *
 * Width and height attributes are dropped too, so the document's CSS controls the
 * printed size through the viewBox and one stylesheet governs the layout.
 */
export async function parcelQrSvg(trackingNumber: string): Promise<string> {
  const svg = await QRCode.toString(trackingNumber, {
    type: "svg",
    errorCorrectionLevel: ERROR_CORRECTION,
    margin: 2,
  });
  return svg
    .replace(/<\?xml[^>]*\?>\s*/iu, "")
    .replace(/<!DOCTYPE[^>]*>\s*/iu, "")
    .replace(/\s(?:width|height)="[^"]*"/giu, "");
}
