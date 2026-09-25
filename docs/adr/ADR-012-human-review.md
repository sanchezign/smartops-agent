# ADR-012: Catalog ingest rules and human review items

Date: 2026-09-25
Status: accepted

## Decision

Supplier price lists (extracted by Claude, ADR-011) are applied to the catalog by a
**pure planner** (`src/modules/catalog/ingest-plan.ts`) and a single-transaction
repository (`catalog.repository.ts`). Anything the system must not decide alone becomes
a **review item** (table `review_items`) that a human approves or rejects.

**Ingest** (`POST /api/v1/internal/catalog/ingest {runId}`, called by n8n):

- Locked per run (`extracted → ingesting`, atomic) and idempotent (a finished run returns
  its stored report). Writes run under per-contact and per-supplier advisory locks; a
  partial unique index (`price_changes (ingestion_run_id, product_id) WHERE source='auto'`)
  guarantees a run never changes a product twice.
- Supplier: the contact's supplier; else the document's `supplierName` matched
  (normalized, legal forms ignored) with existing suppliers → link; no match → a supplier
  is created (supplierName, else the WhatsApp profile name) and linked with an
  informative warning. Several matches → `unknown_supplier` gate.
- Product per line: empty catalog → new; exact normalized name; model `catalogRef` with
  `high`; otherwise review (`product_match`, `new_or_existing`, `possible_duplicate` when
  the model saw a truncated catalog, `match_conflict`).
- Price: percentages applied to the current price with Decimal (decimals of the current
  price, min 2, more up to 4 when rounding would distort the change by > 0.1 pp);
  currency missing → assumed only for single-currency suppliers; currency change,
  outliers (settings: +50 % / −30 %), older source message (`stale_source`) and
  uncertain values → review. Changes ≥ 10 % (setting) create `price_change` alerts.
- Never automatic: marking products unavailable (`mark_unavailable`, from a full list
  or a "sin stock" line), `globalChangePct` (`global_change`), a tax-basis change
  true ↔ false (`tax_basis_changed` gates the whole run; list silent about tax → warning
  only).
- Rules are settings (`settings` table, Zod per key, code defaults), exposed read-only to
  n8n at `GET /api/v1/internal/rules`; the panel edits them in phase 9.

**Review items** (`review_items`): `scope` run | line | catalog; `kind` (16 values);
`status` pending → approved | rejected | superseded; `reasons` (codes), `proposal` (JSON,
Decimals as strings), `basePrice/baseCurrency` (product state when proposed),
`resolution`, `resolvedById`, unique `(ingestion_run_id, dedupe_key)`.

- Line/catalog approvals apply the same write helpers as the ingest
  (`PriceChange.source = review`, `reviewItemId`), under the supplier lock. A proposal
  whose product changed since (basePrice) → `superseded` + 409 `STALE_REVIEW`. A newer
  run touching the same product supersedes older pending items.
- Run gates: `tax_basis_changed` / `suspicious_instructions` / `unknown_supplier` →
  approve re-runs the ingest with the decision (suspicious → every line to review);
  `extraction_failed` → the run goes back to be classified/extracted (no AI call from
  the review itself); reject → run `rejected`.
- Every resolution writes an `AuditLog` row. Service now (`review.service.ts`); panel
  routes in phase 9 (`GET /api/v1/reviews`, `POST /api/v1/reviews/:id/approve|reject`,
  JWT; proposal: operators resolve lines, admins resolve gates and global changes).

## Reason

- The panel (phase 9) needs to list, filter and resolve decisions one by one with
  concurrency safety: a JSON blob inside the run cannot give that.
- A pure planner makes every business rule unit-testable without a database, and the
  same code path serves the ingest and the approvals.
- Keeping unavailability, global percentages and tax-basis changes human-only avoids the
  most expensive mistakes (hiding products, re-pricing the whole catalog, false +22 %).

## Consequences

- New migration `catalog_ingest` (enums, `review_items`, supplier normalized name and tax
  basis, `Product.priceSourceAt`, `PriceChange.source/reviewItemId`, partial unique index
  written by hand — keep it when editing `PriceChange`).
- Until admin auth (phase 8) resolutions are made by `system` actors (tests / CLI).
- Review items have no expiry yet; stale ones are caught at approval time.
