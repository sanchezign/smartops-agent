import type { Formatter } from "@/lib/format";
import type { GlobalChangeProposal, LineProposal, ReviewItem, ReviewKind } from "./types";

/**
 * Every review as a plain question (phase 15 M3, ADR-032): what is asked, with the proposed answer
 * in it when there is one ("Update Coarse sand to $41.50?"). Returns a "reviews.questions" key and
 * its already formatted params; a "…Plain" variant when the item lacks the data for the full one.
 * Pure — unit tested.
 */

export type QuestionKey =
  | ReviewKind
  | "price_outlierPlain"
  | "currency_changedPlain"
  | "product_matchPlain"
  | "possible_duplicatePlain"
  | "global_changePlain"
  | "column_mappingPlain";

export interface Question {
  key: QuestionKey;
  params: Record<string, string | number>;
}

type Item = Pick<ReviewItem, "scope" | "kind" | "proposal" | "product" | "message">;

export function reviewQuestion(item: Item, format: Formatter): Question {
  const lineProposal = (
    item.scope === "line" ? item.proposal : null
  ) as Partial<LineProposal> | null;
  const line = lineProposal?.item?.name ?? item.product?.name ?? "";
  const product = item.product?.name ?? lineProposal?.candidates?.[0]?.name ?? null;
  const proposed = lineProposal?.proposedPrice ?? null;
  const proposedCurrency = lineProposal?.currency ?? item.product?.currency ?? null;
  const money = (amount: string | null, currency: string | null) =>
    amount !== null && currency ? format.formatMoney(amount, currency) : null;
  const current = item.product ? money(item.product.price, item.product.currency) : null;
  const price = money(proposed, proposedCurrency);

  switch (item.kind) {
    case "price_outlier":
      return product && price
        ? { key: "price_outlier", params: { product, price } }
        : { key: "price_outlierPlain", params: { line } };
    case "currency_changed":
      return product && price && current
        ? { key: "currency_changed", params: { product, price, current } }
        : { key: "currency_changedPlain", params: { line } };
    case "product_match":
      return product
        ? { key: "product_match", params: { line, product } }
        : { key: "product_matchPlain", params: { line } };
    case "possible_duplicate":
      return product
        ? { key: "possible_duplicate", params: { line, product } }
        : { key: "possible_duplicatePlain", params: { line } };
    case "stale_source":
    case "uncertain_value":
    case "missing_currency":
    case "new_or_existing":
    case "match_conflict":
    case "pct_without_match":
      return { key: item.kind, params: { line } };
    case "mark_unavailable":
      return { key: "mark_unavailable", params: { product: product ?? line } };
    case "global_change": {
      const proposal = (item.proposal ?? {}) as Partial<GlobalChangeProposal>;
      const count = proposal.products?.length ?? 0;
      return proposal.pct
        ? { key: "global_change", params: { pct: format.formatPct(proposal.pct), count } }
        : { key: "global_changePlain", params: { count } };
    }
    case "column_mapping": {
      const file = item.message.media?.filename ?? null;
      return file
        ? { key: "column_mapping", params: { file } }
        : { key: "column_mappingPlain", params: {} };
    }
    default:
      // run gates: tax_basis_changed, suspicious_instructions, unknown_supplier, extraction_failed
      return { key: item.kind, params: {} };
  }
}
