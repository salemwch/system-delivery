import { describe, expect, it } from "vitest";

import { inspectImage } from "../src/modules/shipment/domain/media-inspection.js";
import { jpegFixture, pngFixture } from "./media.fixtures.js";

describe("inspectImage", () => {
  it("accepts a clean JPEG and a clean PNG", () => {
    expect(inspectImage(jpegFixture(), "image/jpeg")).toEqual({
      ok: true,
      contentType: "image/jpeg",
    });
    expect(inspectImage(pngFixture(), "image/png")).toEqual({ ok: true, contentType: "image/png" });
  });

  it("refuses bytes that are not the declared type", () => {
    expect(inspectImage(pngFixture(), "image/jpeg")).toEqual({
      ok: false,
      reason: "TYPE_MISMATCH",
    });
    expect(inspectImage(jpegFixture(), "image/png")).toEqual({
      ok: false,
      reason: "TYPE_MISMATCH",
    });
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect(inspectImage(html, "image/jpeg")).toEqual({ ok: false, reason: "TYPE_MISMATCH" });
    expect(inspectImage(new Uint8Array(0), "image/png")).toEqual({
      ok: false,
      reason: "TYPE_MISMATCH",
    });
  });

  it("refuses a JPEG carrying EXIF or XMP (APP1)", () => {
    expect(inspectImage(jpegFixture({ exif: true }), "image/jpeg")).toEqual({
      ok: false,
      reason: "EXIF_PRESENT",
    });
    expect(inspectImage(jpegFixture({ xmp: true }), "image/jpeg")).toEqual({
      ok: false,
      reason: "EXIF_PRESENT",
    });
  });

  it("refuses a PNG carrying eXIf or XMP, and keeps other text chunks", () => {
    expect(inspectImage(pngFixture({ exif: true }), "image/png")).toEqual({
      ok: false,
      reason: "EXIF_PRESENT",
    });
    expect(inspectImage(pngFixture({ xmp: true }), "image/png")).toEqual({
      ok: false,
      reason: "EXIF_PRESENT",
    });
    // A canvas export often names its software; that is not a location.
    expect(inspectImage(pngFixture({ software: true }), "image/png").ok).toBe(true);
  });

  it("refuses a truncated or malformed file as the wrong type", () => {
    const jpeg = jpegFixture();
    expect(inspectImage(jpeg.subarray(0, 8), "image/jpeg")).toEqual({
      ok: false,
      reason: "TYPE_MISMATCH",
    });
    const png = pngFixture();
    expect(inspectImage(png.subarray(0, png.length - 6), "image/png")).toEqual({
      ok: false,
      reason: "TYPE_MISMATCH",
    });
    // A segment length pointing past the end of the file.
    const lying = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00]);
    expect(inspectImage(lying, "image/jpeg")).toEqual({ ok: false, reason: "TYPE_MISMATCH" });
  });
});
