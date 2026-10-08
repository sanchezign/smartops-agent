/**
 * Builds the English September price list of the demo sender (phase 14 M5c): a 1-page PDF written
 * by hand (standard Helvetica, no libraries, deterministic bytes). Fictitious data.
 *
 *   node scripts/fixtures/build-english-pdf.mjs
 * Output: test/fixtures/extraction/en/price-list-september.pdf (copied to demo/assets/en/).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = new URL("../../test/fixtures/extraction/en/", import.meta.url);
mkdirSync(out, { recursive: true });

const ROWS = [
  ["HB-014", "Hex bolt 1/4 in", "each", "0.54"],
  ["HN-014", "Hex nut 1/4 in", "each", "0.22"],
  ["WS-014", "Washer 1/4 in", "each", "0.12"],
  ["WR-14A", "Wire 14 AWG", "ft", "0.45"],
  ["LB-09W", "LED bulb 9 W", "each", "3.20"],
  ["PT-1GW", "Interior latex paint, white 1 gal", "gal", "24.50"],
  ["CM-94L", "Portland cement 94 lb", "bag", "9.40"],
];

const esc = (text) => text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
const lines = [];
const text = (font, size, x, y, value) =>
  lines.push(`BT /${font} ${size} Tf ${x} ${y} Td (${esc(value)}) Tj ET`);
const rule = (y) => lines.push(`0.5 w 48 ${y} m 564 ${y} l S`);

text("F2", 20, 48, 730, "DEMO DISTRIBUTING INC.");
text(
  "F1",
  10,
  48,
  714,
  "Wholesale hardware and supplies  |  sales@demo-distributing.example  |  +1 614 555 0141",
);
text("F2", 15, 48, 676, "FULL PRICE LIST - SEPTEMBER 2026");
text("F1", 10, 48, 660, "Prices in US dollars. Sales tax included. Valid until the next list.");
rule(644);
text("F2", 10, 48, 630, "CODE");
text("F2", 10, 130, 630, "DESCRIPTION");
text("F2", 10, 380, 630, "UNIT");
text("F2", 10, 500, 630, "PRICE");
rule(622);
ROWS.forEach(([code, name, unit, price], i) => {
  const y = 604 - i * 22;
  text("F1", 11, 48, y, code);
  text("F1", 11, 130, y, name);
  text("F1", 11, 380, y, unit);
  text("F1", 11, 500, y, `$ ${price}`);
});
rule(604 - ROWS.length * 22 + 10);
text(
  "F1",
  9,
  48,
  604 - ROWS.length * 22 - 10,
  "Prices are subject to change without notice. This list replaces the previous one.",
);

const stream = lines.join("\n");
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
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

const file = new URL("price-list-september.pdf", out);
writeFileSync(file, Buffer.from(pdf, "latin1"));
process.stdout.write(`${fileURLToPath(file)} (${pdf.length} bytes)\n`);
