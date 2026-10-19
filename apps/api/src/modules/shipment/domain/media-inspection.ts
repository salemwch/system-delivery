/**
 * What an uploaded POD file really is, read from its bytes (docs/07 §7.1:
 * "magic-byte verification server-side after upload, never trust the declared
 * type", "EXIF stripped").
 *
 * The driver app re-encodes every photo before upload, which drops EXIF
 * (decision 2026-10-19). This module is the server's check that it did: a file
 * still carrying a metadata block is refused, not cleaned, because cleaning
 * means re-encoding on the server, and a file that arrives with metadata means
 * the app is not doing its job and should be fixed, not covered for.
 */

export type MediaContentType = "image/jpeg" | "image/png";

export type InspectionVerdict =
  | { readonly ok: true; readonly contentType: MediaContentType }
  | { readonly ok: false; readonly reason: "TYPE_MISMATCH" | "EXIF_PRESENT" };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Verifies `bytes` are a well-formed `declared` image with no metadata block. */
export function inspectImage(bytes: Uint8Array, declared: MediaContentType): InspectionVerdict {
  const detected = detectType(bytes);
  if (detected !== declared) {
    return { ok: false, reason: "TYPE_MISMATCH" };
  }
  const metadata = detected === "image/jpeg" ? jpegMetadata(bytes) : pngMetadata(bytes);
  if (metadata === "malformed") {
    return { ok: false, reason: "TYPE_MISMATCH" };
  }
  if (metadata === "present") {
    return { ok: false, reason: "EXIF_PRESENT" };
  }
  return { ok: true, contentType: detected };
}

function detectType(bytes: Uint8Array): MediaContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    return "image/png";
  }
  return null;
}

type Metadata = "absent" | "present" | "malformed";

/**
 * Walks the JPEG marker segments up to the start of scan. Any APP1 segment is
 * metadata: EXIF (`Exif\0\0`) and XMP both live there, and both can carry
 * GPS coordinates. A re-encoded camera image has APP0 (JFIF) at most.
 */
function jpegMetadata(bytes: Uint8Array): Metadata {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return "malformed";
    }
    // Fill bytes: any number of 0xFF may precede a marker.
    while (bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined) {
      return "malformed";
    }
    // Start of scan or end of image: no metadata segment can follow.
    if (marker === 0xda || marker === 0xd9) {
      return "absent";
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    const high = bytes[offset];
    const low = bytes[offset + 1];
    if (high === undefined || low === undefined) {
      return "malformed";
    }
    const length = (high << 8) | low;
    if (length < 2 || offset + length > bytes.length) {
      return "malformed";
    }
    if (marker === 0xe1) {
      return "present";
    }
    offset += length;
  }
  return "malformed";
}

/**
 * Walks the PNG chunks to IEND. `eXIf` is EXIF; an `iTXt` chunk with the
 * `XML:com.adobe.xmp` keyword is XMP. Either can carry a location.
 */
function pngMetadata(bytes: Uint8Array): Metadata {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset: number = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const next = dataStart + length + 4; // data + CRC
    if (next > bytes.length) {
      return "malformed";
    }
    if (type === "eXIf") {
      return "present";
    }
    if (type === "iTXt" && startsWithAscii(bytes, dataStart, "XML:com.adobe.xmp\0")) {
      return "present";
    }
    if (type === "IEND") {
      return "absent";
    }
    offset = next;
  }
  return "malformed";
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}
