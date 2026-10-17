import { describe, expect, it } from "vitest";
import { idParam, pickOne, withParam } from "../src/lib/url-filters";

/** Filters kept in the URL (phase 16 M6a): closed choices and opaque ids only. */

describe("pickOne", () => {
  it("accepts an allowed value and falls back on anything else", () => {
    const filters = ["all", "needs_reply", "human"] as const;
    expect(pickOne("needs_reply", filters, "all")).toBe("needs_reply");
    expect(pickOne(null, filters, "all")).toBe("all");
    expect(pickOne("drop table", filters, "all")).toBe("all");
  });
  it("compares numbers by their text (the Home period)", () => {
    expect(pickOne("30", [7, 14, 30] as const, 14)).toBe(30);
    expect(pickOne("15", [7, 14, 30] as const, 14)).toBe(14);
  });
});

describe("idParam", () => {
  it("takes a uuid and refuses free text", () => {
    expect(idParam("6f1c2a9e-0b7d-4a51-9d0e-3c2b1a0f9e8d")).toBe(
      "6f1c2a9e-0b7d-4a51-9d0e-3c2b1a0f9e8d",
    );
    expect(idParam("+598 99 123 456")).toBeNull();
    expect(idParam("<script>")).toBeNull();
    expect(idParam("x".repeat(65))).toBeNull();
    expect(idParam(null)).toBeNull();
  });
});

describe("withParam", () => {
  it("sets, replaces and removes one param and keeps the others", () => {
    expect(withParam("", "filter", "human")).toBe("?filter=human");
    expect(withParam("filter=human&days=7", "filter", "all")).toBe("?filter=all&days=7");
    expect(withParam("filter=human&days=7", "filter", null)).toBe("?days=7");
    expect(withParam("filter=human", "filter", null)).toBe("");
  });
});
