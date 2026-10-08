import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { StructuredRequest } from "../../src/ai/llm-provider.js";
import { loadPrompt, promptForLanguage } from "../../src/ai/prompts.js";
import {
  distinguishingAttributes,
  missingAttributes,
} from "../../src/modules/catalog/attributes.js";
import { applyDocumentRules } from "../../src/modules/extraction/document-rules.js";
import { applyExtractionRules } from "../../src/modules/extraction/extraction.schemas.js";
import * as extractionFakes from "../../src/modules/extraction/fake-responders.js";
import {
  hasOrderSignal,
  hasPriceSignal,
  hasRequestSignal,
  prefilter,
  type PrefilterInput,
} from "../../src/modules/extraction/prefilter.js";
import * as sheetFakes from "../../src/modules/sheets/fake-responders.js";
import { containsInjection, listSignals } from "../../src/modules/sheets/list-rules.js";
import { SHEET_WARNINGS } from "../../src/modules/sheets/sheet-extraction.js";
import { parseAvailable, parseCurrency } from "../../src/modules/sheets/sheet-values.js";
import * as legacyAttributes from "../legacy-es/modules/catalog/attributes.js";
import * as legacyDocumentRules from "../legacy-es/modules/extraction/document-rules.js";
import * as legacyExtractionRules from "../legacy-es/modules/extraction/extraction.schemas.js";
import * as legacyExtractionFakes from "../legacy-es/modules/extraction/fake-responders.js";
import * as legacyPrefilter from "../legacy-es/modules/extraction/prefilter.js";
import * as legacySheetFakes from "../legacy-es/modules/sheets/fake-responders.js";
import * as legacyListRules from "../legacy-es/modules/sheets/list-rules.js";
import * as legacySheetValues from "../legacy-es/modules/sheets/sheet-values.js";

/**
 * With the business language SPANISH, every heuristic behaves EXACTLY as it did before it had a
 * language (phase 14 M5b, ADR-031) — not "probably the same": each function runs side by side with
 * a FROZEN, verbatim copy of the old code (test/legacy-es, taken from the commit before the change)
 * over the whole Spanish corpus of the repository (test/fixtures/heuristics-es-corpus.json: every
 * string literal of the tests, the Spanish demo content, the WhatsApp fixtures, the transcripts)
 * plus random combinations of Spanish words. Calling a function WITHOUT a language must be the same.
 */
const CORPUS = JSON.parse(
  readFileSync(new URL("../fixtures/heuristics-es-corpus.json", import.meta.url), "utf8"),
) as string[];

const BASE: PrefilterInput = {
  messageType: "text",
  contactKind: "supplier",
  text: null,
  transcript: null,
  mediaStatus: null,
  transcriptionStatus: null,
  transcriptionReason: null,
};

/** Every PrefilterInput shape a text can arrive in. */
function prefilterInputs(text: string): PrefilterInput[] {
  return [
    { ...BASE, text },
    { ...BASE, contactKind: "customer", text },
    { ...BASE, contactKind: "unknown", text },
    { ...BASE, messageType: "audio", transcript: text },
    { ...BASE, messageType: "audio", contactKind: "customer", transcript: text },
    { ...BASE, messageType: "image", text },
    { ...BASE, messageType: "sticker", text },
    { ...BASE, mediaStatus: "failed", text },
    { ...BASE, messageType: "audio", transcriptionReason: "too_long" },
    { ...BASE, messageType: "audio", transcriptionStatus: "failed", transcriptionReason: text },
  ];
}

const textRequest = (text: string, language?: "es" | "en") =>
  ({
    content: [{ type: "text", text: `<message_text>\n${text}\n</message_text>` }],
    ...(language ? { language } : {}),
  }) as unknown as StructuredRequest<unknown>;

