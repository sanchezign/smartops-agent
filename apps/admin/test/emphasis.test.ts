import { describe, expect, it } from "vitest";
import { markParams, splitMarked } from "../src/features/reviews/emphasis";

/** The values of a review question in a heavier weight (phase 16 M5, ADR-033 §7). */

// What next-intl does with the marked params, for a message with the same shape as the catalogs.
const fill = (message: string, params: Record<string, string | number>) =>
  message.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key]));

describe("markParams + splitMarked", () => {
  it("emphasizes the product and the amounts, and keeps the text around them", () => {
    const { marked, values } = markParams({ product: "Coarse sand", price: "$41.50" });
    const parts = splitMarked(fill("Update {product} to {price}?", marked), values);
    expect(parts).toEqual([
      { text: "Update ", strong: false },
      { text: "Coarse sand", strong: true },
      { text: " to ", strong: false },
      { text: "$41.50", strong: true },
      { text: "?", strong: false },
    ]);
    expect(parts.map((p) => p.text).join("")).toBe("Update Coarse sand to $41.50?");
  });

  it("handles a value at the start, at the end and inside quotes", () => {
    const { marked, values } = markParams({ line: "Arandela 8 mm", current: "US$ 2,00" });
    expect(splitMarked(fill("{current} → “{line}”", marked), values)).toEqual([
      { text: "US$ 2,00", strong: true },
      { text: " → “", strong: false },
      { text: "Arandela 8 mm", strong: true },
      { text: "”", strong: false },
    ]);
  });

  it("never marks a number (a plural argument needs it) nor a param that is not a value", () => {
    const { marked, values } = markParams({ pct: "+10 %", count: 3, file: "list.xlsx" });
    expect(marked.count).toBe(3);
    expect(marked.file).toBe("list.xlsx");
    expect(values).toEqual(["+10 %"]);
  });

  it("returns the text alone when there is nothing to emphasize, and drops an empty value", () => {
    expect(splitMarked("Suspicious message", [])).toEqual([
      { text: "Suspicious message", strong: false },
    ]);
    const { marked, values } = markParams({ line: "" });
    expect(splitMarked(fill("Was “{line}” read right?", marked), values)).toEqual([
      { text: "Was “", strong: false },
      { text: "” read right?", strong: false },
    ]);
  });
});
