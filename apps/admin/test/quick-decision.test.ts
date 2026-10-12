import { describe, expect, it } from "vitest";
import { createFormat } from "../src/lib/format";
import { reviewQuestion } from "../src/features/reviews/question";
import { quickDecision } from "../src/features/reviews/quick-decision";
import type { ReviewItem, ReviewKind, ReviewScope } from "../src/features/reviews/types";

/** One-click decisions and review questions (phase 15 M3, ADR-032 §3). */

const product = { id: "p", name: "Coarse sand", price: "38", currency: "USD" };
const lineProposal = (over: Record<string, unknown> = {}) => ({
  lineIndex: 0,
  item: { name: "Coarse sand", price: "41.5", priceChangePct: null, currency: "USD" },
  listCurrency: "USD",
  messageAt: "2026-10-01T00:00:00Z",
  candidates: [],
  proposedPrice: "41.5",
  currency: "USD",
  changePct: "9.21",
  ...over,
});

function item(over: Partial<ReviewItem> & { scope: ReviewScope; kind: ReviewKind }): ReviewItem {
  return {
    id: "r",
    status: "pending",
    reasons: [over.kind],
    proposal: lineProposal(),
    resolution: null,
    resolvedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    supplier: null,
    product,
    run: { id: "run", status: "needs_review" },
    message: {
      id: "m",
      conversationId: "c",
      type: "text",
      text: null,
      transcript: null,
      receivedAt: "2026-10-01T00:00:00Z",
      media: null,
    },
    ...over,
  };
}

const YES = { canResolve: true };

describe("quickDecision", () => {
  it("price_outlier with a linked product and a proposed price: update / keep", () => {
    expect(quickDecision(item({ scope: "line", kind: "price_outlier" }), YES)).toEqual({
      kind: "price",
      product: "Coarse sand",
      current: { amount: "38", currency: "USD" },
      proposed: { amount: "41.5", currency: "USD" },
    });
  });

  it("currency_changed shows both currencies; never with a percentage", () => {
    const proposal = lineProposal({
      currency: "UYU",
      item: { name: "Coarse sand", price: "1650", priceChangePct: null, currency: "UYU" },
      proposedPrice: "1650",
    });
    expect(quickDecision(item({ scope: "line", kind: "currency_changed", proposal }), YES)).toEqual(
      {
        kind: "currency",
        product: "Coarse sand",
        current: { amount: "38", currency: "USD" },
        proposed: { amount: "1650", currency: "UYU" },
      },
    );
    const pct = lineProposal({
      currency: "UYU",
      item: { name: "Coarse sand", price: null, priceChangePct: "10", currency: "UYU" },
    });
    expect(
      quickDecision(item({ scope: "line", kind: "currency_changed", proposal: pct }), YES),
    ).toBeNull();
  });

  it("mark_unavailable (catalog): mark / keep", () => {
    expect(
      quickDecision(
        item({ scope: "catalog", kind: "mark_unavailable", reasons: ["missing_from_full_list"] }),
        YES,
      ),
    ).toEqual({ kind: "unavailable", product: "Coarse sand" });
  });

  it("never without a linked product (approving would CREATE one) or a proposed price", () => {
    expect(
      quickDecision(item({ scope: "line", kind: "price_outlier", product: null }), YES),
    ).toBeNull();
    expect(
      quickDecision(
        item({
          scope: "line",
          kind: "price_outlier",
          proposal: lineProposal({ proposedPrice: null }),
        }),
        YES,
      ),
    ).toBeNull();
  });

  it("never when the line has another reason too (look at it in the detail)", () => {
    for (const extra of [
      "stale_source",
      "uncertain_value",
      "invalid_result",
      "document_incomplete",
    ]) {
      expect(
        quickDecision(
          item({ scope: "line", kind: "price_outlier", reasons: ["price_outlier", extra] }),
          YES,
        ),
      ).toBeNull();
    }
  });

  it("never for anything else — stale_source included — nor without permission or once resolved", () => {
    const one = new Set(["price_outlier", "currency_changed", "mark_unavailable"]);
    const kinds: ReviewKind[] = [
      "product_match",
      "new_or_existing",
      "possible_duplicate",
      "match_conflict",
      "uncertain_value",
      "pct_without_match",
      "missing_currency",
      "currency_changed",
      "price_outlier",
      "stale_source",
      "mark_unavailable",
      "global_change",
      "tax_basis_changed",
      "suspicious_instructions",
      "unknown_supplier",
      "extraction_failed",
      "column_mapping",
    ];
    for (const scope of ["run", "line", "catalog"] as const) {
      for (const kind of kinds) {
        const it = item({ scope, kind });
        const allowed =
          (scope === "line" && (kind === "price_outlier" || kind === "currency_changed")) ||
          (scope === "catalog" && kind === "mark_unavailable");
        const got = quickDecision(
          kind === "mark_unavailable" ? { ...it, reasons: ["stated_unavailable"] } : it,
          YES,
        );
        if (!one.has(kind) || !allowed) expect(got, `${scope}/${kind}`).toBeNull();
        expect(quickDecision(it, { canResolve: false })).toBeNull();
        expect(quickDecision({ ...it, status: "approved" }, YES)).toBeNull();
      }
    }
  });
});

describe("reviewQuestion", () => {
  const en = createFormat("en");

  it("puts the proposed answer in the question when the item has it", () => {
    expect(reviewQuestion(item({ scope: "line", kind: "price_outlier" }), en)).toEqual({
      key: "price_outlier",
      params: { product: "Coarse sand", price: en.formatMoney("41.5", "USD") },
    });
    const proposal = lineProposal({ currency: "UYU", proposedPrice: "1650" });
    const q = reviewQuestion(item({ scope: "line", kind: "currency_changed", proposal }), en);
    expect(q.key).toBe("currency_changed");
    expect(q.params.current).toBe(en.formatMoney("38", "USD"));
    expect(q.params.price).toBe(en.formatMoney("1650", "UYU"));
    expect(q.params.price).not.toBe(q.params.current);
  });

  it("falls back to a plain question when the data is missing", () => {
    expect(
      reviewQuestion(item({ scope: "line", kind: "price_outlier", product: null }), en).key,
    ).toBe("price_outlierPlain");
    expect(
      reviewQuestion(item({ scope: "run", kind: "column_mapping", proposal: {} }), en),
    ).toEqual({ key: "column_mappingPlain", params: {} });
    expect(
      reviewQuestion(
        item({ scope: "catalog", kind: "global_change", proposal: { products: [1, 2] } }),
        en,
      ),
    ).toEqual({ key: "global_changePlain", params: { count: 2 } });
  });

  it("run gates ask without params", () => {
    for (const kind of [
      "tax_basis_changed",
      "suspicious_instructions",
      "unknown_supplier",
      "extraction_failed",
    ] as const) {
      expect(reviewQuestion(item({ scope: "run", kind, proposal: {} }), en)).toEqual({
        key: kind,
        params: {},
      });
    }
  });
});
