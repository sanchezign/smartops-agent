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
    expect(parseNumberInput(raw, "es")).toEqual({ ok: true, value });
    expect(parseNumberInput(raw, "en")).toEqual({ ok: true, value });
  });

  it("refuses ambiguous thousands (per language), decimals where integers go, and out of range", () => {
    expect(parseNumberInput("1.500", "es")).toEqual({ ok: false, error: { code: "thousands" } });
    expect(parseNumberInput("1,500", "en")).toEqual({ ok: false, error: { code: "thousands" } });
    expect(parseNumberInput("2,5", "es", { integer: true })).toEqual({
      ok: false,
      error: { code: "integer" },
    });
    expect(parseNumberInput("0", "es", { min: 1 })).toEqual({
      ok: false,
      error: { code: "min", params: { limit: 1 } },
    });
    expect(parseNumberInput("120,5", "es", { max: 100 })).toEqual({
      ok: false,
      error: { code: "max", params: { limit: 100 } },
    });
    expect(parseNumberInput("", "en")).toEqual({ ok: false, error: { code: "required" } });
    expect(parseNumberInput("1 2 x", "en")).toEqual({ ok: false, error: { code: "format" } });
  });

  it("editable values use the language's decimal separator", () => {
    expect(toNumberInput(12.5, "es")).toBe("12,5");
    expect(toNumberInput(12.5, "en")).toBe("12.5");
    expect(toNumberInput(null, "en")).toBe("");
  });
});

describe("rule texts", () => {
  it("every section and field has its messages in both languages", async () => {
    const { SECTIONS, fieldMessageKey } = await import("../src/features/rules/fields");
    const catalogs = [
      (await import("../src/i18n/messages/en.json")).default,
      (await import("../src/i18n/messages/es.json")).default,
    ];
    for (const catalog of catalogs) {
      for (const section of SECTIONS) {
        expect(catalog.rules.sections[section.id].title).toBeTruthy();
        for (const field of section.fields) {
          const texts = (catalog.rules.fields as Record<string, Record<string, string>>)[
            fieldMessageKey(field.key)
          ];
          expect(texts?.label, field.key).toBeTruthy();
          expect(texts?.help, field.key).toBeTruthy();
          if (field.kind === "number" && field.suffix)
            expect(texts?.suffix, field.key).toBeTruthy();
        }
      }
    }
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
      error: { code: "hoursEqual", params: { day: 1 } },
    });
  });
});

describe("keywords and phones", () => {
  it("keywords: trimmed, upper-cased, deduplicated; at least one", async () => {
    const { parseKeywords } = await import("../src/features/rules/fields");
    expect(parseKeywords(" baja, Stop ,, BAJA ")).toEqual({ ok: true, value: ["BAJA", "STOP"] });
    expect(parseKeywords(" , ")).toEqual({ ok: false, error: { code: "keywordsEmpty" } });
  });

  it("phones: digits with country code, spaces and + removed, max 10", async () => {
    const { parsePhones } = await import("../src/features/rules/fields");
    expect(parsePhones("+598 99 123 456\n59898765432")).toEqual({
      ok: true,
      value: ["59899123456", "59898765432"],
    });
    expect(parsePhones("099123")).toEqual({
      ok: false,
      error: { code: "phoneInvalid", params: { value: "099123" } },
    });
    expect(parsePhones(Array.from({ length: 11 }, (_, i) => `5989900000${i}`).join(",")).ok).toBe(
      false,
    );
  });
});
