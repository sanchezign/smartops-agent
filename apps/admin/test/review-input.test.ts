import { describe, expect, it } from "vitest";
import {
  columnMappingApproveBody,
  initialPriceColumns,
  lineApproveBody,
  lineDefaults,
  parsePriceInput,
} from "../src/features/reviews/resolve-input";
import type { ColumnMappingProposal, LineProposal } from "../src/features/reviews/types";

/** Review resolvers (phase 9 M2): what the person types → the approve body the API accepts. */

describe("parsePriceInput", () => {
  it.each([
    ["1850", "1850"],
    ["1850,5", "1850.5"],
    ["1850.50", "1850.50"],
    ["$ 320", "320"],
    ["0,0385", "0.0385"],
    ["007", "7"],
  ])("%s → %s", (raw, value) => {
    expect(parsePriceInput(raw)).toEqual({ ok: true, value });
  });

  it.each(["", "abc", "1.850", "12,50,1", "1,23456", "0", "-5", "1e3"])(
    "rejects %j (never guessed)",
    (raw) => {
      expect(parsePriceInput(raw).ok).toBe(false);
    },
  );
});

const proposal: LineProposal = {
  lineIndex: 0,
  item: {
    name: "Arena gruesa",
    sku: null,
    unit: "m3",
    price: "3052.5",
    priceChangePct: null,
    currency: "UYU",
    available: null,
    stock: null,
  },
  listCurrency: "UYU",
  messageAt: "2026-09-21T10:00:00Z",
  candidates: [{ id: "p1", name: "Arena gruesa", price: "1650", currency: "UYU" }],
  proposedPrice: "3052.5",
  currency: "UYU",
  changePct: "85",
};

describe("lineApproveBody", () => {
  const defaults = lineDefaults(proposal, "p1", "UYU");

  it("approving as proposed sends only the product (the API applies its own proposal)", () => {
    expect(defaults.target).toBe("p1");
    expect(lineApproveBody(defaults, defaults)).toEqual({ ok: true, body: { productId: "p1" } });
  });

  it("an edited price goes as a plain decimal", () => {
    expect(lineApproveBody({ ...defaults, price: "1.700,00".replace(".", "") }, defaults)).toEqual({
      ok: true,
      body: { productId: "p1", price: "1700.00" },
    });
    expect(lineApproveBody({ ...defaults, price: "1.700" }, defaults).ok).toBe(false);
  });

  it("a new product sends name/price/currency and requires them", () => {
    expect(lineApproveBody({ ...defaults, target: "new", name: "Arena fina" }, defaults)).toEqual({
      ok: true,
      body: { createNew: true, price: "3052.5", currency: "UYU", name: "Arena fina" },
    });
    expect(lineApproveBody({ ...defaults, target: "new", price: "" }, defaults).ok).toBe(false);
    expect(lineApproveBody({ ...defaults, target: "new", name: " " }, defaults).ok).toBe(false);
  });

  it("without a linked product the first candidate is pre-selected, else 'new'", () => {
    expect(lineDefaults(proposal, null, null).target).toBe("p1");
    expect(lineDefaults({ ...proposal, candidates: [] }, null, null).target).toBe("new");
  });
});

describe("column mapping", () => {
  const table = {
    table: "T1",
    sheet: "Lista",
    isPriceTable: true,
    headerRow: 2,
    fingerprint: "f",
    headerCells: [],
    mapping: {
      nameColumn: 1,
      priceColumn: null,
      pctColumn: null,
      unitColumn: 2,
      skuColumn: 0,
      priceFormat: "decimal_dot" as const,
      currency: "UYU",
      taxIncluded: null,
      priceColumns: [],
    },
    ambiguous: true,
    recommendedPriceColumn: 4,
    confidence: "high" as const,
    remembered: false,
    preview: [],
  };
  const mapping: ColumnMappingProposal = {
    reason: "new_format",
    supplierName: null,
    suspiciousInstructions: false,
    warnings: [],
    tables: [
      table,
      { ...table, table: "T2", sheet: "Condiciones", isPriceTable: false },
      { ...table, table: "T3", remembered: true },
    ],
  };

  it("pre-selects the recommendation (only a pre-selection: the person confirms)", () => {
    expect(initialPriceColumns(mapping)).toEqual({ T1: 4 });
  });

  it("sends the chosen column for each new price table; a missing choice is an error", () => {
    expect(columnMappingApproveBody(mapping, { T1: 3 })).toEqual({
      ok: true,
      body: { tables: [{ table: "T1", priceColumn: 3 }] },
    });
    expect(columnMappingApproveBody(mapping, { T1: null }).ok).toBe(false);
  });
});

describe("formatPct", () => {
  it("rounds to one decimal with the local separator and a sign", async () => {
    const { formatPct } = await import("../src/lib/format");
    expect(formatPct("85.0002")).toBe("+85 %");
    expect(formatPct("-7.54")).toBe("−7,5 %");
    expect(formatPct("0")).toBe("0 %");
  });
});
