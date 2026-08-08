import { describe, expect, it } from "vitest";

import { parseCsv } from "../src/lib/csv";

/**
 * Real merchant exports, not tidy fixtures. Every case here is something an
 * actual spreadsheet produces and a naive `split(",")` gets wrong.
 */
describe("parseCsv", () => {
  it("reads a plain table", () => {
    const { headers, rows } = parseCsv("name,phone\nFarah,24201314\nKarim,98765432");
    expect(headers).toEqual(["name", "phone"]);
    expect(rows).toEqual([
      ["Farah", "24201314"],
      ["Karim", "98765432"],
    ]);
  });

  it("keeps commas inside quoted fields", () => {
    // A Tunisian address is full of commas. Splitting on them shifts every
    // column after the address by one.
    const { rows } = parseCsv('name,address\nFarah,"Rue de Marseille, Sousse, TN"');
    expect(rows[0]).toEqual(["Farah", "Rue de Marseille, Sousse, TN"]);
  });

  it("keeps newlines inside quoted fields", () => {
    const { rows } = parseCsv('name,notes\nFarah,"line one\nline two"');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[1]).toBe("line one\nline two");
  });

  it("unescapes doubled quotes", () => {
    const { rows } = parseCsv('name\n"Chez ""Farah"""');
    expect(rows[0]?.[0]).toBe('Chez "Farah"');
  });

  it("handles CRLF, which is what Excel on Windows writes", () => {
    const { headers, rows } = parseCsv("name,phone\r\nFarah,24201314\r\n");
    expect(headers).toEqual(["name", "phone"]);
    expect(rows).toEqual([["Farah", "24201314"]]);
  });

  it("strips a UTF-8 BOM", () => {
    // Invisible, and it would otherwise become part of the first header name —
    // so `name` silently stops matching and every row fails validation.
    const { headers } = parseCsv("﻿name,phone\nFarah,24201314");
    expect(headers[0]).toBe("name");
  });

  it("supports a semicolon delimiter", () => {
    // French Excel exports use `;`. Detecting it automatically guesses wrong on
    // a file whose data contains semicolons, so it is a parameter.
    const { headers, rows } = parseCsv("name;phone\nFarah;24201314", ";");
    expect(headers).toEqual(["name", "phone"]);
    expect(rows[0]).toEqual(["Farah", "24201314"]);
  });

  it("drops trailing blank lines rather than failing on them", () => {
    const { rows } = parseCsv("name\nFarah\n\n\n");
    expect(rows).toEqual([["Farah"]]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
  });
});
