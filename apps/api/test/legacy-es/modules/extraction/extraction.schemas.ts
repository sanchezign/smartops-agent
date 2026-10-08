/* FROZEN COPY of apps/api/src/modules/extraction/extraction.schemas.ts as of commit c4d2f42 (phase 14 M5b, BEFORE the heuristics got a language).
 * It is the reference of what the Spanish behavior WAS: test/unit/heuristics-es-identical.test.ts compares
 * today's code, with the language set to "es", against it. Never edit it. */
import { z } from "zod";
import { missingAttributes } from "../catalog/attributes.js";

/**
 * Output contracts of the classifier and the extractor (ADR-011).
 * - `*JsonSchema` goes to Claude's structured outputs: shape only (the API does not
 *   support minimum/maximum/length/pattern constraints).
 * - `*Schema` (Zod) is the authoritative validation applied to EVERY output, real or
 *   fake, before anything touches the catalog.
 */

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });

// ─── Classification ─────────────────────────────────────────────────────────

export const CLASSIFICATIONS = [
  "price_list_full",
  "price_update_partial",
  "customer_query",
  "internal_order",
  "other",
] as const;

export const classificationJsonSchema = {
  type: "object",
  properties: {
    classification: { type: "string", enum: [...CLASSIFICATIONS] },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["classification", "confidence", "reason"],
  additionalProperties: false,
} as const;

export const classificationSchema = z.object({
  classification: z.enum(CLASSIFICATIONS),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().min(1).max(300),
});
export type ClassificationOutput = z.infer<typeof classificationSchema>;

// ─── Extraction ─────────────────────────────────────────────────────────────

export const MATCH_CONFIDENCES = ["high", "medium", "low"] as const;

export const extractionJsonSchema = {
  type: "object",
  properties: {
    isPriceList: { type: "boolean" },
    listKind: { type: "string", enum: ["full_list", "partial_update"] },
    fullListEvidence: nullable({ type: "string" }),
    supplierName: nullable({ type: "string" }),
    currency: nullable({ type: "string" }),
    validFrom: nullable({ type: "string", format: "date" }),
    taxIncluded: nullable({ type: "boolean" }),
    globalChangePct: nullable({ type: "string" }),
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          sku: nullable({ type: "string" }),
          unit: nullable({ type: "string" }),
          price: nullable({ type: "string" }),
          priceChangePct: nullable({ type: "string" }),
          currency: nullable({ type: "string" }),
          available: nullable({ type: "boolean" }),
          stock: nullable({ type: "integer" }),
          catalogRef: nullable({ type: "string" }),
          matchConfidence: { type: "string", enum: [...MATCH_CONFIDENCES] },
          uncertain: { type: "boolean" },
          note: nullable({ type: "string" }),
        },
        required: [
          "name",
          "sku",
          "unit",
          "price",
          "priceChangePct",
          "currency",
          "available",
          "stock",
          "catalogRef",
          "matchConfidence",
          "uncertain",
          "note",
        ],
        additionalProperties: false,
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    suspiciousInstructions: { type: "boolean" },
  },
  required: [
    "isPriceList",
    "listKind",
    "fullListEvidence",
    "supplierName",
    "currency",
    "validFrom",
    "taxIncluded",
    "globalChangePct",
    "items",
    "warnings",
    "suspiciousInstructions",
  ],
  additionalProperties: false,
} as const;

/** Plain decimal, dot separator, up to 4 decimals (Decimal(18,4)), strictly positive. */
export const priceString = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, "price must be a plain decimal like 1850 or 12.5")
  .refine((v) => Number(v) > 0, { message: "price must be greater than 0" });

/**
 * Signed percentage change as a plain decimal ("10" = +10 %, "-5" = -5 %), up to 2 decimals.
 * Never 0 and never ≤ -100 (the resulting price must stay positive). Outlier limits are
 * catalog rules (M4), not part of the output contract.
 */
const pctString = z
  .string()
  .trim()
  .regex(/^-?\d{1,3}(\.\d{1,2})?$/, "percentage must be a plain signed decimal like 10 or -5.5")
  .refine((v) => Number(v) !== 0, { message: "percentage must not be 0" })
  .refine((v) => Number(v) > -100, { message: "percentage must be greater than -100" });

export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code like UYU");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

