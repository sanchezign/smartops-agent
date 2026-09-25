import { z } from "zod";

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
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          sku: nullable({ type: "string" }),
          unit: nullable({ type: "string" }),
          price: { type: "string" },
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
    "items",
    "warnings",
    "suspiciousInstructions",
  ],
  additionalProperties: false,
} as const;

/** Plain decimal, dot separator, up to 4 decimals (Decimal(18,4)), strictly positive. */
const priceString = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, "price must be a plain decimal like 1850 or 12.5")
  .refine((v) => Number(v) > 0, { message: "price must be greater than 0" });

const currencyCode = z
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

export const extractedItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sku: optionalText(80),
  unit: optionalText(40),
  price: priceString,
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
  items: z.array(extractedItemSchema).max(500),
  warnings: z.array(z.string().trim().max(300)).max(30),
  suspiciousInstructions: z.boolean(),
});
export type ExtractionOutput = z.infer<typeof extractionSchema>;
export type ExtractedItem = z.infer<typeof extractedItemSchema>;

/**
 * Business rules applied after validation (pure):
 * - full_list only with explicit evidence quoted from the document; otherwise it is
 *   downgraded to partial_update (a full list can mark products unavailable).
 * - catalogRef must exist in the catalog sent; unknown refs become "unmatched, low".
 * - two items can never claim the same catalogRef: both drop to "medium" (review).
 * - not a price list → no items.
 */
export function applyExtractionRules(
  output: ExtractionOutput,
  knownRefs: ReadonlySet<string>,
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
    if (item.catalogRef && !knownRefs.has(item.catalogRef)) {
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
    return item;
  });

  return {
    ...output,
    listKind,
    fullListEvidence: listKind === "full_list" ? output.fullListEvidence : null,
    items,
    warnings: warnings.slice(0, 30),
  };
}
