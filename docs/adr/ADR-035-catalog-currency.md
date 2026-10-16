# ADR-035: Catalog currency setting and the order that resolves a line's currency

Date: 2026-10-15
Status: accepted (the owner's decision, 2026-10-15; implemented in phase 16 M3). Amends the currency step of ADR-012 (`ingest-plan.ts`).

## Context

All demo content moves to USD (EN and ES; the English demo had Norvale in CAD, the Spanish one used UYU). Today
(`ingest-plan.ts`, price step):

- **existing product, percentage line:** the product's currency;
- **existing product, absolute price:** the line's currency, else the list's; if neither and **every** product of the
  supplier is in one currency equal to the product's, that currency is assumed (warning `currency_assumed`); else
  review `missing_currency`; a currency different from the product's → review `currency_changed`;
- **new product:** the line's or the list's currency, else review `missing_currency` (nothing is assumed).

## Decision

1. New Rules setting **`catalog.currency`** (ISO 4217, default `USD`; an admin edits it, the operator sees it read
   only). A settings key only: no schema change, no migration.
2. **Order that resolves a line's currency:**
   1. the line's own currency;
   2. the list's currency;
   3. **if the product already exists, its current currency** (the existing logic is kept: a supplier that always quoted
      a product in pesos and sends a list without a currency most likely still quotes it in pesos; assuming USD there
      would create false `currency_changed` reviews or, worse, wrong prices);
   4. **only for NEW products: the catalog currency**, always with the warning `currency_assumed`.
3. The inference "every product of the supplier is in one currency" is replaced by step 3 (it was a weaker version of
   it). A NEW product without a currency no longer goes to `missing_currency`; it is created in the catalog currency
   with `currency_assumed`. `missing_currency` stays in the enum (history; no migration) but the plan stops producing it.
4. A currency different from the product's still goes to review (`currency_changed`). The one-click decision shows both
   currencies. **No exchange-rate conversion** — out of scope: a price is never converted.
5. Formatting: English `$58.00`, Spanish `US$ 58,00`; any other currency shows its ISO code in both languages
   (`CAD 79.90`, `UYU 2.390,00`), so a peso is never read as a dollar.
6. Demo: EVERY supplier quotes in USD (Norvale too); the `currency_changed` story beat is one line "in Canadian dollars" (EN,
   CAD 79.90) / "en pesos uruguayos" (ES, UYU 2,990.00), resolved by the reviewer ("Change to CAD 79.90" / "Keep $…").
   Spanish content: each old peso amount became USD (÷ 40, to the cent) and every price in its samples says "US$".

## Known limit (recorded in CLAUDE.md, "Known issues")

The extractor prompt (rule 4) maps a bare "$" to UYU when the business works in Spanish. The setting does not fix it
(the model answers a currency before the plan runs); a new prompt version and re-recorded goldens would. The Spanish
demo samples say "US$" explicitly. Before a real client that quotes in dollars with a bare "$".

## What was built (M3)

- `catalog.currency` in `settings.schemas.ts` (`/^[A-Z]{3}$/`, default USD; an invalid stored value falls back to USD and is
  reported, like every setting). Rules: a text field for an admin, a plain value for an operator.
- `ingest-plan.ts`: an existing product with no line/list currency keeps ITS currency (`currency_assumed`); a new product
  takes `settings.currency` (`currency_assumed`); `missing_currency` is no longer produced. A percentage line still follows
  the product and assumes nothing.
- Panel `formatMoney`: USD = "$" (en) / "US$" (es); every other currency, its ISO code in both languages.
- Spanish demo assets in `demo/assets/es/` (and their fixtures in `test/fixtures/{extraction,sheets}/es-usd/`, built by
  `scripts/fixtures/build-spanish-usd-pdf.mjs`, `build-spanish-usd-photo.mjs` and `build-sheet-fixtures.ts`); the voice
  note is synthetic (Echogarden / eSpeak) and its transcript is the real Groq answer. The Spanish goldens are recorded with
  `ai:record-golden --lang es-usd` (`--dry-run` first). The old peso assets and goldens stay: the older Spanish fixtures
  still feed the test suite.

## Tests

One test per step of the order (line, list, existing product, new product with `currency_assumed`, and
`currency_changed`); the setting's schema and its Rules form; `format` (both languages); the demo seed in EN and ES
(all USD except the deliberate line); the Spanish goldens recorded in USD only after a free dry-run and the owner's OK
(cap US$ 0.50; the English set cost US$ 0.0803). Recorded 2026-10-16: dry-run expected US$ 0.1377 (worst case 0.4221),
real cost **US$ 0.0762** (9 calls); `golden-outputs-es-usd.test.ts` checks them against `es-usd/expected.json` and the demo
content. The pesos fixtures and goldens stay: the system still accepts lists in pesos and they test that path.
