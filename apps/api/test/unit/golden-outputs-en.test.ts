import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fakeContentKey } from "../../src/ai/providers/fake.js";
import { buildCatalogContext } from "../../src/modules/extraction/catalog-context.js";
import {
  applyExtractionRules,
  classificationSchema,
  extractionSchema,
  type ExtractionOutput,
} from "../../src/modules/extraction/extraction.schemas.js";
import {
  buildClassificationContent,
  buildExtractionContent,
  type MessageForAi,
} from "../../src/modules/extraction/message-input.js";
import { convertSpreadsheet } from "../../src/modules/documents/converters/spreadsheet.js";
import { DEFAULT_CONVERSION_LIMITS } from "../../src/modules/documents/document-types.js";
import { getDemoContent } from "../../src/modules/demo/content/index.js";
import { headerCandidates } from "../../src/modules/sheets/sheet-extraction.js";
import { buildMapperContent, buildMatcherContent } from "../../src/modules/sheets/sheet-input.js";
import {
  mapperOutputSchema,
  matcherOutputSchema,
  normalizeMapperTable,
} from "../../src/modules/sheets/sheet-mapping.js";

/**
 * The ENGLISH golden outputs (phase 14 M5d: real Claude responses recorded with
 * `ai:record-golden --lang en`, reviewed by the owner before commit) checked against the ground
 * truth of the English test data (en/expected.json) and against the English demo CONTENT: the
 * seed carries the September list and the approved sheet format as data, so a recording that
 * disagrees with them would make the "Try the system" buttons and the seed tell different stories.
 */

