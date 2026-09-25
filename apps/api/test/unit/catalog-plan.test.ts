import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fakeContentKey } from "../../src/ai/providers/fake.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import {
  planIngestion,
  primaryKind,
  type CatalogProductState,
  type IngestionPlan,
  type PlanInput,
} from "../../src/modules/catalog/ingest-plan.js";
import { normalizeProductName } from "../../src/modules/catalog/normalize.js";
import { applyPercentage } from "../../src/modules/catalog/price-math.js";
import { normalizeSupplierName } from "../../src/modules/catalog/supplier-name.js";
import { buildCatalogContext } from "../../src/modules/extraction/catalog-context.js";
import {
  applyExtractionRules,
  extractionSchema,
  type ExtractedItem,
  type ExtractionOutput,
} from "../../src/modules/extraction/extraction.schemas.js";
import { buildExtractionContent } from "../../src/modules/extraction/message-input.js";
import {
  catalogSettings,
  DEFAULT_CATALOG_SETTINGS,
  resolveSettings,
} from "../../src/modules/settings/settings.schemas.js";

const D = (v: string | number) => new Prisma.Decimal(v);
const NOW = new Date("2026-10-01T12:00:00Z");

const item = (overrides: Partial<ExtractedItem> = {}): ExtractedItem => ({
  name: "Silicona 280ml",
  sku: null,
  unit: null,
  price: "300",
  priceChangePct: null,
  currency: null,
  available: null,
  stock: null,
  catalogRef: null,
  matchConfidence: "high",
  uncertain: false,
  note: null,
  ...overrides,
});

const output = (overrides: Partial<ExtractionOutput> = {}): ExtractionOutput => ({
  isPriceList: true,
  listKind: "partial_update",
  fullListEvidence: null,
  supplierName: null,
  currency: "UYU",
  validFrom: null,
  taxIncluded: null,
  globalChangePct: null,
  items: [item()],
  warnings: [],
  suspiciousInstructions: false,
  ...overrides,
});

let seq = 0;
const product = (
  name: string,
  price: string,
  overrides: Partial<CatalogProductState> = {},
): CatalogProductState => ({
  id: `p-${++seq}`,
  name,
  normalizedName: normalizeProductName(name),
  unit: null,
  price: D(price),
  currency: "UYU",
  available: true,
  stock: null,
  priceSourceAt: null,
  ...overrides,
});

function plan(overrides: Partial<PlanInput> = {}): IngestionPlan {
  return planIngestion({
    output: output(),
    refs: {},
    catalogTruncated: false,
    catalog: [],
    settings: DEFAULT_CATALOG_SETTINGS,
    supplierTaxIncluded: null,
    messageAt: NOW,
    ...overrides,
  });
}

function ungated(p: IngestionPlan) {
  if (p.gated) throw new Error("expected an ungated plan");
  return p;
}

describe("percentage arithmetic (Decimal)", () => {
  it.each([
    ["12.5", "7.5", "13.44"],
    ["0.035", "10", "0.0385"],
    ["12", "10", "13.2"],
    ["1850", "8", "1998"],
    ["13.44", "10", "14.78"],
    ["100", "-5", "95"],
    ["45", "6.6667", "48"],
    ["0.0001", "33", "0.0001"],
  ])("%s %s%% → %s", (current, pct, expected) => {
    expect(applyPercentage(D(current), pct).eq(D(expected))).toBe(true);
  });

  it("keeps the current price's decimals (min 2, max 4) and never uses floats", () => {
    expect(applyPercentage(D("0.035"), "10").decimalPlaces()).toBe(4);
    expect(applyPercentage(D("12.5"), "7.5").toFixed()).toBe("13.44");
    expect(applyPercentage(D("1.2345"), "10").toFixed()).toBe("1.358");
    expect(() => applyPercentage(D("0"), "10")).toThrow();
  });
});

