# ADR-035: Catalog currency setting and the order that resolves a line's currency

Date: 2026-10-15
Status: DRAFT (phase 16 M0; accepted with the M3 implementation). Amends the currency step of ADR-012 (`ingest-plan.ts`).

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
6. Demo: Norvale quotes in USD; the `currency_changed` story beat is a line "in Canadian dollars" (EN) / "en pesos
   uruguayos" (ES), resolved by the reviewer ("Change to CAD 79.90" / "Keep $58.00").

## Known limit (recorded in CLAUDE.md, "Known issues")

The extractor prompt (rule 4) maps a bare "$" to UYU when the business works in Spanish. The setting does not fix it
(the model answers a currency before the plan runs); a new prompt version and re-recorded goldens would. The Spanish
demo samples say "US$" explicitly. Before a real client that quotes in dollars with a bare "$".

## Tests

One test per step of the order (line, list, existing product, new product with `currency_assumed`, and
`currency_changed`); the setting's schema and its Rules form; `format` (both languages); the demo seed in EN and ES
(all USD except the deliberate line); the Spanish goldens recorded in USD only after a free dry-run and the owner's OK
(cap US$ 0.50; the English set cost US$ 0.0803).
