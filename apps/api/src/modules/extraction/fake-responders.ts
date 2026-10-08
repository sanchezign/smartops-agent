import type { StructuredRequest } from "../../ai/llm-provider.js";
import type { BusinessLanguage } from "../../common/business-texts.js";
import type { FakeResponder } from "../../ai/providers/fake.js";
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

/** The words of each language; "es" is exactly what the fake always did (frozen-copy test). */
interface FakeWords {
  question: RegExp;
  order: RegExp;
  fullList: RegExp;
  prices: RegExp;
  line: RegExp;
  pctLine: RegExp;
  allProducts: RegExp;
  splitter: RegExp;
  /** What a name must not end with ("sube a", "goes up to"). */
  trailer: RegExp;
  taxTrue: RegExp;
  taxFalse: RegExp;
  decimal: "comma" | "dot";
  texts: {
    question: string;
    order: string;
    fullList: string;
    prices: string;
    nothing: string;
    note: string;
    warning: string;
  };
}

const FAKE_WORDS: Record<BusinessLanguage, FakeWords> = {
  es: {
    question: /\?|cu[aá]nto (sale|cuesta)|tienen|hay stock/,
    order: /pedido|mand[aá]me|necesito \d/,
    fullList: /lista completa|lista de precios vigente/,
    prices: /\d+([.,]\d+)?\s*(uyu|usd|ars|pesos|\$)|\$\s*\d|\d\s*%|precio|sube|baja/,
    line: /^\s*[-•*]?\s*(.+?)[\s.:]*\$?\s*(\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(uyu|usd|ars|pesos)?\s*[.!;]?\s*$/i,
    // "el cable sube 10%", "tuerca -5 %", "todo +8%": a percentage change, never a price.
    pctLine:
      /^\s*[-•*]?\s*(.+?)\s+(?:(sube|suben|aumenta|aumentan)|(baja|bajan))?\s*([+-])?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*%/i,
    allProducts: /^(todo|todos|toda la lista|todos los productos|la lista)$/i,
    splitter: /\n|,(?=\s*[a-záéíóúñ])/i,
    trailer: /\s*(sube a|a|:)\s*$/i,
    taxTrue: /iva inclu[ií]do|con iva/i,
    taxFalse: /\+\s*iva|m[aá]s iva|sin iva|iva no inclu[ií]do/i,
    decimal: "comma",
    texts: {
      question: "Pregunta de precio o stock (heurística).",
      order: "Parece un pedido (heurística).",
      fullList: "Menciona lista completa (heurística).",
      prices: "Contiene precios (heurística).",
      nothing: "Sin señales de precios (heurística).",
      note: "Extraído con heurística (proveedor fake).",
      warning: "Extracción heurística del proveedor fake: revisar antes de aplicar.",
    },
  },
  en: {
    question: /\?|how much|what(?:'s| is) the price|do you (?:have|carry)|in stock/,
    order: /order|send me|i need \d|i['’]d like/,
    fullList: /(?:full|complete|current) (?:price )?list/,
    prices:
      /\d+(?:[.,]\d+)?\s*(?:usd|cad|dollars?|\$)|\$\s*\d|\d\s*%|price|goes up|going up|go up|drops?/,
    line: /^\s*[-•*]?\s*(.+?)[\s.:]*\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(usd|cad|dollars?)?\s*[.!;]?\s*$/i,
    // "wire goes up 10%", "nut -5 %", "everything +8%": a percentage change, never a price.
    pctLine:
      /^\s*[-•*]?\s*(.+?)\s+(?:(goes up|go up|up|increases?|raised?)|(goes down|go down|down|drops?|decreases?))?\s*([+-])?\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i,
    allProducts: /^(everything|all|all products|the whole list|the list)$/i,
    splitter: /\n|,(?=\s*[a-z])/i,
    trailer: /\s*(goes up to|go up to|up to|to|at|:)\s*$/i,
    taxTrue: /tax(?:es)? (?:is |are )?included|incl(?:uding|\.)? (?:sales )?tax/i,
    taxFalse:
      /\+\s*(?:sales\s*)?tax|plus (?:sales )?tax|(?:before|excl(?:uding|\.)?|without) (?:sales )?tax/i,
    decimal: "dot",
    texts: {
      question: "Price or stock question (heuristic).",
      order: "Looks like an order (heuristic).",
      fullList: "Mentions a full list (heuristic).",
      prices: "Contains prices (heuristic).",
      nothing: "No price signals (heuristic).",
      note: "Extracted with a heuristic (fake provider).",
      warning: "Heuristic extraction by the fake provider: review before applying.",
    },
  },
};

// A defense, so NOT per language: the fake flags an injection attempt the same way everywhere.
const FAKE_INJECTION = /ignor[aá]\s+(las|todas)|ignore (all|the) previous/i;

export const fakeClassify: FakeResponder = (request) => {
  const words = FAKE_WORDS[request.language ?? "es"];
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
  if (words.question.test(text)) return out("customer_query", 0.7, words.texts.question);
  if (words.order.test(text)) return out("internal_order", 0.65, words.texts.order);
  if (words.fullList.test(text)) return out("price_list_full", 0.7, words.texts.fullList);
  if (words.prices.test(text)) {
    return out("price_update_partial", 0.7, words.texts.prices);
  }
  return out("other", 0.5, words.texts.nothing);
};

export const fakeExtract: FakeResponder = (request) => {
  const language = request.language ?? "es";
  const words = FAKE_WORDS[language];
  const text = untrusted(textOf(request));
  const items: ExtractionOutput["items"] = [];
  let globalChangePct: string | null = null;
  for (const raw of text.split(words.splitter)) {
    const pct = words.pctLine.exec(raw);
    if (pct?.[1] && pct[5] && (pct[2] || pct[3] || pct[4])) {
      const negative = Boolean(pct[3]) || pct[4] === "-";
      const value = `${negative ? "-" : ""}${pct[5].replace(",", ".")}`;
      const name = pct[1].trim();
      if (Number(value) === 0) continue;
      if (words.allProducts.test(name)) {
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
        note: words.texts.note,
      });
      continue;
    }
    const match = words.line.exec(raw);
    if (!match?.[1] || !match[2]) continue;
    const name = match[1].replace(words.trailer, "").trim();
    let price = match[2].replace(/\s/g, "");
    if (words.decimal === "comma") {
      price = /,\d{1,2}$/.test(price)
        ? price.replace(/\./g, "").replace(",", ".")
        : price.replace(/[.,](?=\d{3}\b)/g, "");
    } else {
      price = price.replace(/,/g, "");
    }
    if (!name || Number(price) <= 0) continue;
    const currency = match[3]?.toLowerCase();
    items.push({
      name,
      sku: null,
      unit: null,
      price,
      priceChangePct: null,
      currency:
        language === "es"
          ? currency === "usd"
            ? "USD"
            : currency === "ars"
              ? "ARS"
              : currency
                ? "UYU"
                : null
          : currency === "cad"
            ? "CAD"
            : currency
              ? "USD"
              : null,
      available: null,
      stock: null,
      catalogRef: null,
      matchConfidence: "low",
      uncertain: true,
      note: words.texts.note,
    });
  }
  const out: ExtractionOutput = {
    isPriceList: items.length > 0 || globalChangePct !== null,
    listKind: "partial_update",
    fullListEvidence: null,
    supplierName: null,
    currency: null,
    validFrom: null,
    taxIncluded: words.taxTrue.test(text) ? true : words.taxFalse.test(text) ? false : null,
    globalChangePct,
    items,
    warnings: [words.texts.warning],
    suspiciousInstructions: FAKE_INJECTION.test(text),
  };
  return out;
};

export const FAKE_RESPONDERS = {
  classify: fakeClassify,
  extract: fakeExtract,
  map_columns: fakeMapColumns,
  match: fakeMatch,
} as const;