describe("supplier name normalization", () => {
  it("ignores accents, case, punctuation and legal forms", () => {
    const base = normalizeSupplierName("Distribuidora Demo S.A.");
    expect(base).toBe("distribuidora demo");
    for (const variant of [
      "DISTRIBUIDORA DEMO SA",
      "Distribuidora  Demo",
      "Distribuidora Demo S.R.L.",
    ])
      expect(normalizeSupplierName(variant)).toBe(base);
    expect(normalizeSupplierName("Ferretería Él")).toBe("ferreteria el");
    expect(normalizeSupplierName("Demo")).not.toBe(base);
  });
});

describe("settings (defaults + validated overrides)", () => {
  it("uses the confirmed defaults", () => {
    expect(DEFAULT_CATALOG_SETTINGS).toEqual({
      maxIncreasePct: 50,
      maxDecreasePct: 30,
      priceAlertPct: 10,
      lowStockThreshold: null,
      autoCreateProducts: true,
      reactivateOnQuote: true,
    });
  });

  it("stored values override; invalid ones fall back to the default and are reported", () => {
    const resolved = resolveSettings(
      new Map<string, unknown>([
        ["catalog.maxIncreasePct", 20],
        ["catalog.maxDecreasePct", -5],
        ["catalog.lowStockThreshold", 3],
        ["unrelated.key", "x"],
      ]),
    );
    expect(catalogSettings(resolved.values)).toMatchObject({
      maxIncreasePct: 20,
      maxDecreasePct: 30,
      lowStockThreshold: 3,
    });
    expect(resolved.invalidKeys).toEqual(["catalog.maxDecreasePct"]);
  });
});

describe("planner: product resolution", () => {
  it("empty catalog: every line creates a product", () => {
    const p = ungated(
      plan({ output: output({ items: [item(), item({ name: "Clavo 2 pulgadas", price: "5" })] }) }),
    );
    expect(p.lines.map((l) => l.action)).toEqual(["create", "create"]);
    expect(p.lines[0]).toMatchObject({ currency: "UYU", productId: null });
  });

  it("exact normalized name wins; a model ref elsewhere is a conflict", () => {
    const silicona = product("Silicona 280 ML", "280");
    const clavo = product("Clavo 2 pulgadas", "5");
    const catalog = [silicona, clavo];
    const exact = ungated(plan({ catalog }));
    expect(exact.lines[0]).toMatchObject({ action: "update", productId: silicona.id });

    const conflict = ungated(
      plan({
        catalog,
        refs: { P1: clavo.id },
        output: output({ items: [item({ catalogRef: "P1" })] }),
      }),
    );
    expect(conflict.lines[0]).toMatchObject({
      action: "review",
      kind: "match_conflict",
      candidateIds: [silicona.id, clavo.id],
    });
  });

  it("model ref: high → applied, medium/low → product_match review with the candidate", () => {
    const rodillo = product("Rodillo lana 23cm", "400");
    const base = { catalog: [rodillo], refs: { P1: rodillo.id } };
    const high = ungated(
      plan({
        ...base,
        output: output({
          items: [item({ name: "Rodillo lana 23 cm.", catalogRef: "P1", price: "420" })],
        }),
      }),
    );
    expect(high.lines[0]).toMatchObject({ action: "update", productId: rodillo.id });
    const medium = ungated(
      plan({
        ...base,
        output: output({
          items: [
            item({ name: "Rodillo", catalogRef: "P1", matchConfidence: "medium", price: "420" }),
          ],
        }),
      }),
    );
    expect(medium.lines[0]).toMatchObject({
      action: "review",
      kind: "product_match",
      productId: rodillo.id,
      candidateIds: [rodillo.id],
    });
    expect(medium.lines[0]?.newPrice?.toFixed()).toBe("420");
  });

  it("a ref to a product that no longer exists is not trusted", () => {
    const p = ungated(
      plan({
        catalog: [product("Otro", "1")],
        refs: { P1: "deleted-id" },
        output: output({ items: [item({ catalogRef: "P1" })] }),
      }),
    );
    expect(p.lines[0]).toMatchObject({ action: "review", kind: "new_or_existing" });
  });

  it("no ref: high → new product (unless the model saw a truncated catalog), low → review", () => {
    const catalog = [product("Otro", "1")];
    expect(ungated(plan({ catalog })).lines[0]?.action).toBe("create");
    expect(ungated(plan({ catalog, catalogTruncated: true })).lines[0]).toMatchObject({
      action: "review",
      kind: "possible_duplicate",
    });
    expect(
      ungated(plan({ catalog, output: output({ items: [item({ matchConfidence: "low" })] }) }))
        .lines[0],
    ).toMatchObject({ action: "review", kind: "new_or_existing" });
    const noAuto = { ...DEFAULT_CATALOG_SETTINGS, autoCreateProducts: false };
    expect(ungated(plan({ catalog, settings: noAuto })).lines[0]).toMatchObject({
      action: "review",
      reasons: ["auto_create_disabled"],
    });
  });

  it("two lines on the same product (or two identical new names) both go to review", () => {
    const silicona = product("Silicona 280ml", "280");
    const same = ungated(
      plan({
        catalog: [silicona],
        refs: { P1: silicona.id },
        output: output({ items: [item(), item({ name: "Silicona transp.", catalogRef: "P1" })] }),
      }),
    );
    expect(same.lines.map((l) => l.kind)).toEqual(["match_conflict", "match_conflict"]);
    const twins = ungated(plan({ output: output({ items: [item(), item({ price: "310" })] }) }));
    expect(twins.lines.map((l) => l.action)).toEqual(["review", "review"]);
  });
});

