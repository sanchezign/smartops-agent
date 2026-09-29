import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parsePriceInput } from "../src/features/reviews/resolve-input";
import { LOCALES } from "../src/i18n/locales";
import { createFormat } from "../src/lib/format";
import { parseNumberInput, toNumberInput } from "../src/lib/number-input";

/**
 * Properties of the panel's number handling (phase 10 M7, fast-check 4.10.2; both panel languages
 * since phase 13): what the panel shows and pre-fills must read back to the SAME value, and what a
 * person types is never guessed. es → es-UY (decimal comma, thousands dot on display only);
 * en → en-US (decimal point, thousands comma on display only).
 */

const RUNS = Number(process.env.FC_RUNS ?? 300);
const opts = { numRuns: RUNS };

/** A Decimal string as the API sends it: plain notation, 1–13 integer digits, 0–4 decimals. */
const apiDecimal = fc
  .tuple(
    fc.integer({ min: 1, max: 9_999_999_999_999 }),
    fc.integer({ min: 0, max: 4 }),
    fc.nat(9_999),
  )
  .map(([int, dp, frac]) =>
    dp ? `${int}.${String(frac).padStart(4, "0").slice(0, dp)}` : String(int),
  );
const trim = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

/** Separators of each language: [group, decimal]. */
const SEPARATORS = { en: [",", "."], es: [".", ","] } as const;

describe.each(LOCALES)("%s", (locale) => {
  const format = createFormat(locale);
  const [group, decimal] = SEPARATORS[locale];
  /** "1.850,5" (es) / "1,850.5" (en) → "1850.5". */
  const plain = (shown: string) => shown.split(group).join("").replace(decimal, ".");

  it("a pre-filled price field reads back to the API value (toDecimalInput → parsePriceInput)", () => {
    fc.assert(
      fc.property(apiDecimal, (value) => {
        expect(parsePriceInput(format.toDecimalInput(value), locale)).toEqual({ ok: true, value });
      }),
      opts,
    );
  });

  it("the displayed price is the same number", () => {
    const g = group === "." ? "\\." : group;
    const d = decimal === "." ? "\\." : decimal;
    const shape = new RegExp(`^\\d{1,3}(${g}\\d{3})*${d}\\d{2,4}$`);
    fc.assert(
      fc.property(apiDecimal, (value) => {
        const shown = format.formatPrice(value);
        expect(shown).toMatch(shape);
        expect(trim(plain(shown))).toBe(trim(value));
      }),
      opts,
    );
  });

  it("the language's group separator + 3 digits is never guessed; accepted input is positive", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999_999 }),
        fc.integer({ min: 0, max: 999 }),
        (a, b) => {
          expect(parsePriceInput(`${a}${group}${String(b).padStart(3, "0")}`, locale).ok).toBe(
            false,
          );
        },
      ),
      opts,
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), (raw) => {
        const r = parsePriceInput(raw, locale);
        if (r.ok) {
          expect(r.value).toMatch(/^[1-9]\d*(\.\d{1,4})?$|^0\.\d{1,4}$/);
          expect(Number(r.value)).toBeGreaterThan(0);
        }
      }),
      opts,
    );
  });

  it("rules screen: toNumberInput → parseNumberInput is the identity (up to 4 decimals, signed)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -999_999_999, max: 999_999_999 }),
        fc.integer({ min: 0, max: 4 }),
        (n, dp) => {
          const value = Number((n / 10 ** dp).toFixed(dp));
          // Ambiguous-looking values are refused by design; the panel never writes them.
          expect(parseNumberInput(toNumberInput(value, locale), locale)).toEqual({
            ok: true,
            value,
          });
        },
      ),
      opts,
    );
  });

  it("percentages: sign always shown, at most one decimal", () => {
    const g = group === "." ? "\\." : group;
    const d = decimal === "." ? "\\." : decimal;
    const shape = new RegExp(
      `^[+−]?\\d{1,3}(${g}\\d{3})*(${d}\\d)?${locale === "es" ? " " : ""}%$`,
    );
    fc.assert(
      fc.property(fc.double({ min: -1_000, max: 1_000, noNaN: true }), (n) => {
        const out = format.formatPct(n);
        expect(out).toMatch(shape);
        const shown = Number(plain(out.replace(/[+−\s%]/g, "")));
        if (shown !== 0) expect(out.startsWith(n > 0 ? "+" : "−")).toBe(true);
        expect(Math.abs(shown - Math.abs(n))).toBeLessThanOrEqual(0.05 + 1e-9);
      }),
      opts,
    );
  });
});
