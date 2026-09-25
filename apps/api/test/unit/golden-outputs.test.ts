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
  buildExtractionContent,
  type MessageForAi,
} from "../../src/modules/extraction/message-input.js";

/**
 * Golden outputs (real Claude responses recorded by `ai:record-golden`, reviewed before
 * commit) checked against the ground truth of the test data (expected.json). They are
 * what the fake provider returns in dev/CI/demo, so a bad golden would silently teach
 * the e2e tests a wrong answer.
 */

const FIXTURES = new URL("../fixtures/extraction/", import.meta.url);
const GOLDEN = new URL("golden/", FIXTURES);
const read = (name: string) => readFileSync(new URL(name, FIXTURES));

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
  const content = buildExtractionContent(message, null);
  if (!content.ok) throw new Error(content.reason);
  const file = new URL(`extract/${fakeContentKey("extract", content.content)}.json`, GOLDEN);
  if (!existsSync(file)) throw new Error(`missing golden ${file.pathname}`);
  return extractionSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

const september = () =>
  golden({
    ...base,
    messageType: "document",
    mimeType: "application/pdf",
    filename: "lista-prueba.pdf",
    media: read("lista-prueba.pdf"),
  });
const october = () =>
  golden({
    ...base,
    messageType: "image",
    mimeType: "image/jpeg",
    media: read("lista-precios-foto.jpg"),
  });

describe("golden outputs (recorded from Claude)", () => {
  it("every golden file passes the output schema of its task", () => {
    const schemas = { classify: classificationSchema, extract: extractionSchema };
    let count = 0;
    for (const [task, schema] of Object.entries(schemas)) {
      for (const file of readdirSync(new URL(`${task}/`, GOLDEN))) {
        const data: unknown = JSON.parse(readFileSync(new URL(`${task}/${file}`, GOLDEN), "utf8"));
        expect(schema.safeParse(data).success, `${task}/${file}`).toBe(true);
        count += 1;
      }
    }
    expect(count).toBe(7);
  });

  it("September PDF: 7 products with exact prices, UYU, VAT included", () => {
    const out = september();
    expect(out).toMatchObject({
      isPriceList: true,
      currency: EXPECTED.september.currency,
      taxIncluded: EXPECTED.september.taxIncluded,
      supplierName: EXPECTED.september.supplierName,
      globalChangePct: null,
      suspiciousInstructions: false,
    });
    expect(out.items.map((i) => [i.name, i.unit, i.price, i.priceChangePct])).toEqual(
      EXPECTED.september.products.map((p) => [p.name, p.unit, p.price, null]),
    );
    // First list of the supplier (empty catalog): all new products after the rules.
    const ruled = applyExtractionRules(out, new Map());
    expect(ruled.items.every((i) => i.catalogRef === null && i.matchConfidence === "high")).toBe(
      true,
    );
  });

  it("October photo vs September catalog: 5 automatic price changes, the washer to review, paint untouched", () => {
    const catalog = buildCatalogContext(
      september().items.map((item, i) => ({
        id: `sep-${i}`,
        name: item.name,
        unit: item.unit,
        price: item.price ?? "0",
        currency: "UYU",
        available: true,
      })),
    );
    const out = applyExtractionRules(october(), catalog.refNames);
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
});
