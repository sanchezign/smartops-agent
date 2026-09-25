import { normalizeProductName } from "../catalog/normalize.js";

/**
 * The supplier's current catalog as sent to the extractor for matching (pure).
 * Products get SHORT, STABLE references (P1…Pn, sorted by normalized name) instead of
 * database ids: the model cannot leak or invent real ids, prompts stay small, and the
 * same catalog always produces the same text (deterministic keys for golden outputs).
 * Format — keep stable (golden outputs depend on it):
 *   P<n> | <name> | <unit or -> | <price> <currency>
 */

export interface CatalogProduct {
  id: string;
  name: string;
  unit: string | null;
  /** Decimal as string (Prisma Decimal.toString()). */
  price: string;
  currency: string;
  available: boolean;
}

export interface CatalogContext {
  /** Block to send (null when the supplier has no products yet). */
  text: string | null;
  /** catalogRef → product id. */
  refs: Map<string, string>;
  /** normalized name → product id (exact matches, first wins). */
  byNormalizedName: Map<string, string>;
  truncated: boolean;
}

export const MAX_CATALOG_PRODUCTS = 300;

/** "12.0000" → "12", "12.5000" → "12.5" (stable textual form). */
export function formatDecimal(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

export function buildCatalogContext(products: CatalogProduct[]): CatalogContext {
  const sorted = [...products].sort((a, b) => {
    const na = normalizeProductName(a.name);
    const nb = normalizeProductName(b.name);
    return na === nb ? a.id.localeCompare(b.id) : na.localeCompare(nb);
  });
  const truncated = sorted.length > MAX_CATALOG_PRODUCTS;
  const included = sorted.slice(0, MAX_CATALOG_PRODUCTS);

  const refs = new Map<string, string>();
  const byNormalizedName = new Map<string, string>();
  const lines: string[] = [];
  included.forEach((product, index) => {
    const ref = `P${index + 1}`;
    refs.set(ref, product.id);
    const normalized = normalizeProductName(product.name);
    if (!byNormalizedName.has(normalized)) byNormalizedName.set(normalized, product.id);
    const unavailable = product.available ? "" : " | no disponible";
    lines.push(
      `${ref} | ${product.name} | ${product.unit ?? "-"} | ${formatDecimal(product.price)} ${product.currency}${unavailable}`,
    );
  });
  // Exact-name lookup also covers products beyond the prompt limit.
  for (const product of sorted.slice(MAX_CATALOG_PRODUCTS)) {
    const normalized = normalizeProductName(product.name);
    if (!byNormalizedName.has(normalized)) byNormalizedName.set(normalized, product.id);
  }

  return {
    text: lines.length > 0 ? lines.join("\n") : null,
    refs,
    byNormalizedName,
    truncated,
  };
}
