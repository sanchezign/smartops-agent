import type { LineProposal, ReviewItem } from "./types";

/**
 * One-click decisions from the To do list (phase 15 M3, ADR-032 §3). Only where approving with an
 * EMPTY body does exactly what the row shows, with nothing to choose:
 * - price_outlier / currency_changed: a linked product AND a proposed price (approving a line
 *   without a product creates a new one — never from one click), and no other reason on the
 *   line (a second reason, e.g. stale_source or uncertain_value, means look at the detail);
 *   currency_changed also needs an absolute price (a percentage is applied in the product's
 *   own currency) and shows both currencies;
 * - mark_unavailable (scope catalog, admins in practice): mark it / keep it.
 * Everything else — stale_source included — is decided in the detail. Pure; `canResolve` is the
 * caller's (permissions.ts), so a row never offers a button that answers 403.
 */

export interface Money {
  amount: string;
  currency: string;
}

export type QuickDecision =
  | { kind: "price"; product: string; current: Money; proposed: Money }
  | { kind: "currency"; product: string; current: Money; proposed: Money }
  | { kind: "unavailable"; product: string };

const only = (reasons: readonly string[], allowed: readonly string[]) =>
  reasons.length > 0 && reasons.every((r) => allowed.includes(r));

export function quickDecision(
  item: Pick<ReviewItem, "scope" | "kind" | "status" | "reasons" | "proposal" | "product">,
  options: { canResolve: boolean },
): QuickDecision | null {
  if (!options.canResolve || item.status !== "pending" || !item.product) return null;
  const product = item.product;
  const current = { amount: product.price, currency: product.currency };

  if (item.scope === "catalog" && item.kind === "mark_unavailable") {
    return only(item.reasons, ["missing_from_full_list", "stated_unavailable"])
      ? { kind: "unavailable", product: product.name }
      : null;
  }
  if (item.scope !== "line") return null;
  const proposal = item.proposal as Partial<LineProposal> | null;
  const proposedPrice = proposal?.proposedPrice ?? null;
  if (!proposal || proposedPrice === null) return null;

  if (item.kind === "price_outlier" && only(item.reasons, ["price_outlier"])) {
    const currency = proposal.currency ?? product.currency;
    if (currency !== product.currency) return null; // that would be currency_changed
    return {
      kind: "price",
      product: product.name,
      current,
      proposed: { amount: proposedPrice, currency },
    };
  }
  if (item.kind === "currency_changed" && only(item.reasons, ["currency_changed"])) {
    const currency = proposal.currency ?? null;
    if (!currency || currency === product.currency) return null;
    if (proposal.item?.priceChangePct != null) return null;
    return {
      kind: "currency",
      product: product.name,
      current,
      proposed: { amount: proposedPrice, currency },
    };
  }
  return null;
}