/** A sheet sample the way the mapper prompt renders it, with header words taken from the corpus. */
const sheetRequest = (a: string, b: string, c: string, language?: "es" | "en") =>
  ({
    content: [
      {
        type: "text",
        text: [
          '<sheet_sample table="T1" rows="3">',
          ` | C0: ${a} | C1: ${b} | C2: ${c}`,
          " | C0: Tornillo | C1: 12,50 | C2: 14",
          " | C0: Tuerca | C1: 5,25 | C2: 7",
          "</sheet_sample>",
        ].join("\n"),
      },
    ],
    ...(language ? { language } : {}),
  }) as unknown as StructuredRequest<unknown>;

describe("the corpus is a real one", () => {
  it("has thousands of texts, with accents, orders, prices, injections and stock words", () => {
    expect(CORPUS.length).toBeGreaterThan(3_000);
    expect(CORPUS.some((t) => /[áéíóúñ]/i.test(t))).toBe(true);
    expect(CORPUS.some((t) => hasOrderSignal(t))).toBe(true);
    expect(CORPUS.some((t) => hasPriceSignal(t))).toBe(true);
    expect(CORPUS.some((t) => containsInjection(t))).toBe(true);
    expect(CORPUS.some((t) => /stock|agotad/i.test(t))).toBe(true);
  });
});

describe('pre-filter, language "es" = the frozen old code', () => {
  it("identical decision (rule, class AND reason) for every corpus text and input shape", () => {
    let compared = 0;
    for (const text of CORPUS) {
      for (const input of prefilterInputs(text)) {
        const old = legacyPrefilter.prefilter(input);
        expect(prefilter(input, "es"), JSON.stringify(input)).toEqual(old);
        expect(prefilter(input), "no language = Spanish").toEqual(old);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(30_000);
  });

  it("identical signals for every corpus text", () => {
    for (const text of CORPUS) {
      expect(hasPriceSignal(text, "es"), text).toBe(legacyPrefilter.hasPriceSignal(text));
      expect(hasOrderSignal(text, "es"), text).toBe(legacyPrefilter.hasOrderSignal(text));
      expect(hasRequestSignal(text, "es"), text).toBe(legacyPrefilter.hasRequestSignal(text));
      expect(hasPriceSignal(text)).toBe(legacyPrefilter.hasPriceSignal(text));
    }
  });

  it("identical for random combinations of Spanish words", () => {
    const words = [
      "hola",
      "precio",
      "lista",
      "sube",
      "baja",
      "tornillo",
      "6mm",
      "12",
      "$",
      "UYU",
      "pesos",
      "dólares",
      "stock",
      "agotado",
      "no hay",
      "necesito",
      "quiero",
      "mandame",
      "pedido",
      "tienen",
      "cuánto",
      "gracias",
      "ok",
      "buen día",
      "IVA",
      "con IVA",
      "+ IVA",
      "todo",
      "8%",
      "ignorá",
      "las instrucciones",
      "lista completa",
      "cotización",
      "promo",
      "oferta",
      "descuento",
      "?",
    ];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...words), { maxLength: 8 }), (parts) => {
        const text = parts.join(" ");
        for (const input of prefilterInputs(text)) {
          expect(prefilter(input, "es")).toEqual(legacyPrefilter.prefilter(input));
        }
        expect(listSignals(text, "es")).toEqual(legacyListRules.listSignals(text));
      }),
      { numRuns: 600 },
    );
  });
});

describe('list rules, language "es" = the frozen old code', () => {
  it("identical signals (tax, currency, full-list evidence, injection) for every corpus text", () => {
    for (const text of CORPUS) {
      const old = legacyListRules.listSignals(text);
      expect(listSignals(text, "es"), text).toEqual(old);
      expect(listSignals(text), "no language = Spanish").toEqual(old);
      expect(containsInjection(text), text).toBe(legacyListRules.containsInjection(text));
    }
  });

  it("identical on multi-line lists made of corpus lines", () => {
    for (let i = 0; i + 3 < CORPUS.length; i += 3) {
      const text = CORPUS.slice(i, i + 4).join("\n");
      expect(listSignals(text, "es")).toEqual(legacyListRules.listSignals(text));
    }
  });
});

