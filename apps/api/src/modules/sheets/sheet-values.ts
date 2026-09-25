import { createHash } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { cellText, type SheetCell } from "../documents/document-types.js";
import type { PriceFormat } from "./sheet-mapping.js";

const { Decimal } = Prisma;

/**
 * Deterministic cell interpretation for the spreadsheet path (pure, phase 5 M3c).
 */

/** Header cell normalized for fingerprints: accents, case, punctuation and spaces. */
export function normalizeHeaderCell(cell: SheetCell | undefined): string {
  return cellText(cell)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%/$]+/g, " ")
    .trim();
}

/**
 * Header fingerprint: sha256 of the normalized header cells in order (trailing empty
 * cells ignored). Null when the row cannot be a header (fewer than 2 text cells, or any
 * numeric cell).
 */
export function headerFingerprint(row: SheetCell[]): string | null {
  if (row.some((c) => c !== null && typeof c !== "string")) return null;
  const cells = row.map(normalizeHeaderCell);
  while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  if (cells.filter((c) => c !== "").length < 2) return null;
  return createHash("sha256").update(cells.join("\u001f")).digest("hex");
}

const MAX_DECIMALS = 4;
const CURRENCY_TOKENS = /(us\$|u\$s|\$u|usd|uyu|ars|\$|pesos?|d[oó]lares?)/gi;

function positiveDecimal(plain: string): string | null {
  if (!/^\d{1,14}(\.\d+)?$/.test(plain)) return null;
  const value = new Decimal(plain).toDecimalPlaces(MAX_DECIMALS, Decimal.ROUND_HALF_UP);
  return value.gt(0) ? value.toFixed() : null;
}

/**
 * Price of a cell as a plain decimal string, or null when it cannot be read with certainty.
 * Numeric cells are exact. Text follows the table's format: with decimal_comma, dots may
 * only group thousands ("1.250,50"); with decimal_dot, commas only group thousands
 * ("1,250.50"). Anything else ("12.50" in a decimal_comma table) is ambiguous → null.
 */
export function parsePrice(cell: SheetCell | undefined, format: PriceFormat): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell !== "string") return positiveDecimal(cell.n);
  const text = cell.replace(CURRENCY_TOKENS, "").replace(/\s+/g, ""); // \s covers NBSP too
  if (text === "") return null;
  if (format === "decimal_comma") {
    if (!/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/.test(text)) return null;
    return positiveDecimal(text.replace(/\./g, "").replace(",", "."));
  }
  if (!/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(text)) return null;
  return positiveDecimal(text.replace(/,/g, ""));
}

/** Signed percentage points ("+10%", "-5 %", "10", numeric 10) → "10", "-5"; null if invalid. */
export function parsePercentage(cell: SheetCell | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  const text = cellText(cell)
    .replace(/[\s%]+/g, "")
    .replace(",", ".");
  if (!/^[+-]?\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const value = new Decimal(text);
  if (value.isZero() || value.lte(-100)) return null;
  return value.toFixed();
}

export function parseStock(cell: SheetCell | undefined): number | null {
  const text = cellText(cell).replace(/[\s.]/g, "");
  if (!/^\d{1,9}$/.test(text)) return null;
  return Number(text);
}

export function parseAvailable(cell: SheetCell | undefined): boolean | null {
  const text = cellText(cell).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  if (text === "") return null;
  if (/sin stock|agotad|no hay|discontinu|^no$|^0$/.test(text)) return false;
  if (/^si$|disponible|en stock|^hay$|^ok$/.test(text)) return true;
  return null;
}

export function parseCurrency(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (text === "") return null;
  if (/u\$s|us\$|usd|d[oó]lar/.test(text)) return "USD";
  if (/\$u|uyu|uruguay/.test(text)) return "UYU";
  if (/ars|argentin/.test(text)) return "ARS";
  if (/^[a-z]{3}$/.test(text)) return text.toUpperCase();
  return null;
}
