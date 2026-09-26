/** Review queue as the panel API returns it (GET /admin/reviews, phase 9 M2). */

export type ReviewScope = "run" | "line" | "catalog";
export type ReviewStatus = "pending" | "approved" | "rejected" | "superseded";
export type ReviewKind =
  | "product_match"
  | "new_or_existing"
  | "possible_duplicate"
  | "match_conflict"
  | "uncertain_value"
  | "pct_without_match"
  | "missing_currency"
  | "currency_changed"
  | "price_outlier"
  | "stale_source"
  | "mark_unavailable"
  | "global_change"
  | "tax_basis_changed"
  | "suspicious_instructions"
  | "unknown_supplier"
  | "extraction_failed"
  | "column_mapping";

export interface ReviewItem {
  id: string;
  scope: ReviewScope;
  kind: ReviewKind;
  status: ReviewStatus;
  reasons: string[];
  proposal: unknown;
  resolution: unknown;
  resolvedAt: string | null;
  createdAt: string;
  supplier: { id: string; name: string } | null;
  product: { id: string; name: string; price: string; currency: string } | null;
  run: { id: string; status: string };
  message: {
    id: string;
    conversationId: string;
    type: string;
    text: string | null;
    transcript: string | null;
    receivedAt: string;
    media: { filename: string | null; mimeType: string } | null;
  };
}

export interface ReviewSummary {
  total: number;
  byScope: Record<ReviewScope, number>;
}

export interface LineProposal {
  lineIndex: number;
  item: {
    name: string;
    sku: string | null;
    unit: string | null;
    price: string | null;
    priceChangePct: string | null;
    currency: string | null;
    available: boolean | null;
    stock: number | null;
  };
  listCurrency: string | null;
  messageAt: string;
  candidates: { id: string; name: string | null; price: string | null; currency: string | null }[];
  proposedPrice: string | null;
  currency: string | null;
  changePct: string | null;
}

export interface GlobalChangeProposal {
  pct: string;
  messageAt: string;
  products: {
    productId: string;
    name: string;
    oldPrice: string;
    newPrice: string;
    currency: string;
    changePct: string | null;
    outlier: boolean;
  }[];
}

export interface MarkUnavailableProposal {
  reason: "missing_from_full_list" | "stated_unavailable";
  lineIndex: number | null;
}

export interface GateProposal {
  task?: string;
  reason?: string;
  detail?: string | null;
  supplierName?: string | null;
  candidates?: { id: string; name: string }[];
  previous?: boolean | null;
  current?: boolean | null;
}

export interface PriceColumn {
  column: number;
  header: string;
  taxIncluded: boolean | null;
  kind: "list" | "wholesale" | "cash" | "card" | "cost" | "other";
}

export interface TableProposal {
  table: string;
  sheet: string;
  isPriceTable: boolean;
  headerRow: number;
  fingerprint: string | null;
  headerCells: string[];
  mapping: {
    nameColumn: number;
    priceColumn: number | null;
    pctColumn: number | null;
    unitColumn: number | null;
    skuColumn: number | null;
    priceFormat: "decimal_comma" | "decimal_dot";
    currency: string | null;
    taxIncluded: boolean | null;
    priceColumns: PriceColumn[];
  };
  ambiguous: boolean;
  recommendedPriceColumn: number | null;
  confidence: "high" | "medium" | "low";
  remembered: boolean;
  preview: { name: string; prices: Record<string, string | null> }[];
}

export interface ColumnMappingProposal {
  reason: "new_format" | "format_changed";
  supplierName: string | null;
  suspiciousInstructions: boolean;
  warnings: string[];
  tables: TableProposal[];
}

export interface ApproveInput {
  productId?: string;
  createNew?: boolean;
  price?: string;
  currency?: string;
  name?: string;
  unit?: string;
  supplierId?: string;
  createSupplier?: string;
  note?: string;
  tables?: { table: string; priceColumn?: number; isPriceTable?: boolean }[];
}
