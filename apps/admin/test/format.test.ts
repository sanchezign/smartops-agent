import { describe, expect, it } from "vitest";
import {
  formatMoney,
  formatNumber,
  formatPct,
  formatPrice,
  toDecimalInput,
} from "../src/lib/format";

/** Every number in the panel is es-UY: comma decimals, dot thousands (phase 9, user rule). */

describe("es-UY numbers", () => {
  it("money: '$ 1.850,00' from a Decimal string", () => {
    expect(formatMoney("1850", "UYU")).toBe("$ 1.850,00");
    expect(formatMoney("1850.5", "UYU")).toBe("$ 1.850,50");
    expect(formatMoney("72", "USD")).toMatch(/^US\$ 72,00$/);
  });

  it("percentages with up to one decimal and a sign", () => {
    expect(formatPct("85.0002")).toBe("+85 %");
    expect(formatPct("12.5")).toBe("+12,5 %");
    expect(formatPct("-7.54")).toBe("−7,5 %");
    expect(formatPct("0")).toBe("0 %");
  });

  it("plain numbers and list prices", () => {
    expect(formatNumber("1234.5678", { maximumFractionDigits: 3 })).toBe("1.234,568");
    expect(formatNumber(0.0125, { maximumFractionDigits: 3 })).toBe("0,013");
    expect(formatPrice("262.3")).toBe("262,30");
    expect(formatPrice("1850")).toBe("1.850,00");
    expect(formatPrice("0.0385")).toBe("0,0385");
  });

  it("editable price fields: comma decimals, never a thousands dot", () => {
    expect(toDecimalInput("3325.36")).toBe("3325,36");
    expect(toDecimalInput("1850")).toBe("1850");
    expect(toDecimalInput(null)).toBe("");
  });
});
