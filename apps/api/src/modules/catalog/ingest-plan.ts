import { Prisma } from "../../generated/prisma/client.js";
import type { ExtractedItem, ExtractionOutput } from "../extraction/extraction.schemas.js";
import type { CatalogSettings } from "../settings/settings.schemas.js";
import { normalizeProductName } from "./normalize.js";
import { computePriceChange } from "./price-change.js";
import { applyPercentage } from "./price-math.js";

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

/**
 * Catalog ingestion planner (pure, phase 5 M4). Decides — without touching the DB — what
 * an extraction does to the supplier's CURRENT catalog: which products are created,
 * updated or left unchanged, and which decisions need a human (review items).
 * The repository applies the plan inside one transaction (catalog.repository.ts).
 *
 * Product resolution per line (in order):
 *   empty catalog → new product
 *   exact normalized-name match (model pointing elsewhere → match_conflict)
 *   model catalogRef with "high" → that product
 *   model catalogRef with medium/low → product_match (review)
 *   no ref + "high" → new product (catalog truncated for the model → possible_duplicate)
 *   no ref + medium/low → new_or_existing (review)
 * Then price rules: percentage (Decimal), currency, outliers, stale source, uncertainty.
 * List rules: full_list → "unavailable" candidates (never applied), globalChangePct →
 * always review, tax basis change → the whole run is gated.
 */

