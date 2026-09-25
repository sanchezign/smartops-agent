import * as XLSX from "xlsx";
import {
  DocumentRejectedError,
  type ConversionLimits,
  type ConversionResult,
  type ConversionWarning,
  type SheetSummary,
} from "../document-types.js";
import { capChars, markdownTable } from "../markdown.js";
import { assertSafeZip } from "../zip-guard.js";

/**
 * xlsx / xls → Markdown (SheetJS CE 0.20.3 from the SheetJS CDN, ADR-013).
 * - Visible sheets only (hidden / very hidden are skipped: old prices, injected text).
 * - Formulas are NEVER evaluated: the value cached by Excel is used; a formula without a
 *   cached value becomes an empty cell + warning, and the run goes to human review.
 * - Merged cells: vertical merges repeat the value on every row (each product keeps its
 *   category); horizontal merges keep it in the first column only.
 * - Hidden rows/columns are skipped. Numbers as plain decimals (no locale formatting),
 *   percentages as displayed ("10%"), dates as YYYY-MM-DD.
 */

type Cell = XLSX.CellObject | undefined;

/** Plain decimal without exponent or float artifacts: 310.5, 0.3, 1850. */
export function plainNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 15 });
}

function isoDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

interface CellStats {
  formulaWithoutValue: number;
  errorCells: number;
}

