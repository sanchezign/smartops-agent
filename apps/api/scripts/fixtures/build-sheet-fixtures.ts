/**
 * Builds the spreadsheet fixtures of phase 5 M3c (fictitious data, neutral products):
 *   pnpm --filter @smartops/api exec tsx scripts/fixtures/build-sheet-fixtures.ts
 * Output: test/fixtures/sheets/. Committed as binaries so golden outputs (keyed by
 * content) stay valid; re-running with the same code produces the same workbook data.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as XLSX from "xlsx";

const dir = new URL("../../test/fixtures/sheets/", import.meta.url);
mkdirSync(dir, { recursive: true });
const FIXED_DATE = new Date("2026-09-25T12:00:00Z");

function save(name: string, wb: XLSX.WorkBook) {
  wb.Props = { CreatedDate: FIXED_DATE, ModifiedDate: FIXED_DATE, Author: "SmartOps fixtures" };
  writeFileSync(new URL(name, dir), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

// Four price columns (net / with VAT / wholesale / cash): the mapping must be ambiguous.
{
  const ws = XLSX.utils.aoa_to_sheet([
    ["DISTRIBUIDORA EJEMPLO S.R.L. - LISTA DE PRECIOS NOVIEMBRE 2026"],
    ["Precios en pesos uruguayos"],
    [],
    ["Código", "Descripción", "Unidad", "Precio s/IVA", "Precio c/IVA", "Mayorista", "Contado"],
    ["SELLADORES"],
    ["SEL-280", "Silicona transparente 280ml", "unidad", 254.51, 310.5, 230, 295],
    ["SEL-500", "Sellador acrílico 500g", "unidad", 200.82, 245, 185, 233],
    ["PINTURERÍA"],
    ["PIN-023", "Rodillo lana 23cm", "unidad", 372.95, 455, 340, 432],
    ["PIN-002", "Pincel 2 pulgadas", "unidad", 118.03, 144, 108, 137],
    ["LIJ-220", "Lija al agua grano 220", "pliego", 36.07, 44, 33, 42],
    ["ABRASIVOS"],
    ["DIS-115", "Disco de corte 115mm", "unidad", 81.97, 100, 75, 95],
    ["CIN-024", "Cinta de papel 24mm", "rollo", 94.26, 115, 86, 109],
  ]);
  const notes = XLSX.utils.aoa_to_sheet([
    ["Condiciones"],
    ["Precios sujetos a cambio sin previo aviso."],
    ["Mayorista: a partir de 10 unidades por artículo. Contado: pago en efectivo."],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Lista");
  XLSX.utils.book_append_sheet(wb, notes, "Condiciones");
  save("precios-multiples.xlsx", wb);
}

// Same supplier format, next month: prices changed, one product added.
{
  const ws = XLSX.utils.aoa_to_sheet([
    ["DISTRIBUIDORA EJEMPLO S.R.L. - LISTA DE PRECIOS DICIEMBRE 2026"],
    ["Precios en pesos uruguayos"],
    [],
    ["Código", "Descripción", "Unidad", "Precio s/IVA", "Precio c/IVA", "Mayorista", "Contado"],
    ["SELLADORES"],
    ["SEL-280", "Silicona transparente 280ml", "unidad", 266.8, 325.5, 241, 309],
    ["SEL-500", "Sellador acrílico 500g", "unidad", 200.82, 245, 185, 233],
    ["PINTURERÍA"],
    ["PIN-023", "Rodillo lana 23cm", "unidad", 372.95, 455, 340, 432],
    ["PIN-002", "Pincel 2 pulgadas", "unidad", 122.95, 150, 112, 142],
    ["LIJ-220", "Lija al agua grano 220", "pliego", 36.07, 44, 33, 42],
    ["ABRASIVOS"],
    ["DIS-115", "Disco de corte 115mm", "unidad", 81.97, 100, 75, 95],
    ["CIN-024", "Cinta de papel 24mm", "rollo", 94.26, 115, 86, 109],
    ["CIN-048", "Cinta de papel 48mm", "rollo", 172.13, 210, 158, 200],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Lista");
  save("precios-multiples-diciembre.xlsx", wb);
}

process.stdout.write(`fixtures written to ${dir.pathname}\n`);