export const REVIEW_KINDS = [
  "product_match",
  "new_or_existing",
  "possible_duplicate",
  "match_conflict",
  "uncertain_value",
  "pct_without_match",
  "missing_currency",
  "currency_changed",
  "price_outlier",
  "stale_source",
  "mark_unavailable",
  "global_change",
  "tax_basis_changed",
  "suspicious_instructions",
  "unknown_supplier",
  "extraction_failed",
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export type LineReason =
  | "match_conflict"
  | "duplicate_line"
  | "product_match"
  | "possible_duplicate"
  | "new_or_existing"
  | "auto_create_disabled"
  | "pct_without_match"
  | "missing_currency"
  | "currency_changed"
  | "stale_source"
  | "price_outlier"
  | "invalid_result"
  | "uncertain_value"
  | "stated_unavailable_new"
  | "suspicious_source"
  | "document_incomplete";

/** Primary review kind of a line = kind of its highest-priority reason. */
const KIND_BY_REASON: ReadonlyArray<readonly [LineReason, ReviewKind]> = [
  ["match_conflict", "match_conflict"],
  ["duplicate_line", "match_conflict"],
  ["product_match", "product_match"],
  ["possible_duplicate", "possible_duplicate"],
  ["new_or_existing", "new_or_existing"],
  ["auto_create_disabled", "new_or_existing"],
  ["pct_without_match", "pct_without_match"],
  ["missing_currency", "missing_currency"],
  ["currency_changed", "currency_changed"],
  ["stale_source", "stale_source"],
  ["price_outlier", "price_outlier"],
  ["invalid_result", "price_outlier"],
  ["uncertain_value", "uncertain_value"],
  ["stated_unavailable_new", "uncertain_value"],
  ["suspicious_source", "uncertain_value"],
  ["document_incomplete", "uncertain_value"],
];

export function primaryKind(reasons: readonly LineReason[]): ReviewKind | null {
  for (const [reason, kind] of KIND_BY_REASON) if (reasons.includes(reason)) return kind;
  return null;
}

export interface CatalogProductState {
  id: string;
  name: string;
  normalizedName: string;
  unit: string | null;
  price: Decimal;
  currency: string;
  available: boolean;
  stock: number | null;
  /** Timestamp of the message that set the current price (null = unknown). */
  priceSourceAt: Date | null;
}

export interface PlanInput {
  /** Validated extraction, after applyExtractionRules (M2). */
  output: ExtractionOutput;
  /** catalogRef → product id, as sent to the model at extraction time. */
  refs: Record<string, string>;
  /** The model saw only part of the catalog (MAX_CATALOG_PRODUCTS). */
  catalogTruncated: boolean;
  /** The supplier's catalog NOW (it may have changed since the extraction). */
  catalog: CatalogProductState[];
  settings: CatalogSettings;
  /** Last tax basis stated by this supplier (null = never stated). */
  supplierTaxIncluded: boolean | null;
  /** WhatsApp timestamp of the source message. */
  messageAt: Date;
  overrides?: {
    /** A human approved the tax basis change of this run. */
    acceptTaxChange?: boolean;
    /** A human approved a run with suspicious instructions: nothing is automatic. */
    forceReview?: boolean;
    /** The converted document may have missing values (formula without value). */
    documentIncomplete?: boolean;
  };
}

export type LineAction = "create" | "update" | "unchanged" | "review";

export interface PlannedLine {
  index: number;
  item: ExtractedItem;
  action: LineAction;
  /** Target product (update/unchanged), or the best candidate of a review line. */
  productId: string | null;
  /** Candidate products for a human (review lines). */
  candidateIds: string[];
  kind: ReviewKind | null;
  reasons: LineReason[];
  currency: string | null;
  oldPrice: Decimal | null;
  oldCurrency: string | null;
  newPrice: Decimal | null;
  changePct: Decimal | null;
  /** Stock to store (null = leave as is). */
  stock: number | null;
  reactivate: boolean;
  priceAlert: boolean;
  lowStock: boolean;
}

export interface CatalogReview {
  kind: "mark_unavailable";
  productId: string;
  reason: "missing_from_full_list" | "stated_unavailable";
  lineIndex: number | null;
}

export interface GlobalChangeProduct {
  productId: string;
  name: string;
  oldPrice: Decimal;
  newPrice: Decimal;
  currency: string;
  changePct: Decimal | null;
  outlier: boolean;
}

export interface GlobalChangePlan {
  pct: string;
  products: GlobalChangeProduct[];
}

export type WarningCode =
  | "currency_assumed"
  | "product_reactivated"
  | "tax_not_stated"
  | "tax_change_accepted"
  | "not_a_price_list";

export interface PlanWarning {
  code: WarningCode;
  message: string;
  lineIndex?: number;
}

export type IngestionPlan =
  | {
      gated: true;
      gate: { kind: "tax_basis_changed"; previous: boolean; current: boolean };
      warnings: PlanWarning[];
    }
  | {
      gated: false;
      lines: PlannedLine[];
      catalogReviews: CatalogReview[];
      globalChange: GlobalChangePlan | null;
      /** Tax basis to store on the supplier (null = leave as is). */
      taxIncluded: boolean | null;
      warnings: PlanWarning[];
    };

function isOutlier(changePct: Decimal | null, settings: CatalogSettings): boolean {
  if (!changePct) return false;
  return changePct.gt(settings.maxIncreasePct) || changePct.lt(-settings.maxDecreasePct);
}

export function planIngestion(input: PlanInput): IngestionPlan {
  const { output, settings } = input;
  const overrides = input.overrides ?? {};
  const warnings: PlanWarning[] = [];

  if (!output.isPriceList) {
    warnings.push({
      code: "not_a_price_list",
      message: "El contenido no es una lista de precios.",
    });
    return {
      gated: false,
      lines: [],
      catalogReviews: [],
      globalChange: null,
      taxIncluded: null,
      warnings,
    };
  }

  // ─── Tax basis (IVA) ───
  const previousTax = input.supplierTaxIncluded;
  const currentTax = output.taxIncluded;
  if (previousTax !== null && currentTax !== null && previousTax !== currentTax) {
    if (!overrides.acceptTaxChange) {
      return {
        gated: true,
        gate: { kind: "tax_basis_changed", previous: previousTax, current: currentTax },
        warnings: [],
      };
    }
    warnings.push({
      code: "tax_change_accepted",
      message: `Cambio de base de IVA aprobado (${previousTax ? "con" : "sin"} IVA → ${currentTax ? "con" : "sin"} IVA).`,
    });
  } else if (previousTax !== null && currentTax === null) {
    warnings.push({
      code: "tax_not_stated",
      message: `La lista no indica si incluye IVA; la anterior del proveedor ${previousTax ? "lo incluía" : "no lo incluía"}.`,
    });
  }

  // ─── Catalog indexes ───
  const byId = new Map(input.catalog.map((p) => [p.id, p]));
  const byNormalized = new Map(input.catalog.map((p) => [p.normalizedName, p]));
  const currencies = new Set(input.catalog.map((p) => p.currency));
  const singleCurrency = currencies.size === 1 ? [...currencies][0]! : null;
  const emptyCatalog = input.catalog.length === 0;

  // ─── Product resolution ───
  type Resolution =
    | { target: "existing"; product: CatalogProductState }
    | { target: "new" }
    | { target: "review"; reason: LineReason; candidates: CatalogProductState[] };

  const resolve = (item: ExtractedItem): Resolution => {
    if (emptyCatalog) return { target: "new" };
    const refId = item.catalogRef ? input.refs[item.catalogRef] : undefined;
    const modelProduct = refId ? byId.get(refId) : undefined;
    const exact = byNormalized.get(normalizeProductName(item.name));
    if (exact) {
      if (modelProduct && modelProduct.id !== exact.id) {
        return { target: "review", reason: "match_conflict", candidates: [exact, modelProduct] };
      }
      return { target: "existing", product: exact };
    }
    if (modelProduct) {
      return item.matchConfidence === "high"
        ? { target: "existing", product: modelProduct }
        : { target: "review", reason: "product_match", candidates: [modelProduct] };
    }
    if (item.catalogRef === null && item.matchConfidence === "high") {
      return input.catalogTruncated
        ? { target: "review", reason: "possible_duplicate", candidates: [] }
        : { target: "new" };
    }
    return { target: "review", reason: "new_or_existing", candidates: [] };
  };

  const resolutions = output.items.map(resolve);

  // Two lines on the same existing product, or two new lines with the same name.
  const claims = new Map<string, number>();
  const newNames = new Map<string, number>();
  resolutions.forEach((r, i) => {
    if (r.target === "existing") claims.set(r.product.id, (claims.get(r.product.id) ?? 0) + 1);
    if (r.target === "new") {
      const key = normalizeProductName(output.items[i]!.name);
      newNames.set(key, (newNames.get(key) ?? 0) + 1);
    }
  });

  const catalogReviews: CatalogReview[] = [];
  const lines: PlannedLine[] = output.items.map((item, index) => {
    const resolution = resolutions[index]!;
    const reasons: LineReason[] = [];
    const candidates =
      resolution.target === "existing"
        ? [resolution.product]
        : resolution.target === "review"
          ? resolution.candidates
          : [];
    if (resolution.target === "review") reasons.push(resolution.reason);
    if (resolution.target === "existing" && (claims.get(resolution.product.id) ?? 0) > 1)
      reasons.push("duplicate_line");
    if (resolution.target === "new" && (newNames.get(normalizeProductName(item.name)) ?? 0) > 1)
      reasons.push("duplicate_line");

    const pricingProduct = candidates[0] ?? null;
    let currency: string | null = null;
    let newPrice: Decimal | null = null;
    let changePct: Decimal | null = null;
    let reactivate = false;

    if (pricingProduct) {
      const p = pricingProduct;
      if (item.priceChangePct !== null) {
        currency = p.currency;
        newPrice = applyPercentage(p.price, item.priceChangePct);
      } else {
        newPrice = new Decimal(item.price!);
        currency = item.currency ?? output.currency;
        if (currency === null && singleCurrency === p.currency) {
          currency = p.currency;
          warnings.push({
            code: "currency_assumed",
            message: `"${item.name}": sin moneda; se asume ${p.currency} (todos los productos del proveedor están en esa moneda).`,
            lineIndex: index,
          });
        }
      }
      if (newPrice.lte(0)) reasons.push("invalid_result");
      if (currency === null) reasons.push("missing_currency");
      else if (currency !== p.currency) reasons.push("currency_changed");
      else {
        changePct = computePriceChange(
          { price: p.price, currency: p.currency },
          { price: newPrice, currency },
        ).changePct;
        if (isOutlier(changePct, settings)) reasons.push("price_outlier");
      }
      if (p.priceSourceAt && input.messageAt < p.priceSourceAt) reasons.push("stale_source");
      reactivate = !p.available && item.available !== false && settings.reactivateOnQuote;
      if (resolution.target === "existing" && item.available === false && p.available) {
        catalogReviews.push({
          kind: "mark_unavailable",
          productId: p.id,
          reason: "stated_unavailable",
          lineIndex: index,
        });
      }
    } else {
      // New product (or a review line without candidates).
      if (item.priceChangePct !== null) reasons.push("pct_without_match");
      else newPrice = new Decimal(item.price!);
      currency = item.currency ?? output.currency;
      if (currency === null) reasons.push("missing_currency");
      if (resolution.target === "new") {
        if (!settings.autoCreateProducts) reasons.push("auto_create_disabled");
        if (item.available === false) reasons.push("stated_unavailable_new");
      }
    }

    if (item.uncertain) reasons.push("uncertain_value");
    if (overrides.forceReview) reasons.push("suspicious_source");
    if (overrides.documentIncomplete) reasons.push("document_incomplete");

    const unique = [...new Set(reasons)];
    const existing = resolution.target === "existing" ? resolution.product : null;
    let action: LineAction;
    if (unique.length > 0) action = "review";
    else if (resolution.target === "new") action = "create";
    else if (existing && newPrice!.eq(existing.price) && currency === existing.currency)
      action = "unchanged";
    else action = "update";

    const applied = action !== "review";
    const stock = applied ? item.stock : null;
    if (applied && reactivate && existing) {
      warnings.push({
        code: "product_reactivated",
        message: `"${existing.name}" estaba no disponible y vuelve a cotizarse: se reactiva.`,
        lineIndex: index,
      });
    }

    return {
      index,
      item,
      action,
      productId: pricingProduct?.id ?? null,
      candidateIds: candidates.map((c) => c.id),
      kind: applied ? null : primaryKind(unique),
      reasons: unique,
      currency,
      oldPrice: pricingProduct?.price ?? null,
      oldCurrency: pricingProduct?.currency ?? null,
      newPrice,
      changePct,
      stock,
      reactivate: applied && reactivate,
      priceAlert:
        action === "update" && changePct !== null && changePct.abs().gte(settings.priceAlertPct),
      lowStock:
        applied &&
        stock !== null &&
        settings.lowStockThreshold !== null &&
        stock <= settings.lowStockThreshold,
    };
  });

  // Products this run talks about (resolved or candidate): never "missing".
  const referenced = new Set(lines.flatMap((l) => l.candidateIds));

  if (output.listKind === "full_list") {
    for (const p of input.catalog) {
      if (p.available && !referenced.has(p.id)) {
        catalogReviews.push({
          kind: "mark_unavailable",
          productId: p.id,
          reason: "missing_from_full_list",
          lineIndex: null,
        });
      }
    }
  }

  let globalChange: GlobalChangePlan | null = null;
  if (output.globalChangePct !== null) {
    globalChange = {
      pct: output.globalChangePct,
      products: input.catalog
        .filter((p) => p.available && !referenced.has(p.id))
        .map((p) => {
          const newPrice = applyPercentage(p.price, output.globalChangePct!);
          const { changePct } = computePriceChange(
            { price: p.price, currency: p.currency },
            { price: newPrice, currency: p.currency },
          );
          return {
            productId: p.id,
            name: p.name,
            oldPrice: p.price,
            newPrice,
            currency: p.currency,
            changePct,
            outlier: isOutlier(changePct, settings) || newPrice.lte(0),
          };
        }),
    };
  }

  return {
    gated: false,
    lines,
    catalogReviews,
    globalChange,
    taxIncluded: currentTax,
    warnings,
  };
}