const FIXTURES = new URL("../fixtures/extraction/", import.meta.url);
const EN = new URL("en/", FIXTURES);
const GOLDEN = new URL("golden/", FIXTURES);
const DEMO_GOLDEN = new URL("../../demo/golden/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, EN));
const content = getDemoContent("en");

const EXPECTED = JSON.parse(read("expected.json").toString("utf8")) as {
  september: {
    supplierName: string;
    currency: string;
    taxIncluded: boolean;
    products: { name: string; unit: string; price: string }[];
  };
  photoAgainstSeptember: {
    currency: string;
    taxIncluded: boolean | null;
    listKind: string;
    lines: { catalog: string; newPrice: string; outcome: "price_change" | "review" }[];
    untouched: string[];
  };
};

const base: MessageForAi = {
  messageType: "text",
  text: null,
  transcript: null,
  filename: null,
  mimeType: null,
  media: null,
  contactKind: "supplier",
  supplierName: EXPECTED.september.supplierName,
};

function golden(message: MessageForAi): ExtractionOutput {
  const built = buildExtractionContent(message, null);
  if (!built.ok) throw new Error(built.reason);
  const file = new URL(`extract/${fakeContentKey("extract", built.content)}.json`, GOLDEN);
  if (!existsSync(file)) throw new Error(`missing golden ${file.pathname}`);
  return extractionSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

const september = () =>
  golden({
    ...base,
    messageType: "document",
    mimeType: "application/pdf",
    filename: "price-list-september.pdf",
    media: read("price-list-september.pdf"),
  });
const october = () =>
  golden({
    ...base,
    messageType: "image",
    mimeType: "image/jpeg",
    media: read("price-list-october-photo.jpg"),
  });

describe("English golden outputs (recorded from Claude)", () => {
  it("every English fixture has its classification and extraction golden", () => {
    const text = (partial: Partial<MessageForAi>): MessageForAi => ({ ...base, ...partial });
    const classify = (message: MessageForAi) => {
      const built = buildClassificationContent(message);
      if (!built.ok) throw new Error(built.reason);
      const file = new URL(`classify/${fakeContentKey("classify", built.content)}.json`, GOLDEN);
      expect(existsSync(file), "classify golden").toBe(true);
      return classificationSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    };
    const injection = read("injection-message.txt").toString("utf8").trim();
    const transcript = read("voice-transcript.txt").toString("utf8").trim();
    expect(classify(text({ messageType: "audio", transcript })).classification).toBe(
      "price_update_partial",
    );
    expect(classify(text({ messageType: "text", text: injection })).classification).toBe(
      "price_update_partial",
    );
    expect(
      golden(text({ messageType: "audio", transcript })).items.map((i) => [i.name, i.price]),
    ).toEqual([["Hex bolt 1/4 in", "0.60"]]);
  });

  it("the demo copy of every golden is byte-identical to the test copy", () => {
    for (const task of ["classify", "extract", "map_columns", "match"]) {
      const a = readdirSync(new URL(`${task}/`, GOLDEN)).sort();
      const b = readdirSync(new URL(`${task}/`, DEMO_GOLDEN)).sort();
      expect(b, task).toEqual(a);
      for (const file of a) {
        expect(
          readFileSync(new URL(`${task}/${file}`, DEMO_GOLDEN)).equals(
            readFileSync(new URL(`${task}/${file}`, GOLDEN)),
          ),
          `${task}/${file}`,
        ).toBe(true);
      }
    }
  });

  it("September PDF: 7 products with exact prices, USD, tax included", () => {
    const out = september();
    expect(out).toMatchObject({
      isPriceList: true,
      listKind: "full_list",
      currency: EXPECTED.september.currency,
      taxIncluded: EXPECTED.september.taxIncluded,
      supplierName: EXPECTED.september.supplierName,
      globalChangePct: null,
      suspiciousInstructions: false,
    });
    expect(out.items.map((i) => [i.name, i.unit, i.price, i.priceChangePct])).toEqual(
      EXPECTED.september.products.map((p) => [p.name, p.unit, p.price, null]),
    );
    const ruled = applyExtractionRules(out, new Map(), "en");
    expect(ruled.items.every((i) => i.catalogRef === null && i.matchConfidence === "high")).toBe(
      true,
    );
  });

  it("the September list in the demo content says the same as the recording", () => {
    const out = september();
    expect(out.supplierName).toBe(content.sampleSenders.catalog.supplierName);
    expect(out.fullListEvidence).toContain(content.catalogSender!.evidence);
    expect(out.items.map((i) => [i.name, i.unit, Number(i.price)])).toEqual(
      content.catalogSender!.list,
    );
  });

  it("October photo vs September catalog: 5 automatic price changes, the washer to review, paint untouched", () => {
    const catalog = buildCatalogContext(
      september().items.map((item, i) => ({
        id: `sep-${i}`,
        name: item.name,
        unit: item.unit,
        price: item.price ?? "0",
        currency: "USD",
        available: true,
      })),
    );
    const out = applyExtractionRules(october(), catalog.refNames, "en");
    expect(out).toMatchObject({
      listKind: EXPECTED.photoAgainstSeptember.listKind,
      currency: EXPECTED.photoAgainstSeptember.currency,
      taxIncluded: EXPECTED.photoAgainstSeptember.taxIncluded,
      suspiciousInstructions: false,
    });
    const byCatalogName = new Map(
      out.items.map((item) => [
        item.catalogRef ? catalog.refNames.get(item.catalogRef) : null,
        item,
      ]),
    );
    for (const line of EXPECTED.photoAgainstSeptember.lines) {
      const item = byCatalogName.get(line.catalog);
      expect(item, line.catalog).toBeDefined();
      expect(item?.price, line.catalog).toBe(line.newPrice);
      expect(item?.matchConfidence, line.catalog).toBe(
        line.outcome === "review" ? "medium" : "high",
      );
    }
    expect(out.items).toHaveLength(EXPECTED.photoAgainstSeptember.lines.length);
    for (const name of EXPECTED.photoAgainstSeptember.untouched)
      expect(byCatalogName.has(name), name).toBe(false);
  });

  it("the injection message is flagged and applies nothing but its one legitimate line", () => {
    const out = golden({
      ...base,
      messageType: "text",
      text: read("injection-message.txt").toString("utf8").trim(),
    });
    expect(out.suspiciousInstructions).toBe(true);
    expect(out.items.map((i) => [i.name, i.price])).toEqual([["Hex bolt 1/4 in", "0.60"]]);
  });
});

describe("English golden outputs of the spreadsheet path", () => {
  const SHEETS = new URL("../fixtures/sheets/en/", import.meta.url);
  const goldenOf = (task: string, built: Parameters<typeof fakeContentKey>[1]) =>
    JSON.parse(
      readFileSync(new URL(`${task}/${fakeContentKey(task as never, built)}.json`, GOLDEN), "utf8"),
    ) as unknown;

  const mapped = () => {
    const result = convertSpreadsheet(
      readFileSync(new URL("prices-multiple.xlsx", SHEETS)),
      "xlsx",
      DEFAULT_CONVERSION_LIMITS,
    );
    if (!result.ok) throw new Error(result.reason);
    const indexes = result.tables
      .map((table, index) => ({ table, index }))
      .filter(({ table }) => headerCandidates(table).length > 0);
    return mapperOutputSchema.parse(goldenOf("map_columns", buildMapperContent(indexes)));
  };

  it("mapper: the 4 price columns are found, the mapping is ambiguous, name/header are right", () => {
    const output = mapped();
    const [t1] = output.tables;
    expect(t1).toMatchObject({ table: "T1", isPriceTable: true, headerRow: 3 - 1, nameColumn: 1 });
    const normalized = normalizeMapperTable(t1!, 7);
    expect(normalized.ambiguous).toBe(true);
    expect(normalized.mapping.priceColumn).toBeNull();
    expect(normalized.mapping.priceColumns.map((p) => [p.header, p.taxIncluded])).toEqual([
      ["Price ex tax", false],
      ["Price inc tax", true],
      ["Wholesale", null],
      ["Cash", null],
    ]);
    expect(output.suspiciousInstructions).toBe(false);
    expect(output.supplierName).toBe(content.mapperGoldenSupplierName);
  });

  it("the approved sheet format in the demo content says the same as the recording", () => {
    const [t1] = mapped().tables;
    expect(t1).toMatchObject({
      headerRow: content.knownSender.formatMapper!.headerRow,
      nameColumn: content.knownSender.formatMapper!.nameColumn,
      unitColumn: content.knownSender.formatMapper!.unitColumn,
      skuColumn: content.knownSender.formatMapper!.skuColumn,
      priceColumns: content.knownSender.formatMapper!.priceColumns,
      recommendedPriceColumn: content.knownSender.formatMapper!.recommendedPriceColumn,
      priceFormat: content.knownSender.formatMapper!.priceFormat,
      currency: content.knownSender.formatMapper!.currency,
    });
  });

  it("matcher: December's new product is a confident NEW product (no ref)", () => {
    const built = buildMatcherContent(
      [{ id: "R8", name: "Trimmer line 0.080 in", unit: "spool" }],
      "(catalog is not part of the golden key)",
    );
    expect(matcherOutputSchema.parse(goldenOf("match", built))).toEqual({
      matches: [{ row: "R8", ref: null, confidence: "high" }],
    });
  });
});
