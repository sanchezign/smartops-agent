# ADR-013: Document conversion (xlsx / xls / csv / txt / docx → text)

Date: 2026-09-25
Status: accepted

## Decision

Claude reads PDFs and images natively but not spreadsheets or Word files. Those are
converted to text (Markdown tables) by the **worker**, before extraction, in
`apps/api/src/modules/documents/`:

| Format     | Library                                                                                    | Notes                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| xlsx / xls | **SheetJS CE 0.20.3 from the SheetJS CDN** (tarball, integrity pinned in `pnpm-lock.yaml`) | The npm `xlsx` package is frozen at 0.18.5 (CVE-2023-30533, CVE-2024-22363). `exceljs` was rejected: inactive, CVE-2026-78206 (zip bomb) unpatched. Some scanners flag 0.20.3 wrongly (SheetJS documents it as a false positive). |
| csv / txt  | `csv-parse` 7.0.2                                                                          | 7.0.3 was hours old: the pnpm minimum-release-age policy is respected, never bypassed.                                                                                                                                            |
| docx       | `mammoth` 1.12.3 + `htmlparser2` 12.0.0                                                    | ≥ 1.11.0 fixes CVE-2025-11849 (file read through external image links); we also pass `externalFileAccess: false` and drop images. Tables → Markdown.                                                                              |

**Pipeline:** media stored → `document_conversions` row (pending) + `document-conversion`
job in the same transaction (pg-boss `fromPrisma`) → worker converts → extraction reads
`<document_text>`. `assertReady` answers NOT_READY while pending. A failed conversion
(reason `zip_bomb`, `encrypted`, `too_large`, `timeout`, `out_of_memory`, …) sends the run
to review (`extraction_failed`, reason `document_<reason>`) without calling the LLM.

**Security layers:**

1. Size cap (`DOC_CONVERT_MAX_BYTES`, 10 MB). ZIP containers (xlsx, docx) are fully
   test-inflated first with `fflate`, fed in 1 KB slices so each step produces ≤ ~1 MB,
   counting REAL output: > 100 MB total, > 2,000 entries or a > 100:1 entry ratio →
   rejected. Declared sizes are not trusted.
2. Every conversion runs in its own `worker_thread` with a V8 heap limit (256 MB) and a
   timeout (`DOC_CONVERT_TIMEOUT_MS`, 20 s) → terminated. The heap limit does not cover
   Buffers, hence layer 1.
3. Output limits: 10 sheets, 2,000 rows and 50 columns per sheet, 40,000 characters
   (`DOC_CONVERT_*`). Cut content → `truncated` → the extraction is forced to
   `partial_update` (a cut list must never mark products unavailable).

**Content rules:** visible sheets only (hidden / very hidden skipped, with a warning);
hidden rows/columns skipped; formulas never evaluated (cached value used; a formula
without a cached value → empty cell + `needsReview` → never a full list and every line to
review); vertical merged cells repeated on each row; numbers as plain decimals, percentages
as displayed, dates ISO; CSV decoded as UTF-8 / UTF-16 LE / Windows-1252 with delimiter
sniffing. Converted text goes inside `<document_text>` with our tags neutralized (ADR-011).

**Until chunked extraction (phase 5 M3b):** a converted document with more than 30
product lines goes to review (`requires_chunked_extraction`) instead of one LLM call that
would be cut at `max_tokens` (measured: ~95 output tokens per typical item, 169 worst).
Spreadsheets get a deterministic path first (M3c: the LLM maps the columns, the code reads
the rows).

**Spend:** `AI_MAX_RUN_USD` (default $0.30) caps all AI calls of one ingestion run, on top
of the daily ($0.50) and total ($4) caps.

## Reason

- Spreadsheets are the most common large supplier format; they must be read safely
  (they are untrusted files) and cheaply.
- Converting in the worker keeps CPU-heavy parsing out of the API request path that n8n
  calls, and matches the transcription pattern (phase 4).

## Consequences

- One dependency is installed from a URL (SheetJS CDN): upgrades are manual and must
  re-check the advisories page.
- Conversion adds latency (~worker startup + parse) before extraction; n8n polls
  `GET /api/v1/internal/runs/:id`.
- Old documents stored before this change have no conversion row: extraction answers
  CONFLICT for them.