describe("planner: price rules", () => {
  const silicona = () => product("Silicona 280ml", "280");

  it("absolute price: update with changePct, unchanged when equal", () => {
    const p = silicona();
    const up = ungated(plan({ catalog: [p] })).lines[0]!;
    expect(up).toMatchObject({ action: "update", oldCurrency: "UYU", currency: "UYU" });
    expect(up.newPrice?.toFixed()).toBe("300");
    expect(up.changePct?.toFixed()).toBe("7.1429");
    const same = ungated(
      plan({ catalog: [p], output: output({ items: [item({ price: "280" })] }) }),
    );
    expect(same.lines[0]?.action).toBe("unchanged");
  });

  it("percentage: applied to the current price with Decimal; without a product → review", () => {
    const p = product("Silicona 280ml", "12.5");
    const pct = ungated(
      plan({
        catalog: [p],
        output: output({ items: [item({ price: null, priceChangePct: "7.5" })] }),
      }),
    ).lines[0]!;
    expect(pct).toMatchObject({ action: "update" });
    expect(pct.newPrice?.toFixed()).toBe("13.44");
    const orphan = ungated(
      plan({ output: output({ items: [item({ price: null, priceChangePct: "10" })] }) }),
    ).lines[0]!;
    expect(orphan).toMatchObject({ action: "review", kind: "pct_without_match" });
  });

  it("currency: missing → assumed only for single-currency suppliers; changed → review", () => {
    const uyu = product("Silicona 280ml", "280");
    const noCurrency = output({ currency: null });
    const assumed = ungated(plan({ catalog: [uyu], output: noCurrency }));
    expect(assumed.lines[0]).toMatchObject({ action: "update", currency: "UYU" });
    expect(assumed.warnings.map((w) => w.code)).toContain("currency_assumed");

    const mixed = ungated(
      plan({ catalog: [uyu, product("Otro", "10", { currency: "USD" })], output: noCurrency }),
    );
    expect(mixed.lines[0]).toMatchObject({ action: "review", kind: "missing_currency" });

    const changed = ungated(plan({ catalog: [uyu], output: output({ currency: "USD" }) }));
    expect(changed.lines[0]).toMatchObject({ action: "review", kind: "currency_changed" });

    const newNoCurrency = ungated(plan({ output: noCurrency }));
    expect(newNoCurrency.lines[0]).toMatchObject({ action: "review", kind: "missing_currency" });
  });

  it.each([
    ["150", "update"], // +50 % exactly → allowed
    ["151", "review"],
    ["70", "update"], // -30 % exactly → allowed
    ["69", "review"],
  ])("outliers vs the confirmed limits (+50 / -30): 100 → %s = %s", (price, action) => {
    const p = product("Silicona 280ml", "100");
    const line = ungated(plan({ catalog: [p], output: output({ items: [item({ price })] }) }))
      .lines[0]!;
    expect(line.action).toBe(action);
    if (action === "review") expect(line.kind).toBe("price_outlier");
  });

  it("outlier limits come from the settings", () => {
    const p = product("Silicona 280ml", "100");
    const strict = { ...DEFAULT_CATALOG_SETTINGS, maxIncreasePct: 5 };
    const line = ungated(
      plan({ catalog: [p], settings: strict, output: output({ items: [item({ price: "106" })] }) }),
    ).lines[0]!;
    expect(line.kind).toBe("price_outlier");
  });

  it("an older message never overwrites a newer price (stale_source)", () => {
    const p = product("Silicona 280ml", "280", { priceSourceAt: new Date("2026-10-02T00:00:00Z") });
    expect(ungated(plan({ catalog: [p] })).lines[0]).toMatchObject({
      action: "review",
      kind: "stale_source",
    });
  });

  it("uncertain values and approved-suspicious runs are never automatic", () => {
    const p = product("Silicona 280ml", "280");
    expect(
      ungated(plan({ catalog: [p], output: output({ items: [item({ uncertain: true })] }) }))
        .lines[0],
    ).toMatchObject({ action: "review", kind: "uncertain_value" });
    const forced = ungated(plan({ catalog: [p], overrides: { forceReview: true } }));
    expect(forced.lines[0]).toMatchObject({ action: "review", reasons: ["suspicious_source"] });
    const incomplete = ungated(plan({ catalog: [p], overrides: { documentIncomplete: true } }));
    expect(incomplete.lines[0]).toMatchObject({
      action: "review",
      kind: "uncertain_value",
      reasons: ["document_incomplete"],
    });
  });

  it("price alerts at or above the alert %, low stock alerts with a threshold", () => {
    const p = product("Silicona 280ml", "100");
    const settings = { ...DEFAULT_CATALOG_SETTINGS, lowStockThreshold: 5 };
    const lines = ungated(
      plan({
        catalog: [p, product("Clavo 2 pulgadas", "100")],
        settings,
        output: output({
          items: [
            item({ price: "110", stock: 3 }),
            item({ name: "Clavo 2 pulgadas", price: "109", stock: 6 }),
          ],
        }),
      }),
    ).lines;
    expect(lines.map((l) => [l.priceAlert, l.lowStock, l.stock])).toEqual([
      [true, true, 3],
      [false, false, 6],
    ]);
  });
});

