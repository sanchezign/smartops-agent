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

// ─── English twins (phase 14 M5c): US customary units, US dollars, "tax" instead of VAT ───
const enDir = new URL("../../test/fixtures/sheets/en/", import.meta.url);
mkdirSync(enDir, { recursive: true });
function saveEn(name: string, wb: XLSX.WorkBook) {
  wb.Props = { CreatedDate: FIXED_DATE, ModifiedDate: FIXED_DATE, Author: "SmartOps fixtures" };
  writeFileSync(new URL(name, enDir), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
const EN_HEADER = [
  "Code",
  "Description",
  "Unit",
  "Price ex tax",
  "Price inc tax",
  "Wholesale",
  "Cash",
];
{
  const ws = XLSX.utils.aoa_to_sheet([
    ["EXAMPLE SUPPLY LLC - PRICE LIST NOVEMBER 2026"],
    ["Prices in US dollars"],
    [],
    EN_HEADER,
    ["SECURITY"],
    ["PAD-150", "Brass padlock 1-1/2 in", "each", 11.0, 11.8, 10.4, 11.25],
    ["MLK-001", "Mortise lockset", "each", 13.61, 14.6, 12.9, 13.9],
    ["HARDWARE"],
    ["HNG-003", "Door hinge 3 in", "pair", 4.85, 5.2, 4.6, 4.95],
    ["ANC-516", "Wall anchor 5/16 in (bag of 100)", "bag", 6.43, 6.9, 6.1, 6.55],
    ["WGL-008", "Wood glue 8 oz", "can", 4.1, 4.4, 3.9, 4.2],
    ["ELECTRICAL"],
    ["TAP-075", "Electrical tape 3/4 in", "roll", 2.89, 3.1, 2.75, 2.95],
    ["GLV-00M", "Nitrile gloves, size M", "pair", 1.68, 1.8, 1.6, 1.72],
  ]);
  const notes = XLSX.utils.aoa_to_sheet([
    ["Terms"],
    ["Prices subject to change without notice."],
    ["Wholesale: from 10 units per item. Cash: payment in cash."],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Price list");
  XLSX.utils.book_append_sheet(wb, notes, "Terms");
  saveEn("prices-multiple.xlsx", wb);
}
{
  const ws = XLSX.utils.aoa_to_sheet([
    ["EXAMPLE SUPPLY LLC - PRICE LIST DECEMBER 2026"],
    ["Prices in US dollars"],
    [],
    EN_HEADER,
    ["SECURITY"],
    ["PAD-150", "Brass padlock 1-1/2 in", "each", 11.33, 12.15, 10.7, 11.55],
    ["MLK-001", "Mortise lockset", "each", 13.61, 14.6, 12.9, 13.9],
    ["HARDWARE"],
    ["HNG-003", "Door hinge 3 in", "pair", 4.85, 5.2, 4.6, 4.95],
    ["ANC-516", "Wall anchor 5/16 in (bag of 100)", "bag", 6.57, 7.05, 6.2, 6.7],
    ["WGL-008", "Wood glue 8 oz", "can", 4.1, 4.4, 3.9, 4.2],
    ["ELECTRICAL"],
    ["TAP-075", "Electrical tape 3/4 in", "roll", 2.89, 3.1, 2.75, 2.95],
    ["GLV-00M", "Nitrile gloves, size M", "pair", 1.68, 1.8, 1.6, 1.72],
    ["TRL-080", "Trimmer line 0.080 in", "spool", 4.94, 5.3, 4.7, 5.05],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Price list");
  saveEn("prices-multiple-december.xlsx", wb);
}

process.stdout.write(`fixtures written to ${dir.pathname}\n`);
