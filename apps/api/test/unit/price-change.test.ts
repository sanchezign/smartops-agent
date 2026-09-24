import { describe, expect, it } from "vitest";
import { Prisma } from "../../src/generated/prisma/client.js";
import { computePriceChange } from "../../src/modules/catalog/price-change.js";

const d = (v: string) => new Prisma.Decimal(v);

describe("computePriceChange", () => {
  it("computes the percentage for a same-currency change", () => {
    const r = computePriceChange(
      { price: d("100"), currency: "USD" },
      { price: d("112.5"), currency: "USD" },
    );
    expect(r.currencyChanged).toBe(false);
    expect(r.changePct?.toFixed()).toBe("12.5");
  });

  it("computes negative percentages rounded to 4 decimals", () => {
    const r = computePriceChange(
      { price: d("3"), currency: "UYU" },
      { price: d("2"), currency: "UYU" },
    );
    expect(r.changePct?.toFixed()).toBe("-33.3333");
  });

  it("supports huge outliers without overflow", () => {
    const r = computePriceChange(
      { price: d("0.01"), currency: "USD" },
      { price: d("100"), currency: "USD" },
    );
    expect(r.changePct?.toFixed()).toBe("999900");
  });

  it("sets changePct = null and flags currencyChanged when the currency changes", () => {
    const r = computePriceChange(
      { price: d("100"), currency: "USD" },
      { price: d("4000"), currency: "UYU" },
    );
    expect(r).toMatchObject({
      currencyChanged: true,
      changePct: null,
      oldCurrency: "USD",
      newCurrency: "UYU",
    });
  });

  it("compares currencies case-insensitively", () => {
    const r = computePriceChange(
      { price: d("10"), currency: "usd" },
      { price: d("11"), currency: "USD" },
    );
    expect(r.currencyChanged).toBe(false);
    expect(r.changePct?.toFixed()).toBe("10");
  });

  it("has no percentage for the first price of a new product", () => {
    const r = computePriceChange(null, { price: d("50"), currency: "USD" });
    expect(r).toMatchObject({
      oldPrice: null,
      oldCurrency: null,
      changePct: null,
      currencyChanged: false,
    });
  });

  it("has no percentage when the previous price was 0", () => {
    const r = computePriceChange(
      { price: d("0"), currency: "USD" },
      { price: d("5"), currency: "USD" },
    );
    expect(r.changePct).toBeNull();
    expect(r.currencyChanged).toBe(false);
  });
});
