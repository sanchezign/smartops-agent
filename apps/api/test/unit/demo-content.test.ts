import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeProductName } from "../../src/modules/catalog/normalize.js";
import {
  DEMO_LANGUAGES,
  getDemoContent,
  type DemoLanguage,
} from "../../src/modules/demo/content/index.js";

/**
 * Every demo content (phase 14 M5a, ADR-031) is COHERENT: the seed only walks it, so a story beat
 * that points at a product that does not exist, a sample file that is missing or a recorded
 * answer that was never recorded would only show up as a broken demo. Runs for every language
 * that exists.
 */
const ASSETS = new URL("../../demo/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const available: DemoLanguage[] = DEMO_LANGUAGES.filter((language) => {
  try {
    getDemoContent(language);
    return true;
  } catch {
    return false;
  }
});

describe.each(available)("demo content: %s", (language) => {
  const content = getDemoContent(language);
  const names = (supplier: (typeof content.suppliers)[number]) =>
    new Set(supplier.products.map((p) => p.name));

  it("is the language it says, with three suppliers that quote in a currency", () => {
    expect(content.language).toBe(language);
    expect(content.suppliers).toHaveLength(3);
    for (const supplier of content.suppliers) {
      expect(supplier.currency, supplier.name).toMatch(/^[A-Z]{3}$/);
      expect(supplier.products.length, supplier.name).toBeGreaterThanOrEqual(10);
      expect(new Set(supplier.products.map((p) => normalizeProductName(p.name))).size).toBe(
        supplier.products.length,
      ); // no two products collapse into the same normalized name
    }
  });

  it("every story beat points at products that exist, in the supplier it belongs to", () => {
    const [first, second, third] = content.suppliers;
    const { story } = content;
    for (const rise of story.increases.rises)
      expect(names(first), rise.product).toContain(rise.product);
    expect(names(first)).toContain(story.increases.alias.product);
    // "P<n>" is the n-th product of the supplier, in the order they are declared
    expect(first.products[Number(story.increases.alias.ref.slice(1)) - 1]!.name).toBe(
      story.increases.alias.product,
    );
    expect(names(second)).toContain(story.globalChange.product);
    expect(names(third)).toContain(story.missingFromList.product);
    expect(names(first)).toContain(story.injection.product);
    // the currency change really changes it, and the new product is new
    expect(story.currencyChange.changed.currency).not.toBe(third.currency);
    expect(names(third)).not.toContain(story.currencyChange.created.name);
  });

  it("customers, the person-handled chat and the opt-out customer line up", () => {
    expect(content.customers[content.humanCustomer]?.kind).toBe("customer");
    expect(content.customers[content.optOutCustomer]?.kind).toBe("customer");
    for (const [who] of content.customerMessages) expect(content.customers[who]).toBeDefined();
    expect(content.customerMessages.some(([, , kind]) => kind === "order")).toBe(true);
    expect(content.customerMessages.some(([, , kind]) => kind === "query")).toBe(true);
  });

  it("phone numbers are unique, and fake", () => {
    const all = [
      ...content.suppliers.map((s) => s.waId),
      ...content.customers.map((c) => c.waId),
      ...Object.values(content.sampleSenders).map((s) => s.waId),
      content.teamWaId,
      ...[0, 1, 2].map((i) => content.e2e.waId(i)),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("every sample file and recorded answer the demo needs is there", () => {
    const dir = join(ASSETS, "assets", content.assetsSubdir);
    for (const [kind, sample] of Object.entries(content.samples)) {
      expect(existsSync(join(dir, sample.file)), `${kind}: ${sample.file}`).toBe(true);
    }
    expect(existsSync(join(dir, content.knownSender.formatFile))).toBe(true);
    const read = (folder: string, key: (j: { supplierName?: string | null }) => boolean) =>
      readdirSync(join(ASSETS, "golden", folder)).some((f) =>
        key(JSON.parse(readFileSync(join(ASSETS, "golden", folder, f), "utf8"))),
      );
    expect(
      read("map_columns", (j) => j.supplierName === content.mapperGoldenSupplierName),
      "recorded column mapping",
    ).toBe(true);
    expect(
      read("extract", (j) => j.supplierName === content.sampleSenders.catalog.supplierName),
      "recorded extraction of the catalog sender",
    ).toBe(true);
  });
});