describe("planner: availability", () => {
  it("a line stating 'sin stock' proposes mark_unavailable (never applied)", () => {
    const p = product("Silicona 280ml", "280");
    const planned = ungated(
      plan({ catalog: [p], output: output({ items: [item({ available: false })] }) }),
    );
    expect(planned.catalogReviews).toEqual([
      { kind: "mark_unavailable", productId: p.id, reason: "stated_unavailable", lineIndex: 0 },
    ]);
    expect(planned.lines[0]?.action).toBe("update"); // the price still applies
    const brandNew = ungated(plan({ output: output({ items: [item({ available: false })] }) }));
    expect(brandNew.lines[0]).toMatchObject({
      action: "review",
      reasons: ["stated_unavailable_new"],
    });
  });

  it("an unavailable product quoted again is reactivated with a warning (setting)", () => {
    const p = product("Silicona 280ml", "280", { available: false });
    const planned = ungated(plan({ catalog: [p] }));
    expect(planned.lines[0]?.reactivate).toBe(true);
    expect(planned.warnings.map((w) => w.code)).toContain("product_reactivated");
    const off = { ...DEFAULT_CATALOG_SETTINGS, reactivateOnQuote: false };
    expect(ungated(plan({ catalog: [p], settings: off })).lines[0]?.reactivate).toBe(false);
  });

  it("full_list: products missing from the list become candidates; partial updates touch nothing", () => {
    const listed = product("Silicona 280ml", "280");
    const candidate = product("Rodillo lana 23cm", "400");
    const missing = product("Disco de corte 115mm", "95");
    const alreadyOff = product("Manguera", "50", { available: false });
    const catalog = [listed, candidate, missing, alreadyOff];
    const items = [item(), item({ name: "Rodillo", catalogRef: "P1", matchConfidence: "medium" })];
    const full = ungated(
      plan({
        catalog,
        refs: { P1: candidate.id },
        output: output({ listKind: "full_list", fullListEvidence: "Lista completa", items }),
      }),
    );
    expect(full.catalogReviews).toEqual([
      {
        kind: "mark_unavailable",
        productId: missing.id,
        reason: "missing_from_full_list",
        lineIndex: null,
      },
    ]);
    const partial = ungated(
      plan({ catalog, refs: { P1: candidate.id }, output: output({ items }) }),
    );
    expect(partial.catalogReviews).toEqual([]);
  });
});

