import { deflateSync } from "node:zlib";

/**
 * Minimal, structurally valid image files for the POD media tests, built byte
 * by byte so each test states exactly which metadata block is present.
 */

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  return Uint8Array.from([0xff, marker, length >> 8, length & 0xff, ...payload]);
}

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

/** SOI, JFIF APP0, optional APP1, SOS with a scrap of scan data, EOI. */
export function jpegFixture(options: { exif?: boolean; xmp?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [
    Uint8Array.from([0xff, 0xd8]),
    segment(0xe0, Uint8Array.from([...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0])),
  ];
  if (options.exif === true) {
    parts.push(segment(0xe1, Uint8Array.from([...ascii("Exif\0\0"), 0x4d, 0x4d, 0, 0x2a])));
  }
  if (options.xmp === true) {
    parts.push(segment(0xe1, ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>")));
  }
  parts.push(segment(0xda, Uint8Array.from([1, 1, 0, 0, 0x3f, 0])));
  parts.push(Uint8Array.from([0x12, 0x34, 0x56, 0xff, 0x00, 0x78, 0xff, 0xd9]));
  return concat(parts);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const length = data.length;
  // CRC is not checked by the inspector; zeros keep the fixture readable.
  return Uint8Array.from([
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...ascii(type),
    ...data,
    0,
    0,
    0,
    0,
  ]);
}

/** A 1×1 PNG, with optional metadata chunks before the image data. */
export function pngFixture(
  options: { exif?: boolean; xmp?: boolean; software?: boolean } = {},
): Uint8Array {
  const ihdr = Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
  const parts: Uint8Array[] = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
  ];
  if (options.exif === true) {
    parts.push(chunk("eXIf", Uint8Array.from([0x4d, 0x4d, 0, 0x2a])));
  }
  if (options.xmp === true) {
    parts.push(chunk("iTXt", ascii("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>")));
  }
  if (options.software === true) {
    parts.push(chunk("tEXt", ascii("Software\0signature-pad")));
  }
  parts.push(chunk("IDAT", deflateSync(Uint8Array.from([0, 0]))));
  parts.push(chunk("IEND", new Uint8Array(0)));
  return concat(parts);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
