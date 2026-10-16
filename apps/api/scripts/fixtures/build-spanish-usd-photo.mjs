/**
 * Builds the "photo" of the Spanish October price list in US dollars (phase 16, ADR-035): an SVG of
 * a printed sheet lying on a desk, rendered to JPEG with sharp (a transitive dependency of Next.js, found
 * in the pnpm store; it is not a dependency of the API). Every price says "US$". Fictitious data.
 *
 *   node scripts/fixtures/build-spanish-usd-photo.mjs
 * Output: test/fixtures/extraction/es-usd/lista-octubre-foto.jpg (copied to demo/assets/es/).
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// sharp is only a transitive dependency (Next.js), so find it in the pnpm store.
const store = new URL("../../../../node_modules/.pnpm/", import.meta.url);
const dir = readdirSync(store).find((d) => d.startsWith("sharp@"));
if (!dir) throw new Error("sharp not found in node_modules/.pnpm (run pnpm install)");
const sharp = createRequire(import.meta.url)(
  fileURLToPath(new URL(`${dir}/node_modules/sharp`, store)),
);

const out = new URL("../../test/fixtures/extraction/es-usd/", import.meta.url);
mkdirSync(out, { recursive: true });

const ROWS = [
  ["Tornillo 6mm", "unidad", "US$ 0,35"],
  ["Tuerca 6mm", "unidad", "US$ 0,18"],
  ["Arandela", "unidad", "US$ 0,10"],
  ["Cable 2mm (m)", "metro", "US$ 1,15"],
  ["Lampara LED 9W", "unidad", "US$ 3,25"],
  ["Cemento 25kg", "bolsa", "US$ 10,80"],
];

const rows = ROWS.map(([name, unit, price], i) => {
  const y = 640 + i * 96;
  return `<text x="150" y="${y}" font-size="40">${name}</text>
    <text x="640" y="${y - 12}" font-size="40">${unit}</text>
    <text x="820" y="${y - 24}" font-size="40">${price}</text>
    <line x1="130" y1="${y + 28}" x2="1010" y2="${y + 18}" stroke="#b9b3a8" stroke-width="2"/>`;
}).join("\n    ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500">
  <rect width="1200" height="1500" fill="#5e4f3c"/>
  <g transform="rotate(-2 600 750)">
    <rect x="70" y="120" width="1010" height="1260" fill="#000" opacity="0.35" transform="translate(14 18)"/>
    <rect x="70" y="120" width="1010" height="1260" fill="#f5f2ea"/>
    <g font-family="Arial, Helvetica, sans-serif" fill="#222">
      <text x="110" y="250" font-size="52" font-weight="bold" fill="#1d2b4a">DISTRIBUIDORA DEMO S.A.</text>
      <text x="110" y="320" font-size="32">LISTA DE PRECIOS - OCTUBRE 2026</text>
      <text x="110" y="370" font-size="30">Precios en dólares (US$), IVA incluido</text>
      <line x1="120" y1="410" x2="1000" y2="395" stroke="#222" stroke-width="3"/>
      <text x="140" y="470" font-size="28" font-weight="bold">PRODUCTO</text>
      <text x="630" y="452" font-size="28" font-weight="bold">UNIDAD</text>
      <text x="850" y="440" font-size="28" font-weight="bold">PRECIO</text>
      <line x1="120" y1="490" x2="1000" y2="478" stroke="#222" stroke-width="2"/>
    ${rows}
      <text x="150" y="1290" font-size="28">Solo precios actualizados. Los demás artículos no cambian.</text>
    </g>
  </g>
</svg>`;

const file = new URL("lista-octubre-foto.jpg", out);
const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
writeFileSync(file, jpeg);
process.stdout.write(`${fileURLToPath(file)} (${jpeg.length} bytes)\n`);
