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
    ["SEGURIDAD"],
    ["CAN-040", "Candado bronce 40mm", "unidad", 254.51, 310.5, 230, 295],
    ["CER-001", "Cerradura de embutir", "unidad", 200.82, 245, 185, 233],
    ["HERRAJES"],
    ["BIS-003", "Bisagra 3 pulgadas", "unidad", 372.95, 455, 340, 432],
    ["TAR-008", "Tarugo 8mm x100", "caja", 118.03, 144, 108, 137],
    ["PEG-250", "Pegamento de contacto 250ml", "lata", 36.07, 44, 33, 42],
    ["ELECTRICIDAD"],
    ["CIN-020", "Cinta aisladora 20m", "rollo", 81.97, 100, 75, 95],
    ["GUA-00M", "Guante de nitrilo talle M", "par", 94.26, 115, 86, 109],
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
    ["SEGURIDAD"],
    ["CAN-040", "Candado bronce 40mm", "unidad", 266.8, 325.5, 241, 309],
    ["CER-001", "Cerradura de embutir", "unidad", 200.82, 245, 185, 233],
    ["HERRAJES"],
    ["BIS-003", "Bisagra 3 pulgadas", "unidad", 372.95, 455, 340, 432],
    ["TAR-008", "Tarugo 8mm x100", "caja", 122.95, 150, 112, 142],
    ["PEG-250", "Pegamento de contacto 250ml", "lata", 36.07, 44, 33, 42],
    ["ELECTRICIDAD"],
    ["CIN-020", "Cinta aisladora 20m", "rollo", 81.97, 100, 75, 95],
    ["GUA-00M", "Guante de nitrilo talle M", "par", 94.26, 115, 86, 109],
    ["TAN-002", "Tanza para bordeadora 2mm", "rollo", 172.13, 210, 158, 200],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Lista");
  save("precios-multiples-diciembre.xlsx", wb);
}

process.stdout.write(`fixtures written to ${dir.pathname}\n`);