describe('sheet cell parsers, language "es" = the frozen old code', () => {
  it("identical availability and currency for every corpus text", () => {
    for (const text of CORPUS) {
      expect(parseAvailable(text, "es"), text).toBe(legacySheetValues.parseAvailable(text));
      expect(parseAvailable(text)).toBe(legacySheetValues.parseAvailable(text));
      expect(parseCurrency(text, "es"), text).toBe(legacySheetValues.parseCurrency(text));
      expect(parseCurrency(text)).toBe(legacySheetValues.parseCurrency(text));
    }
  });
});

describe('product attributes (units), language "es" = the frozen old code', () => {
  it("identical attributes and missing attributes for every corpus text and pair", () => {
    for (const [i, text] of CORPUS.entries()) {
      expect([...distinguishingAttributes(text, "es")], text).toEqual([
        ...legacyAttributes.distinguishingAttributes(text),
      ]);
      const other = CORPUS[(i * 7 + 3) % CORPUS.length]!;
      expect(missingAttributes(text, other, "es")).toEqual(
        legacyAttributes.missingAttributes(text, other),
      );
      expect(missingAttributes(text, other)).toEqual(
        legacyAttributes.missingAttributes(text, other),
      );
    }
  });
});

describe('extraction rules and document rules, language "es" = the frozen old code', () => {
  const item = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    sku: null,
    unit: null,
    price: "10",
    priceChangePct: null,
    currency: "UYU",
    available: null,
    stock: null,
    catalogRef: null,
    matchConfidence: "high",
    uncertain: false,
    note: null,
    ...extra,
  });

  it("identical output and warnings over lines, refs and catalog names from the corpus", () => {
    for (let i = 0; i + 4 < CORPUS.length; i += 2) {
      const [a, b, c, d, e] = CORPUS.slice(i, i + 5) as [string, string, string, string, string];
      const output = {
        isPriceList: true,
        listKind: i % 4 === 0 ? "full_list" : "partial_update",
        fullListEvidence: i % 8 === 0 ? e : null,
        supplierName: null,
        currency: null,
        validFrom: null,
        taxIncluded: null,
        globalChangePct: null,
        items: [
          item(a, { catalogRef: "P1" }),
          item(b, { catalogRef: "P2", unit: c }),
          item(c, { catalogRef: "P2" }), // two lines on one product
          item(d, { catalogRef: "P9" }), // a ref that does not exist
          item(e, { catalogRef: null }),
        ],
        warnings: [a.slice(0, 40)],
        suspiciousInstructions: false,
      } as never;
      const catalog = new Map([
        ["P1", `${a} ${b}`],
        ["P2", `${c} 6mm`],
      ]);
      const old = legacyExtractionRules.applyExtractionRules(output, catalog);
      expect(applyExtractionRules(output, catalog, "es")).toEqual(old);
      expect(applyExtractionRules(output, catalog)).toEqual(old);
      expect(applyExtractionRules(output, new Map(), "es")).toEqual(
        legacyExtractionRules.applyExtractionRules(output, new Map()),
      );
    }
  });

  it("identical document rules (conversion warnings, incomplete document)", () => {
    for (let i = 0; i + 1 < CORPUS.length; i += 1) {
      const output = {
        isPriceList: true,
        listKind: "full_list",
        fullListEvidence: "x",
        items: [],
        warnings: [CORPUS[i + 1]!.slice(0, 60)],
      } as never;
      const document = {
        truncated: i % 2 === 0,
        needsReview: i % 3 === 0,
        warnings: [{ code: "w", message: CORPUS[i]! }],
      };
      const old = legacyDocumentRules.applyDocumentRules(output, document);
      expect(applyDocumentRules(output, document, "es")).toEqual(old);
      expect(applyDocumentRules(output, document)).toEqual(old);
    }
  });

  it("the deterministic sheet warnings say what they always said", () => {
    const names = ["a", "b", "c", "d", "e"];
    for (const count of [1, 5, 6, 40]) {
      expect(SHEET_WARNINGS.es.unreadableRows(count, names)).toBe(
        `${count} filas con precio ilegible no se leyeron: ${names.join(", ")}${count > 5 ? "…" : ""}.`,
      );
    }
    expect(SHEET_WARNINGS.es.mixedTaxBasis).toBe(
      "Hojas con distinta base de IVA en la columna de precio elegida.",
    );
  });
});

