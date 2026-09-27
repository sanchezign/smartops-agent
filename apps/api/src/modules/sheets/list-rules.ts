import { normalizeUntrusted } from "../../common/text-normalize.js";
import { cellText, type SheetTable } from "../documents/document-types.js";

/**
 * List-level signals of a spreadsheet WITHOUT an LLM (pure, phase 5 M3c), read from the
 * text outside the product rows (titles above the header, notes, other sheets):
 * tax basis, currency, explicit full-list evidence (quoted) and injection attempts.
 * Conservative: when unclear or contradictory, null.
 */

export interface ListSignals {
  taxIncluded: boolean | null;
  currency: string | null;
  fullListEvidence: string | null;
  suspicious: boolean;
}

const TAX_TRUE = /iva inclu[ií]do|con iva|c\/\s*iva|precios? finales?/i;
const TAX_FALSE = /\+\s*iva|m[aá]s iva|sin iva|s\/\s*iva|iva no inclu[ií]do|no incluye iva/i;
const FULL_LIST =
  /lista (de precios )?(completa|vigente)|reemplaza (a )?la (lista )?anterior|cat[aá]logo completo/i;
// Verb (Spanish + English synonyms: ignorá/desestimá/descartá/olvidá, disregard/forget) + the
// object it must act on (instrucciones/instructions) — requiring the object avoids flagging
// ordinary supplier notes like "ignorar la fila 3" or "descartá ese precio" (see the control
// cases in test/unit/prompt-injection.test.ts). Text is normalizeUntrusted()-ed first (phase 10
// finding: zero-width characters and full-width forms dodged the plain-ASCII regex).
const INJECTION =
  /(?:ignor(?:a|á|e|ar)|desestim(?:a|á|e|ar)|descart(?:a|á|e|ar)|disregard|forget)\s+(?:todas\s+)?(?:las\s+|all\s+|the\s+|previous\s+)?(?:instrucciones|previous instructions|instructions)|olvid(?:a|á)\s+(?:las|todas)\s+(?:las\s+)?instruccion(?:es)?|system prompt|you are now|sos un asistente|actu[aá] como/i;

const CURRENCIES: ReadonlyArray<readonly [string, RegExp]> = [
  ["UYU", /pesos uruguayos|\$u\b|\buyu\b/i],
  ["USD", /d[oó]lares|u\$s|us\$|\busd\b/i],
  ["ARS", /pesos argentinos|\bars\b/i],
];

export function containsInjection(value: string): boolean {
  return INJECTION.test(normalizeUntrusted(value));
}

export function listSignals(rawText: string): ListSignals {
  const text = normalizeUntrusted(rawText);
  const taxTrue = TAX_TRUE.test(text);
  const taxFalse = TAX_FALSE.test(text);
  const currencies = CURRENCIES.filter(([, re]) => re.test(text)).map(([code]) => code);
  const evidenceLine = text.split("\n").find((line) => FULL_LIST.test(line));
  return {
    taxIncluded: taxTrue === taxFalse ? null : taxTrue,
    currency: currencies.length === 1 ? currencies[0]! : null,
    fullListEvidence: evidenceLine ? evidenceLine.trim().slice(0, 300) : null,
    suspicious: containsInjection(text),
  };
}

/** Text outside the product rows: rows above each header and every non-price table. */
export function textOutsideRows(
  tables: SheetTable[],
  headerRows: ReadonlyMap<number, number>,
  maxChars = 4_000,
): string {
  const lines: string[] = [];
  tables.forEach((table, index) => {
    const header = headerRows.get(index);
    const rows = header === undefined ? table.rows : table.rows.slice(0, header);
    for (const row of rows) {
      const line = row
        .map(cellText)
        .filter((c) => c.trim() !== "")
        .join(" | ");
      if (line) lines.push(line);
    }
  });
  return lines.join("\n").slice(0, maxChars);
}

/** Every text cell of the tables (injection scan of the product rows too). */
export function allCellText(tables: SheetTable[], maxChars = 200_000): string {
  const parts: string[] = [];
  let size = 0;
  for (const table of tables) {
    for (const row of table.rows) {
      for (const cell of row) {
        if (typeof cell !== "string") continue;
        parts.push(cell);
        size += cell.length;
        if (size > maxChars) return parts.join("\n");
      }
    }
  }
  return parts.join("\n");
}
