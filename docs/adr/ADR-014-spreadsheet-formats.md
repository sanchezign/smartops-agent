# ADR-014: Spreadsheets read deterministically with remembered formats per supplier

Date: 2026-09-26
Status: accepted

## Decision

Spreadsheets (xlsx, xls, csv) are NOT extracted row by row by the LLM. The conversion
(ADR-013) keeps a **typed grid** (`document_conversions.tables`: text as written, numbers as
plain decimals). Then (`apps/api/src/modules/sheets/`):

1. **Format memory** — `supplier_sheet_formats`: per supplier, one ACTIVE format per
   **header fingerprint** (sha256 of the normalized header cells, searched in the first 10
   rows). Several formats can coexist (different spreadsheets of the same supplier). A
   format that fails validation is **retired** (never deleted).
2. **Known format → deterministic read, $0**: every row is read with the approved mapping
   (`sheet-reader.ts`): name, price (decimal comma / dot rules; ambiguous text is never
   guessed), %, unit, SKU, currency, stock, availability. Category rows are skipped; more
   than **20 % unreadable rows** → the format is retired and the table is mapped again.
3. **Unknown format → one mapper call** (`column-mapper.md`, header + 12 sample rows per
   table, ~$0.01) → the run waits in a **`column_mapping` review** (always, even with
   high confidence). The proposal lists every price column with examples; with more than
   one ("Precio s/IVA | Precio c/IVA | Mayorista | Contado") the mapping is ambiguous and
   the reviewer MUST choose. The chosen column sets `taxIncluded` (c/IVA → true,
   s/IVA → false), which feeds the M4 tax-basis rule. Approving saves the format(s),
   resolves the supplier if the contact has none (M4 rule) and sends the run back to
   `classified`; the next `extract` reads the whole file deterministically.
4. **Compact matcher** (`matcher.md`) only for rows without an exact catalog name: batches
   of 150, the catalog in a cached content block, names as untrusted data inside
   `<product_names>` with our tags neutralized; the output is only `row / ref / confidence`,
   rows outside the batch and refs outside the catalog are discarded, and the M2 rules
   (unknown refs, duplicates, missing attributes) apply. The cost of ALL batches is checked
   against the budgets (`AiClient.preflight`, including `AI_MAX_RUN_USD`) before the first.
5. **List signals without LLM** (`list-rules.ts`): tax, currency and quoted full-list
   evidence from the text outside the product rows; injection patterns in any cell →
   suspicious → review. A truncated table or any unreadable row → never `full_list`.
6. The catalog ingest writes in batches (`createManyAndReturn` + one `UPDATE … FROM
(VALUES …)` per 500 lines): 2,000 rows are read and ingested in ~1.5 s locally.

## Reason

- Output tokens are ~90 % of the extraction cost (~95 per item measured): a 1,000-row list
  costs ~$1.4 extracted by the LLM, ~$0.01–0.05 this way, and prices come from the cells
  instead of being re-typed by a model.
- A human confirming each new format once is cheap and removes the riskiest decision
  (which price column is "the" price).

## Consequences

- The first spreadsheet of every supplier format waits for a human once. The demo seeds its
  sample supplier with an approved format (phase 9 / 12) to show the $0 path.
- Mapper and matcher use the extractor model (`AI_EXTRACTOR_MODEL`); golden outputs for the
  sample spreadsheet are recorded only with the user's OK.
- Word documents and long PDFs are not covered: they still need chunked extraction (M3b).
