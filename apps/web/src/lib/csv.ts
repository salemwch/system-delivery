/**
 * A minimal RFC 4180 CSV reader.
 *
 * Hand-written rather than a dependency because the requirement is one
 * function, and the whole point of the "one tool per job" rule is that a
 * parser pulled in for a single import screen becomes a thing to keep updated
 * forever. It handles what real exports contain: quoted fields, embedded commas
 * and newlines, doubled quotes, and CRLF.
 *
 * Deliberately NOT handled: alternative delimiters and character-set guessing.
 * A semicolon-separated French Excel export is a real thing, so the delimiter
 * is a parameter rather than a guess — asking the user beats detecting it
 * wrongly on the one file where it matters.
 */

/** U+FEFF, the byte-order mark Excel prepends when it saves UTF-8. */
const BYTE_ORDER_MARK = 0xfe_ff;

export interface CsvTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export function parseCsv(text: string, delimiter = ","): CsvTable {
  // A BOM is invisible and would otherwise become part of the first header
  // name, so `recipientName` silently stops matching on a file Excel saved.
  //
  // Compared by CODE POINT rather than matched as a character: a literal BOM in
  // this source file would be equally invisible to the next reader, and lint
  // rejects it as irregular whitespace for exactly that reason.
  const input = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  // The last row usually has no trailing newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [headerRow, ...dataRows] = rows;
  if (headerRow === undefined) {
    return { headers: [], rows: [] };
  }

  return {
    headers: headerRow.map((header) => header.trim()),
    // Blank lines are common at the end of a spreadsheet export and are not
    // rows; a row of empty strings would fail validation and look like the
    // user's mistake.
    rows: dataRows.filter((line) => line.some((cell) => cell.trim() !== "")),
  };
}