describe("planner: globalChangePct and tax basis", () => {
  it("global percentage: a preview for every available product not listed in the run", () => {
    const listed = product("Silicona 280ml", "280");
    const a = product("Clavo 2 pulgadas", "10");
    const b = product("Rodillo lana 23cm", "0.035");
    const off = product("Manguera", "50", { available: false });
    const planned = ungated(
      plan({ catalog: [listed, a, b, off], output: output({ globalChangePct: "10" }) }),
    );
    expect(
      planned.globalChange?.products.map((x) => [
        x.name,
        x.oldPrice.toFixed(),
        x.newPrice.toFixed(),
        x.outlier,
      ]),
    ).toEqual([
      ["Clavo 2 pulgadas", "10", "11", false],
      ["Rodillo lana 23cm", "0.035", "0.0385", false],
    ]);
    const huge = ungated(
      plan({ catalog: [a], output: output({ items: [], globalChangePct: "80" }) }),
    );
    expect(huge.globalChange?.products[0]?.outlier).toBe(true);
  });

  it("tax basis true ↔ false gates the whole run; an approved change goes through", () => {
    const catalog = [product("Silicona 280ml", "280")];
    const gated = plan({
      catalog,
      supplierTaxIncluded: true,
      output: output({ taxIncluded: false }),
    });
    expect(gated).toEqual({
      gated: true,
      gate: { kind: "tax_basis_changed", previous: true, current: false },
      warnings: [],
    });
    const accepted = ungated(
      plan({
        catalog,
        supplierTaxIncluded: true,
        output: output({ taxIncluded: false }),
        overrides: { acceptTaxChange: true },
      }),
    );
    expect(accepted).toMatchObject({ taxIncluded: false });
    expect(accepted.lines[0]?.action).toBe("update");
    expect(accepted.warnings.map((w) => w.code)).toContain("tax_change_accepted");
  });

  it("list silent about tax after a stated one → warning only; first statement is stored", () => {
    const catalog = [product("Silicona 280ml", "280")];
    const silent = ungated(plan({ catalog, supplierTaxIncluded: true }));
    expect(silent).toMatchObject({ taxIncluded: null });
    expect(silent.lines[0]?.action).toBe("update");
    expect(silent.warnings.map((w) => w.code)).toEqual(["tax_not_stated"]);
    expect(ungated(plan({ output: output({ taxIncluded: true }) })).taxIncluded).toBe(true);
  });

  it("not a price list → nothing to do", () => {
    const planned = ungated(plan({ output: output({ isPriceList: false, items: [] }) }));
    expect(planned.lines).toEqual([]);
    expect(planned.warnings.map((w) => w.code)).toEqual(["not_a_price_list"]);
  });

  it("primary kind follows the reason priority", () => {
    expect(primaryKind(["uncertain_value", "price_outlier"])).toBe("price_outlier");
    expect(primaryKind([])).toBeNull();
  });
});

