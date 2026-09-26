import { describe, expect, it } from "vitest";
import { fromRows, toRows } from "../src/features/rules/business-hours";
import { parseNumberInput, toNumberInput } from "../src/lib/number-input";

/** Rules page (phase 9 M6): typed numbers and the business-hours editor. */

describe("parseNumberInput", () => {
  it.each([
    ["10", 10],
    ["12,5", 12.5],
    ["12.5", 12.5],
    [" 30 ", 30],
  ])("%j → %d", (raw, value) => {
    expect(parseNumberInput(raw)).toEqual({ ok: true, value });
  });

  it("refuses ambiguous thousands, decimals where integers go, and out of range", () => {
    expect(parseNumberInput("1.500").ok).toBe(false);
    expect(parseNumberInput("2,5", { integer: true }).ok).toBe(false);
    expect(parseNumberInput("0", { min: 1 })).toEqual({ ok: false, message: "El mínimo es 1." });
    expect(parseNumberInput("120,5", { max: 100 })).toEqual({
      ok: false,
      message: "El máximo es 100.",
    });
    expect(parseNumberInput("").ok).toBe(false);
  });

  it("editable values use a decimal comma", () => {
    expect(toNumberInput(12.5)).toBe("12,5");
    expect(toNumberInput(null)).toBe("");
  });
});

describe("business hours rows", () => {
  it("round trip: Monday first, closed days kept with suggested hours", () => {
    const hours = {
      timeZone: "America/Montevideo",
      days: [
        { day: 1, open: "09:00", close: "18:00" },
        { day: 6, open: "09:00", close: "13:00" },
      ],
    };
    const rows = toRows(hours);
    expect(rows.map((r) => r.day)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(rows.filter((r) => r.enabled).map((r) => r.day)).toEqual([1, 6]);
    expect(fromRows(rows)).toEqual({ ok: true, value: hours });
  });

  it("validates times and refuses open = close", () => {
    const rows = toRows(null).map((r) =>
      r.day === 1 ? { ...r, enabled: true, close: "09:00" } : r,
    );
    expect(fromRows(rows)).toEqual({
      ok: false,
      message: "Lunes: la apertura y el cierre no pueden ser iguales.",
    });
  });
});

describe("keywords and phones", () => {
  it("keywords: trimmed, upper-cased, deduplicated; at least one", async () => {
    const { parseKeywords } = await import("../src/features/rules/fields");
    expect(parseKeywords(" baja, Stop ,, BAJA ")).toEqual({ ok: true, value: ["BAJA", "STOP"] });
    expect(parseKeywords(" , ").ok).toBe(false);
  });

  it("phones: digits with country code, spaces and + removed, max 10", async () => {
    const { parsePhones } = await import("../src/features/rules/fields");
    expect(parsePhones("+598 99 123 456\n59898765432")).toEqual({
      ok: true,
      value: ["59899123456", "59898765432"],
    });
    expect(parsePhones("099123").ok).toBe(false);
    expect(parsePhones(Array.from({ length: 11 }, (_, i) => `5989900000${i}`).join(",")).ok).toBe(
      false,
    );
  });
});
