import { cellText, type SheetCell, type SheetTable } from "../documents/document-types.js";
import type { ExtractedItem } from "../extraction/extraction.schemas.js";
import type { SheetMapping } from "./sheet-mapping.js";
import {
  headerFingerprint,
  parseAvailable,
  parseCurrency,
  parsePercentage,
  parsePrice,
  parseStock,
} from "./sheet-values.js";

/**
 * Deterministic reader (pure, phase 5 M3c): every row of a table with an approved mapping
 * becomes an extracted item, with NO LLM output per row. Rows without a name, or with a
 * name and no price (category headings), are skipped; a row whose price cannot be read
 * with certainty is a failure (never a guessed price). More than 20 % failures means the
 * format changed: the mapping is retired and the table is mapped again (review).
 */

export const MAX_FAILURE_RATE = 0.2;

export interface RowFailure {
  row: number;
  name: string;
  reason: "unreadable_price" | "unreadable_percentage";
}

export interface ReadResult {
  items: ExtractedItem[];
  failures: RowFailure[];
  skipped: number;
}

const text = (cell: SheetCell | undefined, max: number): string | null => {
  const value = cellText(cell).replace(/\s+/g, " ").trim();
  return value ? value.slice(0, max) : null;
};

export function readTable(table: SheetTable, headerRow: number, mapping: SheetMapping): ReadResult {
  const items: ExtractedItem[] = [];
  const failures: RowFailure[] = [];
  let skipped = 0;
  const header = table.rows[headerRow];
  const headerPrint = header ? headerFingerprint(header) : null;
  const at = (row: SheetCell[], column: number | null) =>
    column === null ? undefined : row[column];

  table.rows.slice(headerRow + 1).forEach((row, offset) => {
    const rowIndex = headerRow + 1 + offset;
    const name = text(at(row, mapping.nameColumn), 200);
    // Repeated header rows (long sheets printed with headers on every page).
    if (!name || (headerPrint !== null && headerFingerprint(row) === headerPrint)) {
      skipped += 1;
      return;
    }
    const priceCell = at(row, mapping.priceColumn);
    const pctCell = at(row, mapping.pctColumn);
    const hasPrice = cellText(priceCell).trim() !== "";
    const hasPct = cellText(pctCell).trim() !== "";
    if (!hasPrice && !hasPct) {
      skipped += 1; // category heading or product without price
      return;
    }

    let price: string | null = null;
    let priceChangePct: string | null = null;
    if (hasPrice) {
      price = parsePrice(priceCell, mapping.priceFormat);
      if (price === null) {
        failures.push({ row: rowIndex, name, reason: "unreadable_price" });
        return;
      }
    } else {
      priceChangePct = parsePercentage(pctCell);
      if (priceChangePct === null) {
        failures.push({ row: rowIndex, name, reason: "unreadable_percentage" });
        return;
      }
    }

    const rowCurrency =
      mapping.currencyColumn !== null
        ? parseCurrency(cellText(at(row, mapping.currencyColumn)))
        : null;
    items.push({
      name,
      sku: text(at(row, mapping.skuColumn), 80),
      unit: text(at(row, mapping.unitColumn), 40),
      price,
      priceChangePct,
      currency: priceChangePct === null ? rowCurrency : null,
      available:
        mapping.availableColumn !== null ? parseAvailable(at(row, mapping.availableColumn)) : null,
      stock: mapping.stockColumn !== null ? parseStock(at(row, mapping.stockColumn)) : null,
      catalogRef: null,
      matchConfidence: "high",
      uncertain: false,
      note: null,
    });
  });
  return { items, failures, skipped };
}

export function failureRate(result: ReadResult): number {
  const total = result.items.length + result.failures.length;
  return total === 0 ? 0 : result.failures.length / total;
}