// ─── The recorded golden outputs: September PDF → October photo ───────────────

const FIXTURES = new URL("../fixtures/extraction/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, FIXTURES));
const EXPECTED = JSON.parse(read("expected.json").toString("utf8")) as {
  photoAgainstSeptember: {
    lines: { catalog: string; newPrice: string; outcome: "price_change" | "review" }[];
    untouched: string[];
  };
};

function golden(messageType: "document" | "image", file: string, mime: string): ExtractionOutput {
  const content = buildExtractionContent(
    {
      messageType,
      text: null,
      transcript: null,
      filename: null,
      mimeType: mime,
      media: read(file),
      contactKind: "supplier",
      supplierName: null,
    },
    null,
  );
  if (!content.ok) throw new Error(content.reason);
  const key = fakeContentKey("extract", content.content);
  return extractionSchema.parse(
    JSON.parse(readFileSync(new URL(`golden/extract/${key}.json`, FIXTURES), "utf8")),
  );
}

describe("planner on the golden outputs (September PDF → October photo)", () => {
  it("PDF on an empty catalog creates 7 products; the photo gives 5 changes, the washer to review, paint untouched", () => {
    const pdf = applyExtractionRules(
      golden("document", "lista-prueba.pdf", "application/pdf"),
      new Map(),
    );
    const first = ungated(plan({ output: pdf }));
    expect(first.lines.map((l) => l.action)).toEqual(Array(7).fill("create"));
    expect(first.taxIncluded).toBe(true);

    const september = first.lines.map((l, i) =>
      product(l.item.name, l.newPrice!.toFixed(), {
        id: `sep-${i}`,
        unit: l.item.unit,
        priceSourceAt: new Date("2026-09-01T00:00:00Z"),
      }),
    );
    const ctx = buildCatalogContext(september.map((p) => ({ ...p, price: p.price.toFixed() })));
    const photo = applyExtractionRules(
      golden("image", "lista-precios-foto.jpg", "image/jpeg"),
      ctx.refNames,
    );
    const second = ungated(
      plan({
        output: photo,
        refs: Object.fromEntries(ctx.refs),
        catalog: september,
        supplierTaxIncluded: true,
      }),
    );

    const nameOf = new Map(september.map((p) => [p.id, p.name]));
    const byCatalog = new Map(second.lines.map((l) => [nameOf.get(l.productId ?? ""), l]));
    for (const line of EXPECTED.photoAgainstSeptember.lines) {
      const planned = byCatalog.get(line.catalog);
      expect(planned?.newPrice?.toFixed(), line.catalog).toBe(line.newPrice);
      expect(planned?.action, line.catalog).toBe(line.outcome === "review" ? "review" : "update");
    }
    expect(second.lines.filter((l) => l.action === "update")).toHaveLength(5);
    expect(second.lines.find((l) => l.action === "review")?.kind).toBe("product_match");
    expect(second.lines.filter((l) => l.priceAlert).map((l) => nameOf.get(l.productId!))).toEqual([
      "Tornillo 6mm",
      "Tuerca 6mm",
    ]);
    for (const name of EXPECTED.photoAgainstSeptember.untouched)
      expect(byCatalog.has(name), name).toBe(false);
    expect(second.catalogReviews).toEqual([]);
    expect(second.globalChange).toBeNull();
    expect(second.warnings.map((w) => w.code)).toEqual(["tax_not_stated"]);
  });
});
