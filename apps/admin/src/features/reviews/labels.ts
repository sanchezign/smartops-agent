import type { ReviewItem } from "./types";

/**
 * Review queue texts (phase 9 M2). Since phase 13 the words live in the message catalogs
 * ("reviews.scopes", "reviews.kinds", "reviews.help", "reviews.reasons"); this module only knows
 * which codes exist and builds the list title from the item.
 */

export const REVIEW_REASONS = [
  "price_outlier",
  "currency_changed",
  "missing_currency",
  "invalid_result",
  "stale_source",
  "pct_without_match",
  "uncertain_value",
  "product_match",
  "possible_duplicate",
  "new_or_existing",
  "match_conflict",
  "duplicate_line",
  "auto_create_disabled",
  "stated_unavailable_new",
  "suspicious_source",
  "document_incomplete",
  "column_mapping_required",
  "sheet_format_changed",
  "suspicious_instructions",
  "missing_from_full_list",
  "stated_unavailable",
  "global_change",
  "tax_basis_changed",
  "unknown_supplier",
  "ambiguous_supplier_name",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export function isKnownReason(reason: string): reason is ReviewReason {
  return (REVIEW_REASONS as readonly string[]).includes(reason);
}

/** An unknown reason code, readable as it is ("some_new_code" → "some new code"). */
export const rawReason = (reason: string) => reason.replaceAll("_", " ");

/** The words the title needs, in the panel language (the component passes them in). */
export interface ReviewTitleText {
  line: string;
  product: string;
  message: string;
  /** pct already formatted, or null when the proposal has none. */
  globalChange(pct: string | null, count: number): string;
}

/** Short description of the item for the list (what, not why). */
export function reviewTitle(item: ReviewItem, text: ReviewTitleText): string {
  const proposal = (item.proposal ?? {}) as Record<string, unknown>;
  if (item.scope === "line") {
    const line = proposal.item as { name?: string } | undefined;
    return line?.name ?? item.product?.name ?? text.line;
  }
  if (item.kind === "mark_unavailable") return item.product?.name ?? text.product;
  if (item.kind === "global_change") {
    const pct = proposal.pct as string | undefined;
    const count = (proposal.products as unknown[] | undefined)?.length ?? 0;
    return text.globalChange(pct ?? null, count);
  }
  if (item.message.media?.filename) return item.message.media.filename;
  return item.message.text ?? item.message.transcript ?? text.message;
}
