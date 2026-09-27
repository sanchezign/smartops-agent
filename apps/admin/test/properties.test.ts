import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parsePriceInput } from "../src/features/reviews/resolve-input";
import { formatPct, formatPrice, toDecimalInput } from "../src/lib/format";
import { parseNumberInput, toNumberInput } from "../src/lib/number-input";

/**
 * Properties of the panel's number handling (phase 10 M7, fast-check 4.10.2): what the panel
 * shows and pre-fills must read back to the SAME value, and what a person types is never
 * guessed. es-UY: decimal comma, thousands dot on display only.
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

describe("prices", () => {
  it("a pre-filled price field reads back to the API value (toDecimalInput → parsePriceInput)", () => {
    fc.assert(
      fc.property(apiDecimal, (value) => {
        const parsed = parsePriceInput(toDecimalInput(value));
        expect(parsed).toEqual({ ok: true, value });
      }),
      opts,
    );
  });

  it("the displayed price (1.850,00) is the same number", () => {
    fc.assert(
      fc.property(apiDecimal, (value) => {
        const shown = formatPrice(value);
        expect(shown).toMatch(/^\d{1,3}(\.\d{3})*,\d{2,4}$/);
        expect(trim(shown.replace(/\./g, "").replace(",", "."))).toBe(trim(value));
      }),
      opts,
    );
  });

  it("'1.850' (dot + 3 digits) is never guessed; any accepted input is a positive plain decimal", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999_999 }),
        fc.integer({ min: 0, max: 999 }),
        (a, b) => {
          expect(parsePriceInput(`${a}.${String(b).padStart(3, "0")}`).ok).toBe(false);
        },
      ),
      opts,
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), (raw) => {
        const r = parsePriceInput(raw);
        if (r.ok) {
          expect(r.value).toMatch(/^[1-9]\d*(\.\d{1,4})?$|^0\.\d{1,4}$/);
          expect(Number(r.value)).toBeGreaterThan(0);
        }
      }),
      opts,
    );
  });
});

describe("numbers in the rules screen", () => {
  it("toNumberInput → parseNumberInput is the identity (up to 4 decimals, signed)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -999_999_999, max: 999_999_999 }),
        fc.integer({ min: 0, max: 4 }),
        (n, dp) => {
          const value = Number((n / 10 ** dp).toFixed(dp));
          // "1.500"-looking values are refused by design; the panel never writes them.
          const typed = toNumberInput(value);
          expect(parseNumberInput(typed)).toEqual({ ok: true, value });
        },
      ),
      opts,
    );
  });
});

describe("percentages", () => {
  it("sign always shown, at most one decimal, es-UY comma", () => {
    fc.assert(
      fc.property(fc.double({ min: -1_000, max: 1_000, noNaN: true }), (n) => {
        const out = formatPct(n);
        expect(out).toMatch(/^[+−]?\d{1,3}(\.\d{3})*(,\d)? %$/);
        const shown = Number(
          out
            .replace(/[+−\s%]/g, "")
            .replace(/\./g, "")
            .replace(",", "."),
        );
        if (shown !== 0) expect(out.startsWith(n > 0 ? "+" : "−")).toBe(true);
        expect(Math.abs(shown - Math.abs(n))).toBeLessThanOrEqual(0.05 + 1e-9);
      }),
      opts,
    );
  });
});