export const extractedItemSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    sku: optionalText(80),
    unit: optionalText(40),
    /** New absolute price; null when the line states a percentage change instead. */
    price: priceString.nullable(),
    /** Percentage change stated by the sender ("sube 10%"); applied by the catalog (M4). */
    priceChangePct: pctString.nullable(),
    currency: currencyCode.nullable(),
    available: z.boolean().nullable(),
    stock: z.number().int().min(0).max(1_000_000_000).nullable(),
    catalogRef: z
      .string()
      .regex(/^P\d{1,4}$/, 'catalogRef must look like "P12"')
      .nullable(),
    matchConfidence: z.enum(MATCH_CONFIDENCES),
    uncertain: z.boolean(),
    note: optionalText(300),
  })
  .refine((item) => (item.price === null) !== (item.priceChangePct === null), {
    message: "exactly one of price or priceChangePct must be set",
    path: ["price"],
  });

export const extractionSchema = z.object({
  isPriceList: z.boolean(),
  listKind: z.enum(["full_list", "partial_update"]),
  fullListEvidence: optionalText(300),
  supplierName: optionalText(200),
  currency: currencyCode.nullable(),
  validFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /** List-level tax statement: true "IVA incluido", false "+ IVA", null not stated/mixed. */
  taxIncluded: z.boolean().nullable(),
  /** Percentage for ALL the supplier's products ("todo +8%"); explicit items override it. */
  globalChangePct: pctString.nullable(),
  items: z.array(extractedItemSchema).max(500),
  warnings: z.array(z.string().trim().max(300)).max(30),
  suspiciousInstructions: z.boolean(),
});
export type ExtractionOutput = z.infer<typeof extractionSchema>;

/**
 * Same contract for the deterministic spreadsheet path (phase 5 M3c): rows are read by
 * code, not generated by the LLM, so the item cap follows the conversion limits
 * (10 sheets × 2,000 rows) instead of the 500 of an LLM output.
 */
export const deterministicExtractionSchema = extractionSchema.extend({
  items: z.array(extractedItemSchema).max(20_000),
});
export type ExtractedItem = z.infer<typeof extractedItemSchema>;

/**
 * Business rules applied after validation (pure):
 * - full_list only with explicit evidence quoted from the document; otherwise it is
 *   downgraded to partial_update (a full list can mark products unavailable).
 * - catalogRef must exist in the catalog sent; unknown refs become "unmatched, low".
 * - two items can never claim the same catalogRef: both drop to "medium" (review).
 * - a "high" match whose line does not state a distinguishing attribute of the catalog
 *   product (size, measure, capacity: "Arandela" vs "Arandela 6mm") drops to "medium".
 * - empty catalog (the supplier has no products yet) → every item is a new product:
 *   catalogRef=null, matchConfidence="high", regardless of the model's answer.
 * - not a price list → no items and no global percentage.
 * `catalog` maps each catalogRef sent to the model to its product name.
 */
export function applyExtractionRules(
  output: ExtractionOutput,
  catalog: ReadonlyMap<string, string>,
): ExtractionOutput {
  const warnings = [...output.warnings];
  let listKind = output.listKind;
  if (listKind === "full_list" && !output.fullListEvidence) {
    listKind = "partial_update";
    warnings.push(
      "Se indicó lista completa sin evidencia explícita en el documento: se trata como actualización parcial.",
    );
  }

  const refCounts = new Map<string, number>();
  for (const item of output.items) {
    if (item.catalogRef) refCounts.set(item.catalogRef, (refCounts.get(item.catalogRef) ?? 0) + 1);
  }
  const items = (output.isPriceList ? output.items : []).map((item) => {
    // Nothing to match against: every line is a new product, whatever the model said.
    if (catalog.size === 0) return { ...item, catalogRef: null, matchConfidence: "high" as const };
    const catalogName = item.catalogRef ? catalog.get(item.catalogRef) : undefined;
    if (item.catalogRef && catalogName === undefined) {
      warnings.push(
        `"${item.name}": referencia de catálogo desconocida (${item.catalogRef}), se ignora.`,
      );
      return { ...item, catalogRef: null, matchConfidence: "low" as const };
    }
    if (item.catalogRef && (refCounts.get(item.catalogRef) ?? 0) > 1) {
      return {
        ...item,
        matchConfidence: "medium" as const,
        note: item.note ?? "Varias líneas apuntan al mismo producto del catálogo.",
      };
    }
    if (catalogName !== undefined && item.matchConfidence === "high") {
      const missing = missingAttributes(catalogName, [item.name, item.unit].join(" "));
      if (missing.length > 0) {
        const reason =
          `"${item.name}" no indica ${missing.join(", ")} de "${catalogName}": requiere revisión.`.slice(
            0,
            300,
          );
        warnings.push(reason);
        return { ...item, matchConfidence: "medium" as const, note: item.note ?? reason };
      }
    }
    return item;
  });

  return {
    ...output,
    listKind,
    fullListEvidence: listKind === "full_list" ? output.fullListEvidence : null,
    globalChangePct: output.isPriceList ? output.globalChangePct : null,
    items,
    warnings: warnings.slice(0, 30),
  };
}
