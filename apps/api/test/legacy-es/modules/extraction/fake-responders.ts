/* FROZEN COPY of apps/api/src/modules/extraction/fake-responders.ts as of commit c4d2f42 (phase 14 M5b, BEFORE the heuristics got a language).
 * It is the reference of what the Spanish behavior WAS: test/unit/heuristics-es-identical.test.ts compares
 * today's code, with the language set to "es", against it. Never edit it. */
import type { StructuredRequest } from "../../../../src/ai/llm-provider.js";
import type { FakeResponder } from "../../../../src/ai/providers/fake.js";
import { fakeMapColumns, fakeMatch } from "../sheets/fake-responders.js";
import type { ClassificationOutput, ExtractionOutput } from "./extraction.schemas.js";

/**
 * Heuristics for the fake LLM (dev, tests, keyless demo) when no golden output exists.
 * Deliberately simple and conservative; real understanding comes from Claude.
 */

function textOf(request: StructuredRequest<unknown>): string {
  return request.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function untrusted(text: string): string {
  const parts = [
    ...text.matchAll(
      /<(message_text|voice_transcript|caption|document_text)>\n([\s\S]*?)\n<\/\1>/g,
    ),
  ];
  return parts.map((m) => m[2] ?? "").join("\n");
}

export const fakeClassify: FakeResponder = (request) => {
  const text = untrusted(textOf(request)).toLowerCase();
  const out = (
    classification: ClassificationOutput["classification"],
    confidence: number,
    reason: string,
  ) => ({
    classification,
    confidence,
    reason,
  });
  if (/\?|cu[aá]nto (sale|cuesta)|tienen|hay stock/.test(text))
    return out("customer_query", 0.7, "Pregunta de precio o stock (heurística).");
  if (/pedido|mand[aá]me|necesito \d/.test(text))
    return out("internal_order", 0.65, "Parece un pedido (heurística).");
  if (/lista completa|lista de precios vigente/.test(text))
    return out("price_list_full", 0.7, "Menciona lista completa (heurística).");
  if (/\d+([.,]\d+)?\s*(uyu|usd|ars|pesos|\$)|\$\s*\d|\d\s*%|precio|sube|baja/.test(text)) {
    return out("price_update_partial", 0.7, "Contiene precios (heurística).");
  }
  return out("other", 0.5, "Sin señales de precios (heurística).");
};

const LINE =
  /^\s*[-•*]?\s*(.+?)[\s.:]*\$?\s*(\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(uyu|usd|ars|pesos)?\s*[.!;]?\s*$/i;

/** "el cable sube 10%", "tuerca -5 %", "todo +8%": a percentage change, never a price. */
const PCT_LINE =
  /^\s*[-•*]?\s*(.+?)\s+(?:(sube|suben|aumenta|aumentan)|(baja|bajan))?\s*([+-])?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*%/i;
const ALL_PRODUCTS = /^(todo|todos|toda la lista|todos los productos|la lista)$/i;

export const fakeExtract: FakeResponder = (request) => {
  const text = untrusted(textOf(request));
  const items: ExtractionOutput["items"] = [];
  let globalChangePct: string | null = null;
  for (const raw of text.split(/\n|,(?=\s*[a-záéíóúñ])/i)) {
    const pct = PCT_LINE.exec(raw);
    if (pct?.[1] && pct[5] && (pct[2] || pct[3] || pct[4])) {
      const negative = Boolean(pct[3]) || pct[4] === "-";
      const value = `${negative ? "-" : ""}${pct[5].replace(",", ".")}`;
      const name = pct[1].trim();
      if (Number(value) === 0) continue;
      if (ALL_PRODUCTS.test(name)) {
        globalChangePct = value;
        continue;
      }
      items.push({
        name,
        sku: null,
        unit: null,
        price: null,
        priceChangePct: value,
        currency: null,
        available: null,
        stock: null,
        catalogRef: null,
        matchConfidence: "low",
        uncertain: true,
        note: "Extraído con heurística (proveedor fake).",
      });
      continue;
    }
    const match = LINE.exec(raw);
    if (!match?.[1] || !match[2]) continue;
    const name = match[1].replace(/\s*(sube a|a|:)\s*$/i, "").trim();
    let price = match[2].replace(/\s/g, "");
    price = /,\d{1,2}$/.test(price)
      ? price.replace(/\./g, "").replace(",", ".")
      : price.replace(/[.,](?=\d{3}\b)/g, "");
    if (!name || Number(price) <= 0) continue;
    const currency = match[3]?.toLowerCase();
    items.push({
      name,
      sku: null,
      unit: null,
      price,
      priceChangePct: null,
      currency: currency === "usd" ? "USD" : currency === "ars" ? "ARS" : currency ? "UYU" : null,
      available: null,
      stock: null,
      catalogRef: null,
      matchConfidence: "low",
      uncertain: true,
      note: "Extraído con heurística (proveedor fake).",
    });
  }
  const out: ExtractionOutput = {
    isPriceList: items.length > 0 || globalChangePct !== null,
    listKind: "partial_update",
    fullListEvidence: null,
    supplierName: null,
    currency: null,
    validFrom: null,
    taxIncluded: /iva inclu[ií]do|con iva/i.test(text)
      ? true
      : /\+\s*iva|m[aá]s iva|sin iva|iva no inclu[ií]do/i.test(text)
        ? false
        : null,
    globalChangePct,
    items,
    warnings: ["Extracción heurística del proveedor fake: revisar antes de aplicar."],
    suspiciousInstructions: /ignor[aá]\s+(las|todas)|ignore (all|the) previous/i.test(text),
  };
  return out;
};

export const FAKE_RESPONDERS = {
  classify: fakeClassify,
  extract: fakeExtract,
  map_columns: fakeMapColumns,
  match: fakeMatch,
} as const;
