import { describe, expect, it } from "vitest";
import { chartPoints } from "../src/features/catalog/price-chart";
import type { PriceHistoryEntry } from "../src/features/catalog/types";

/** Price history chart (phase 9 M5): one currency per line, a step that reaches "now". */

const entry = (at: string, price: string, currency = "UYU"): PriceHistoryEntry => ({
  id: at,
  oldPrice: null,
  oldCurrency: null,
  newPrice: price,
  newCurrency: currency,
  changePct: null,
  currencyChanged: false,
  source: "auto",
  createdAt: at,
  conversationId: null,
});

describe("chartPoints", () => {
  it("keeps the current currency only and adds today's price as the last point", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    const points = chartPoints(
      {
        price: "72",
        currency: "USD",
        history: [
          entry("2026-09-01T10:00:00Z", "2850"),
          entry("2026-09-25T10:00:00Z", "72", "USD"),
        ],
      },
      now,
    );
    expect(points).toEqual([
      { at: Date.parse("2026-09-25T10:00:00Z"), price: 72 },
      { at: now, price: 72 },
    ]);
  });

  it("no history → nothing to plot", () => {
    expect(chartPoints({ price: "10", currency: "UYU", history: [] })).toEqual([]);
  });
});
