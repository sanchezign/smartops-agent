/** Catalog, price history and alerts as the panel API returns them (phase 9 M5). */

export interface CatalogSupplier {
  id: string;
  name: string;
  taxIncluded: boolean | null;
  products: number;
  available: number;
  lastListAt: string | null;
}

export interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  price: string;
  currency: string;
  available: boolean;
  stock: number | null;
  priceSourceAt: string | null;
  supplier: { id: string; name: string };
  lastChange: { changePct: string | null; currencyChanged: boolean; createdAt: string } | null;
}

export interface PriceHistoryEntry {
  id: string;
  oldPrice: string | null;
  oldCurrency: string | null;
  newPrice: string;
  newCurrency: string;
  changePct: string | null;
  currencyChanged: boolean;
  source: "auto" | "review";
  createdAt: string;
  conversationId: string | null;
}

export interface ProductDetail extends Omit<ProductRow, "lastChange" | "supplier"> {
  createdAt: string;
  supplier: { id: string; name: string; taxIncluded: boolean | null };
  history: PriceHistoryEntry[];
}

export type Availability = "all" | "available" | "unavailable";

export interface AlertItem {
  id: string;
  type:
    | "price_change"
    | "low_stock"
    | "missing_data"
    | "ingestion_error"
    | "manual_attention"
    | "integration_error"
    | "possible_opt_out";
  severity: "info" | "warning" | "critical";
  status: "open" | "sent" | "acknowledged" | "dismissed";
  title: string;
  createdAt: string;
  product: { id: string; name: string } | null;
  conversationId: string | null;
}
