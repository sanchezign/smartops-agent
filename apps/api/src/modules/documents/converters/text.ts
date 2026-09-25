import { parse } from "csv-parse/sync";
import {
  DocumentRejectedError,
  type ConversionLimits,
  type ConversionResult,
  type ConversionWarning,
} from "../document-types.js";
import { capChars, countDigitLines, markdownTable } from "../markdown.js";

/**
 * CSV and plain text → text (pure).
 * Encoding: UTF-8 (with/without BOM) or UTF-16 LE with BOM; anything that is not valid
 * UTF-8 is decoded as Windows-1252 (Excel "CSV" exports in Spanish). CSV delimiter is
 * sniffed among ; , TAB | (Excel uses ";" where the decimal separator is a comma).
 * Decimal commas are left as written: the extractor handles "12,50".
 */

export function decodeText(bytes: Uint8Array): { text: string; windows1252: boolean } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), windows1252: false };
  }
  const body =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), windows1252: false };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(body), windows1252: true };
  }
}

const DELIMITERS = [";", ",", "\t", "|"] as const;

/** Most consistent delimiter over the first lines (quoted sections ignored). */
export function sniffDelimiter(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, 10)
    .map((l) => l.replace(/"[^"]*"/g, ""));
  let best: { delimiter: string; score: number } = { delimiter: ",", score: 0 };
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((l) => l.split(delimiter).length - 1);
    const withDelimiter = counts.filter((c) => c > 0);
    if (withDelimiter.length === 0) continue;
    // Lines agreeing on the most common count, weighted by that count.
    const freq = new Map<number, number>();
    for (const c of withDelimiter) freq.set(c, (freq.get(c) ?? 0) + 1);
    const [mode, agreeing] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
    const score = agreeing * 10 + mode;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

function encodingWarning(windows1252: boolean): ConversionWarning[] {
  return windows1252
    ? [{ code: "encoding_windows_1252", message: "Texto no UTF-8: se leyó como Windows-1252." }]
    : [];
}

export function convertCsv(bytes: Uint8Array, limits: ConversionLimits): ConversionResult {
  const { text, windows1252 } = decodeText(bytes);
  if (text.trim() === "") throw new DocumentRejectedError("empty", "empty CSV");
  let records: string[][];
  try {
    records = parse(text, {
      delimiter: sniffDelimiter(text),
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      trim: true,
      max_record_size: 100_000,
      to: limits.maxRowsPerSheet + 2, // header + max rows + 1 to detect truncation
    }) as string[][];
  } catch (err) {
    throw new DocumentRejectedError(
      "invalid_document",
      `invalid CSV: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    );
  }
  const warnings = encodingWarning(windows1252);
  const rowsTruncated = records.length > limits.maxRowsPerSheet + 1;
  const colsTruncated = records.some((r) => r.length > limits.maxColumns);
  const rows = records
    .slice(0, limits.maxRowsPerSheet + 1)
    .map((r) => r.slice(0, limits.maxColumns));
  const table = markdownTable(rows);
  if (!table) throw new DocumentRejectedError("empty", "no data in the CSV");
  if (rowsTruncated)
    warnings.push({
      code: "rows_truncated",
      message: `El CSV tiene más de ${limits.maxRowsPerSheet} filas: se leyeron las primeras.`,
    });
  if (colsTruncated)
    warnings.push({
      code: "columns_truncated",
      message: `El CSV tiene más de ${limits.maxColumns} columnas: se leyeron las primeras.`,
    });
  const capped = capChars(table.text, limits.maxChars);
  if (capped.truncated)
    warnings.push({
      code: "chars_truncated",
      message: `El texto supera ${limits.maxChars} caracteres: se truncó.`,
    });
  return {
    ok: true,
    format: "csv",
    text: capped.text,
    charCount: capped.text.length,
    dataRows: table.rows,
    truncated: capped.truncated || rowsTruncated || colsTruncated,
    needsReview: false,
    sheets: [{ name: "csv", dataRows: table.rows, columns: table.columns }],
    tables: [
      {
        name: "csv",
        rows: rows
          .map((r) => r.map((c) => (c.trim() === "" ? null : c)))
          .filter((r) => r.some((c) => c !== null)),
        truncated: rowsTruncated || colsTruncated,
      },
    ],
    warnings,
  };
}

export function convertPlainText(bytes: Uint8Array, limits: ConversionLimits): ConversionResult {
  const { text, windows1252 } = decodeText(bytes);
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""));
  const body = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (body === "") throw new DocumentRejectedError("empty", "empty text document");
  const warnings = encodingWarning(windows1252);
  const capped = capChars(body, limits.maxChars);
  if (capped.truncated)
    warnings.push({
      code: "chars_truncated",
      message: `El texto supera ${limits.maxChars} caracteres: se truncó.`,
    });
  return {
    ok: true,
    format: "txt",
    text: capped.text,
    charCount: capped.text.length,
    dataRows: countDigitLines(capped.text),
    truncated: capped.truncated,
    needsReview: false,
    sheets: [],
    tables: [],
    warnings,
  };
}