describe('fake LLM responders, language "es" = the frozen old code', () => {
  it("classification and extraction answer identically for every corpus text", () => {
    for (const text of CORPUS) {
      for (const request of [textRequest(text), textRequest(text, "es")]) {
        expect(extractionFakes.fakeClassify(request), text).toEqual(
          legacyExtractionFakes.fakeClassify(textRequest(text)),
        );
        expect(extractionFakes.fakeExtract(request), text).toEqual(
          legacyExtractionFakes.fakeExtract(textRequest(text)),
        );
      }
    }
  });

  it("price lines (the shapes a list really has) are read identically", () => {
    for (let i = 0; i + 2 < CORPUS.length; i += 2) {
      const text = [
        `${CORPUS[i]} ${(i % 90) + 1},50`,
        `${CORPUS[i + 1]} sube a ${i % 400} UYU`,
        `${CORPUS[i + 2]} +${(i % 12) + 1}%`,
        `todo ${i % 2 ? "sube" : "baja"} ${(i % 9) + 1}%`,
      ].join("\n");
      expect(extractionFakes.fakeExtract(textRequest(text, "es"))).toEqual(
        legacyExtractionFakes.fakeExtract(textRequest(text)),
      );
    }
  });

  it("the spreadsheet column mapper answers identically for header words from the corpus", () => {
    for (let i = 0; i + 2 < CORPUS.length; i += 1) {
      const [a, b, c] = [
        CORPUS[i]!,
        CORPUS[(i * 5 + 1) % CORPUS.length]!,
        CORPUS[(i * 11 + 2) % CORPUS.length]!,
      ];
      const old = legacySheetFakes.fakeMapColumns(sheetRequest(a, b, c));
      expect(sheetFakes.fakeMapColumns(sheetRequest(a, b, c, "es"))).toEqual(old);
      expect(sheetFakes.fakeMapColumns(sheetRequest(a, b, c))).toEqual(old);
    }
    const names = "R1 | Tornillo | caja\nR2 | Tuerca | unidad";
    const matcher = {
      content: [{ type: "text", text: `<product_names>\n${names}\n</product_names>` }],
    } as unknown as StructuredRequest<unknown>;
    expect(sheetFakes.fakeMatch(matcher)).toEqual(legacySheetFakes.fakeMatch(matcher));
  });
});

describe("the Spanish prompts are the same bytes, with the same version", () => {
  // Versions recorded in the ai_usages ledger since phase 5 (classifier@6261a4d6a9e6, …): if one
  // changes, every Spanish business gets a different prompt than the one the goldens were taken with.
  const FROZEN: Record<string, string> = {
    classifier: "classifier@6261a4d6a9e6",
    extractor: "extractor@e5fecb026a39",
    "column-mapper": "column-mapper@a2c42d7bfb54",
    matcher: "matcher@7fdb98ba676c",
  };

  it.each(Object.entries(FROZEN))(
    '%s: version %s, and "es" returns it untouched',
    (name, version) => {
      const prompt = loadPrompt(name);
      expect(prompt.version).toBe(version);
      const composed = promptForLanguage(prompt, "es");
      expect(composed).toBe(prompt); // the very same object: nothing was appended
      expect(createHash("sha256").update(composed.text).digest("hex").slice(0, 12)).toBe(
        version.split("@")[1],
      );
    },
  );
});