function cellText(cell: Cell, stats: CellStats): string {
  if (!cell) return "";
  if (cell.f !== undefined && cell.v === undefined) {
    stats.formulaWithoutValue += 1;
    return "";
  }
  switch (cell.t) {
    case "n": {
      const format = typeof cell.z === "string" ? cell.z : "";
      if (format.includes("%") && cell.w) return cell.w;
      // Date-formatted serial numbers that were not converted by the reader.
      if (typeof cell.v === "number" && format && XLSX.SSF.is_date(format)) {
        const d = XLSX.SSF.parse_date_code(cell.v);
        if (d)
          return `${String(d.y).padStart(4, "0")}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
      }
      return typeof cell.v === "number" ? plainNumber(cell.v) : (cell.w ?? "");
    }
    case "d":
      return isoDate(cell.v);
    case "b":
      return cell.v ? "VERDADERO" : "FALSO";
    case "e":
      stats.errorCells += 1;
      return cell.w ?? "#ERROR";
    case "s":
      return String(cell.v ?? "");
    default:
      return "";
  }
}

export function convertSpreadsheet(
  bytes: Uint8Array,
  format: "xlsx" | "xls",
  limits: ConversionLimits,
): ConversionResult {
  if (format === "xlsx") assertSafeZip(bytes, limits);

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, {
      type: "buffer",
      cellFormula: true,
      cellNF: true,
      cellDates: true,
      cellStyles: true,
      cellHTML: false,
      sheetRows: limits.maxRowsPerSheet + 1, // + header row
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/password|encrypt/i.test(message)) throw new DocumentRejectedError("encrypted", message);
    throw new DocumentRejectedError("invalid_document", message.slice(0, 200));
  }

  const warnings: ConversionWarning[] = [];
  const stats: CellStats = { formulaWithoutValue: 0, errorCells: 0 };
  const meta = workbook.Workbook?.Sheets ?? [];
  const hiddenSheets = workbook.SheetNames.filter((_, i) => (meta[i]?.Hidden ?? 0) !== 0);
  const visible = workbook.SheetNames.filter((_, i) => (meta[i]?.Hidden ?? 0) === 0);
  if (hiddenSheets.length > 0) {
    warnings.push({
      code: "hidden_sheets_skipped",
      message: `Hojas ocultas ignoradas: ${hiddenSheets.length}.`,
    });
  }
  if (visible.length > limits.maxSheets) {
    warnings.push({
      code: "sheets_truncated",
      message: `Solo se leyeron las primeras ${limits.maxSheets} hojas de ${visible.length}.`,
    });
  }

  let hiddenRows = 0;
  let hiddenCols = 0;
  let rowsTruncated = false;
  let colsTruncated = false;
  let emptySheets = 0;
  const sheets: SheetSummary[] = [];
  const blocks: string[] = [];

  for (const name of visible.slice(0, limits.maxSheets)) {
    const sheet = workbook.Sheets[name];
    const ref = sheet?.["!ref"];
    if (!sheet || !ref) {
      emptySheets += 1;
      continue;
    }
    const range = XLSX.utils.decode_range(ref);
    const fullRef = sheet["!fullref"];
    if (fullRef && XLSX.utils.decode_range(fullRef).e.r > range.e.r) rowsTruncated = true;
    const lastCol = Math.min(range.e.c, range.s.c + limits.maxColumns - 1);
    if (range.e.c > lastCol) colsTruncated = true;

    // Vertical merges: every covered row shows the top-left value in the first column.
    const mergedFrom = new Map<string, string>();
    for (const merge of sheet["!merges"] ?? []) {
      const origin = XLSX.utils.encode_cell(merge.s);
      for (let r = merge.s.r + 1; r <= merge.e.r; r += 1) {
        mergedFrom.set(XLSX.utils.encode_cell({ r, c: merge.s.c }), origin);
      }
    }

    const rowProps = sheet["!rows"] ?? [];
    const colProps = sheet["!cols"] ?? [];
    const rows: string[][] = [];
    for (let r = range.s.r; r <= range.e.r; r += 1) {
      if (rowProps[r]?.hidden) {
        hiddenRows += 1;
        continue;
      }
      const row: string[] = [];
      for (let c = range.s.c; c <= lastCol; c += 1) {
        if (colProps[c]?.hidden) {
          if (r === range.s.r) hiddenCols += 1;
          continue;
        }
        const address = XLSX.utils.encode_cell({ r, c });
        const source = mergedFrom.get(address) ?? address;
        row.push(cellText(sheet[source] as Cell, stats));
      }
      rows.push(row);
    }
    const table = markdownTable(rows);
    if (!table) {
      emptySheets += 1;
      continue;
    }
    sheets.push({ name, dataRows: table.rows, columns: table.columns });
    blocks.push(`## Hoja: ${name.replace(/[\r\n]/g, " ")}\n\n${table.text}`);
  }

  if (blocks.length === 0)
    throw new DocumentRejectedError("empty", "no visible data in the workbook");
  if (emptySheets > 0)
    warnings.push({
      code: "empty_sheets_skipped",
      message: `Hojas vacías ignoradas: ${emptySheets}.`,
    });
  if (hiddenRows > 0)
    warnings.push({
      code: "hidden_rows_skipped",
      message: `Filas ocultas ignoradas: ${hiddenRows}.`,
    });
  if (hiddenCols > 0)
    warnings.push({
      code: "hidden_columns_skipped",
      message: `Columnas ocultas ignoradas: ${hiddenCols}.`,
    });
  if (rowsTruncated)
    warnings.push({
      code: "rows_truncated",
      message: `Hay hojas con más de ${limits.maxRowsPerSheet} filas: se leyeron las primeras.`,
    });
  if (colsTruncated)
    warnings.push({
      code: "columns_truncated",
      message: `Hay hojas con más de ${limits.maxColumns} columnas: se leyeron las primeras.`,
    });
  if (stats.formulaWithoutValue > 0)
    warnings.push({
      code: "formula_without_value",
      message: `${stats.formulaWithoutValue} fórmulas sin valor calculado (celdas vacías): requiere revisión.`,
    });
  if (stats.errorCells > 0)
    warnings.push({ code: "error_cells", message: `${stats.errorCells} celdas con error (#…).` });

  const capped = capChars(blocks.join("\n\n"), limits.maxChars);
  if (capped.truncated)
    warnings.push({
      code: "chars_truncated",
      message: `El texto supera ${limits.maxChars} caracteres: se truncó.`,
    });

  return {
    ok: true,
    format,
    text: capped.text,
    charCount: capped.text.length,
    dataRows: sheets.reduce((sum, s) => sum + s.dataRows, 0),
    truncated:
      capped.truncated || rowsTruncated || colsTruncated || visible.length > limits.maxSheets,
    needsReview: stats.formulaWithoutValue > 0,
    sheets,
    warnings,
  };
}
