import { describe, expect, it } from "vitest";
import { createFormat } from "../src/lib/format";

/**
 * Numbers and dates follow the panel language (phase 13): en → en-US, es → es-UY (comma
 * decimals, dot thousands — the phase 9 user rule). Time zone: America/Montevideo (UTC−3).
 */

const en = createFormat("en");
const es = createFormat("es");
/** ICU versions differ in the space before "PM" (U+202F in browsers, U+0020 in some Node builds). */
const spaces = (text: string) => text.replace(/[\u202f\u00a0]/g, " ");

describe("money", () => {
  it("es: '$ 1.850,00' from a Decimal string; USD is 'US$'", () => {
    expect(es.formatMoney("1850", "UYU")).toBe("$ 1.850,00");
    expect(es.formatMoney("1850.5", "UYU")).toBe("$ 1.850,50");
    expect(es.formatMoney("72", "USD")).toBe("US$ 72,00");
  });

  it("en: '$1,850.00' for the business currency, USD never shares '$'", () => {
    expect(en.formatMoney("1850", "UYU")).toBe("$1,850.00");
    expect(en.formatMoney("1850.5", "UYU")).toBe("$1,850.50");
    expect(en.formatMoney("72", "USD")).toBe("US$72.00");
    expect(en.formatMoney("-3.5", "UYU")).toBe("-$3.50");
  });

  it("other currencies show their code in both languages", () => {
    expect(en.formatMoney("1850", "ARS")).toBe("ARS 1,850.00");
    expect(es.formatMoney("1850", "ARS")).toBe("ARS 1.850,00");
    expect(en.formatMoney("10", "EUR")).toBe("€10.00");
  });

  it("AI costs: USD up to 4 decimals; big Decimal strings never lose digits", () => {
    expect(en.formatUsd("0.0554")).toBe("US$0.0554");
    expect(es.formatUsd("0.0554")).toBe("US$ 0,0554");
    expect(en.formatMoney("12345678901234.5678", "UYU", 4)).toBe("$12,345,678,901,234.5678");
  });
});

describe("percentages", () => {
  it("es: up to one decimal, a sign and a space before %", () => {
    expect(es.formatPct("85.0002")).toBe("+85 %");
    expect(es.formatPct("12.5")).toBe("+12,5 %");
    expect(es.formatPct("-7.54")).toBe("−7,5 %");
    expect(es.formatPct("0")).toBe("0 %");
  });

  it("en: no space before %", () => {
    expect(en.formatPct("12.5")).toBe("+12.5%");
    expect(en.formatPct("-7.54")).toBe("−7.5%");
    expect(en.formatPct("1250")).toBe("+1,250%");
  });

  it("ratios", () => {
    expect(en.formatRatio(0.826)).toBe("83%");
    expect(es.formatRatio(0.826)).toBe("83 %");
    expect(en.formatRatio(null)).toBe("—");
    expect(es.formatRatio(0.005)).toBe("1 %");
    expect(en.formatRatio(12.345)).toBe("1,235%");
  });
});

describe("plain numbers, list prices and editable fields", () => {
  it("es", () => {
    expect(es.formatNumber("1234.5678", { maximumFractionDigits: 3 })).toBe("1.234,568");
    expect(es.formatNumber(0.0125, { maximumFractionDigits: 3 })).toBe("0,013");
    expect(es.formatPrice("262.3")).toBe("262,30");
    expect(es.formatPrice("1850")).toBe("1.850,00");
    expect(es.formatPrice("0.0385")).toBe("0,0385");
    expect(es.formatInt(12345)).toBe("12.345");
  });

  it("en", () => {
    expect(en.formatNumber("1234.5678", { maximumFractionDigits: 3 })).toBe("1,234.568");
    expect(en.formatNumber("1234.5", { grouping: false })).toBe("1234.5");
    expect(en.formatPrice("1850")).toBe("1,850.00");
    expect(en.formatPrice("0.0385")).toBe("0.0385");
    expect(en.formatInt(12345)).toBe("12,345");
  });

  it("editable price fields never carry a thousands separator", () => {
    expect(es.toDecimalInput("3325.36")).toBe("3325,36");
    expect(en.toDecimalInput("3325.36")).toBe("3325.36");
    expect(es.toDecimalInput("1850")).toBe("1850");
    expect(en.toDecimalInput(null)).toBe("");
  });
});

describe("dates (business time zone)", () => {
  const iso = "2026-09-28T15:04:00Z"; // 12:04 in Montevideo

  it("short days: M/D in English, D/M in Spanish", () => {
    expect(en.formatShortDay("2026-09-27")).toBe("9/27");
    expect(es.formatShortDay("2026-09-27")).toBe("27/9");
  });

  it("date-times and times", () => {
    expect(spaces(en.formatDateTime(iso))).toBe("Sep 28, 12:04 PM");
    expect(es.formatDateTime(iso)).toMatch(/^28 set\.?,? 12:04/);
    expect(spaces(en.formatTime(iso))).toBe("12:04 PM");
    expect(es.formatTime(iso)).toMatch(/^12:04/);
  });

  it("relative times in each language (Spanish neutral)", () => {
    const now = new Date(iso);
    const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
    expect(en.formatRelative(ago(0), now)).toBe("just now");
    expect(en.formatRelative(ago(5), now)).toBe("5 min ago");
    expect(en.formatRelative(ago(180), now)).toBe("3 h ago");
    expect(en.formatRelative(ago(1440), now)).toBe("yesterday");
    expect(en.formatRelative(ago(3 * 1440), now)).toBe("3 days ago");
    expect(es.formatRelative(ago(0), now)).toBe("hace un momento");
    expect(es.formatRelative(ago(5), now)).toBe("hace 5 min");
    expect(es.formatRelative(ago(180), now)).toBe("hace 3 h");
    expect(es.formatRelative(ago(1440), now)).toBe("ayer");
    expect(es.formatRelative(ago(3 * 1440), now)).toBe("hace 3 días");
  });
});

describe("weekdays and day labels", () => {
  it("weekday names by number (0 = Sunday), capitalized", () => {
    expect(en.weekdayName(0)).toBe("Sunday");
    expect(en.weekdayName(1)).toBe("Monday");
    expect(es.weekdayName(3)).toBe("Miércoles");
    expect(es.weekdayName(6)).toBe("Sábado");
  });

  it("chart dates and chat day separators follow the language", () => {
    const iso = "2026-09-28T15:04:00Z";
    expect(en.formatShortDate(iso)).toBe("Sep 28");
    expect(es.formatShortDate(iso)).toMatch(/^28 set/);
    expect(en.formatLongDay(iso)).toBe("Monday, September 28");
    expect(es.formatLongDay(iso)).toMatch(/^lunes,? 28 de se?p?tiembre$/);
    expect(spaces(en.formatWeekdayTime(iso))).toBe("Mon 12:04 PM");
  });
});
