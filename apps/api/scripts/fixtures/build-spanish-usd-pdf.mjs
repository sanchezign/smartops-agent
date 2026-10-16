/**
 * Builds the Spanish September price list of the demo sender in US dollars (phase 16, ADR-035): a
 * 1-page PDF written by hand (standard Helvetica, WinAnsi, no libraries, deterministic bytes).
 * Every price says "US$" (a bare "$" is read as pesos by the extractor prompt). Fictitious data.
 *
 *   node scripts/fixtures/build-spanish-usd-pdf.mjs
 * Output: test/fixtures/extraction/es-usd/lista-septiembre.pdf (copied to demo/assets/es/).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = new URL("../../test/fixtures/extraction/es-usd/", import.meta.url);
mkdirSync(out, { recursive: true });

const ROWS = [
  ["TOR-006", "Tornillo 6mm", "unidad", "0,30"],
  ["TUE-006", "Tuerca 6mm", "unidad", "0,15"],
  ["ARA-006", "Arandela 6mm", "unidad", "0,10"],
  ["CAB-002", "Cable 2mm", "metro", "1,10"],
  ["LED-09W", "Lampara LED 9W", "unidad", "3,00"],
  ["PIN-04L", "Pintura latex blanca 4L", "lata", "46,25"],
  ["CEM-025", "Cemento portland 25kg", "bolsa", "10,50"],
];

// Only backslashes are escaped: the texts below have balanced parentheses, which a PDF string allows. (The
// recorded goldens were made from exactly these bytes, so the output must not change.)
const esc = (text) => text.replaceAll("\\", "\\\\");
const lines = [];
const text = (font, size, x, y, value) =>
  lines.push(`BT /${font} ${size} Tf ${x} ${y} Td (${esc(value)}) Tj ET`);
const rule = (y) => lines.push(`0.5 w 48 ${y} m 564 ${y} l S`);

text("F2", 20, 48, 730, "DISTRIBUIDORA DEMO S.A.");
text(
  "F1",
  10,
  48,
  714,
  "Venta mayorista de ferreteria  |  ventas@distribuidora-demo.example  |  +598 99 400 001",
);
text("F2", 15, 48, 676, "LISTA COMPLETA DE PRECIOS - SEPTIEMBRE 2026");
text(
  "F1",
  10,
  48,
  660,
  "Precios en d\xf3lares estadounidenses (US$). IVA incluido. Vigente hasta la pr\xf3xima lista.",
);
rule(644);
text("F2", 10, 48, 630, "CODIGO");
text("F2", 10, 130, 630, "DESCRIPCION");
text("F2", 10, 380, 630, "UNIDAD");
text("F2", 10, 480, 630, "PRECIO (US$)");
rule(622);
ROWS.forEach(([code, name, unit, price], i) => {
  const y = 604 - i * 22;
  text("F1", 11, 48, y, code);
  text("F1", 11, 130, y, name);
  text("F1", 11, 380, y, unit);
  text("F1", 11, 480, y, `US$ ${price}`);
});
rule(604 - ROWS.length * 22 + 10);
text(
  "F1",
  9,
  48,
  604 - ROWS.length * 22 - 10,
  "Precios sujetos a cambio sin previo aviso. Esta lista reemplaza a la anterior.",
);

const stream = lines.join("\n");
const font = (name) =>
  `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> >>",
  font("Helvetica"),
  font("Helvetica-Bold"),
  `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
];
let pdf = "%PDF-1.4\n";
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf, "latin1"));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf, "latin1");
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const file = new URL("lista-septiembre.pdf", out);
writeFileSync(file, Buffer.from(pdf, "latin1"));
process.stdout.write(`${fileURLToPath(file)} (${pdf.length} bytes)\n`);
