import type { ProductDetail } from "./types";

/**
 * Chart points in the product's CURRENT currency (a currency change is shown in the list, not
 * mixed into the line), plus "now" so the last step reaches today. Numbers are display-only.
 */
export function chartPoints(
  product: Pick<ProductDetail, "price" | "currency" | "history">,
  now = Date.now(),
) {
  const points = product.history
    .filter((h) => h.newCurrency === product.currency)
    .map((h) => ({ at: new Date(h.createdAt).getTime(), price: Number(h.newPrice) }));
  if (points.length > 0) points.push({ at: now, price: Number(product.price) });
  return points;
}
